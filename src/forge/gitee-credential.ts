/**
 * The binding-scoped Gitee Git credential broker. A Git credential helper asks the running dsh-superagent process over a
 * Unix socket for the credential of one RepositoryBinding; the process keeps the token in memory and answers only for the
 * binding and repository the helper names, so no token enters a child environment, an argument, a log, SQLite, or a
 * generated credential file. The helper itself only carries the socket path and a non-secret binding reference.
 */
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import type { RepositoryBinding } from '../repository.ts'
import { sameName } from '../infra/text.ts'

/** Name of the executable Git invokes; it carries the socket path and no secret. */
export const GITEE_CREDENTIAL_HELPER = 'worker-gitee-credential-helper'
/** The Node program the executable starts. */
export const GITEE_CREDENTIAL_HELPER_CODE = `${GITEE_CREDENTIAL_HELPER}.cjs`
export const giteeCredentialHelperPath = (stateDir: string): string => join(stateDir, GITEE_CREDENTIAL_HELPER)
export const giteeCredentialSocket = (stateDir: string): string => join(stateDir, 'gitee-credential.sock')
const MAX_REQUEST = 8192
const REQUEST_TIMEOUT_MS = 5000
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** What the broker may answer for one binding: its account login and the token held by the host process. */
export interface GiteeCredentialSource { binding: RepositoryBinding; login: string; token: string }
/** Resolves a binding-scoped credential from the live deployment, or undefined when no enabled binding or token exists. */
export type GiteeCredentialLookup = (bindingId: string) => GiteeCredentialSource | undefined
export interface GiteeCredentialBrokerOptions { stateDir: string; lookup: GiteeCredentialLookup }
const RequestSchema = z.object({ binding: z.string().min(1), host: z.string().min(1), repository: z.string().min(1) }).strict()
type Request = z.infer<typeof RequestSchema>

/**
 * Serves `git credential` requests for Gitee bindings over a private Unix socket. It fails closed for an unmapped binding,
 * another provider, a different host or repository, a disabled binding, or a token the host does not hold, and it never
 * writes the token anywhere or includes it in an error.
 */
export class GiteeCredentialBroker {
  private server?: Server
  private readonly socketPath: string
  constructor(private readonly options: GiteeCredentialBrokerOptions) { this.socketPath = giteeCredentialSocket(options.stateDir) }
  /** Starts the socket server, replacing a stale socket left by an earlier process of the same state directory. */
  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    await rm(this.socketPath, { force: true })
    const server = createServer(socket => this.handle(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', listening); reject(error) }
      const listening = (): void => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', listening)
      server.listen(this.socketPath)
    }).catch(error => { server.close(); throw error })
    await chmod(this.socketPath, 0o600)
    server.unref()
  }
  /** Closes the socket and removes it; a later start re-creates it. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()) })
    await rm(this.socketPath, { force: true })
  }
  private handle(socket: Socket): void {
    socket.unref()
    let input = ''
    const finish = (): void => { socket.destroy() }
    const timer = setTimeout(finish, REQUEST_TIMEOUT_MS)
    timer.unref()
    const done = (answer: Record<string, string>): void => {
      clearTimeout(timer)
      socket.end(JSON.stringify(answer) + '\n')
    }
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      input += chunk
      if (input.length > MAX_REQUEST) { clearTimeout(timer); finish(); return }
      const end = input.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      done(this.answer(input.slice(0, end)))
    })
    socket.on('error', () => { clearTimeout(timer) })
  }
  private answer(line: string): Record<string, string> {
    let request: Request
    try { request = RequestSchema.parse(JSON.parse(line)) } catch { return { error: 'Invalid credential request' } }
    const source = this.options.lookup(request.binding)
    if (!source) return { error: 'No enabled Gitee repository binding has this credential' }
    if (source.binding.provider !== 'gitee' || !sameName(request.host, 'gitee.com')) return { error: 'The credential is not a Gitee credential' }
    const path = request.repository.replace(/^\/+/, '').replace(/\.git$/, '')
    if (!sameName(path, source.binding.slug)) return { error: 'The credential is outside this binding\'s repository' }
    return { username: source.login, password: source.token }
  }
}

/**
 * The Gitee credential helper Git invokes, as files that contain no secret: an executable that starts Node, and the
 * program that speaks Git's credential protocol and asks the broker. A request for any other host or repository fails
 * closed, and the token arrives only in the answer Git consumes.
 */
export function giteeCredentialHelperFiles(stateDir: string, node = process.execPath):
  { path: string; body: string; mode: number }[] {
  const socket = giteeCredentialSocket(stateDir)
  const code = join(stateDir, GITEE_CREDENTIAL_HELPER_CODE)
  const script = `#!/bin/sh
# Written by dsh-superagent on every start; edits are lost.
exec ${shellQuote(node)} ${shellQuote(code)} ${shellQuote(socket)} "$@"
`
  const program = `#!/usr/bin/env node
// # Written by dsh-superagent on every start; edits are lost.
const net = require('node:net')
const socketPath = process.argv[2]
// Git passes get, store, or erase; only a read asks the broker for a credential.
if ((process.argv[3] || 'get') !== 'get') process.exit(0)
function fail(message) {
  if (message) process.stderr.write('dsh-superagent: ' + message + '\\n')
  process.exit(1)
}
const binding = process.env.DSH_SUPERAGENT_REPOSITORY_ID || ''
const provider = process.env.DSH_SUPERAGENT_REPOSITORY_PROVIDER || ''
const repository = process.env.DSH_SUPERAGENT_REPOSITORY || ''
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { if (input.length < 8192) input += chunk })
process.stdin.on('end', () => {
  const fields = new Map()
  for (const line of input.split(/\\r?\\n/)) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1))
  }
  let repositoryPath = fields.get('path') || ''
  if (!repositoryPath) {
    try { repositoryPath = new URL(fields.get('url') || '').pathname } catch { repositoryPath = '' }
  }
  repositoryPath = repositoryPath.replace(/^\\/+/, '').replace(/\\.git$/, '')
  if (provider !== 'gitee' || !binding || !repository || !repositoryPath
    || repositoryPath.toLowerCase() !== repository.toLowerCase()
    || fields.get('host') !== 'gitee.com') fail('the Git credential request is outside this ticket\\'s Gitee repository')
  const socket = net.createConnection(socketPath)
  let answer = ''
  const timer = setTimeout(() => fail('the Gitee credential broker did not answer'), 5000)
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.end(JSON.stringify({ binding, host: 'gitee.com', repository: repositoryPath }) + '\\n'))
  socket.on('data', chunk => { answer += chunk })
  socket.on('end', () => {
    clearTimeout(timer)
    let reply
    try { reply = JSON.parse(answer) } catch { fail('the Gitee credential broker returned no credential') }
    if (!reply || !reply.username || !reply.password) fail(reply && reply.error ? reply.error : 'the Gitee credential broker returned no credential')
    process.stdout.write('username=' + reply.username + '\\npassword=' + reply.password + '\\n')
  })
  socket.on('error', () => { clearTimeout(timer); fail('the Gitee credential broker is unavailable') })
})
`
  return [{ path: code, body: program, mode: 0o644 }, { path: giteeCredentialHelperPath(stateDir), body: script, mode: 0o755 }]
}
