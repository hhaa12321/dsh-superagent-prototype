/** The Gitee end-to-end write path a worker follows: Issue -> Ticket -> push target -> PR create/claim -> result comment -> PR state. */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Candidate } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy, type Settings } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { giteeIssueTrigger, giteeKind, pollWhenEnabled } from '../src/sources/gitee.ts'
import { sendGitee } from '../src/sources/gitee-channel.ts'
import { giteeForgeAdapter } from '../src/forge/gitee.ts'
import { claimPull, type PullHost } from '../src/forge/pulls.ts'
import type { ForgePull } from '../src/forge/ports.ts'
import { GiteeCredentialBroker, giteeCredentialHelperFiles } from '../src/forge/gitee-credential.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { writeEnvironment } from '../src/infra/environment.ts'
import { executorTools, originIssueOf, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { ResourceHost } from '../src/app/resources.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { testCommands, testDeployment } from './fixtures/deployment.ts'

const token = 'gitee-e2e-secret-token'
const A: RepositoryBinding = { id: repositoryId('gitee', 51207621), provider: 'gitee', providerRepositoryId: '51207621',
  slug: 'bourneW/dsh-superagent-gitee-canary', webUrl: 'https://gitee.com/bourneW/dsh-superagent-gitee-canary', defaultBranch: 'master',
  credentialId: 'gitee:gitee-a', capabilities: giteeForgeAdapter.capabilities, enabled: true }
const B: RepositoryBinding = { ...A, id: repositoryId('gitee', 51207622), providerRepositoryId: '51207622', slug: 'bourneW/other-canary',
  webUrl: 'https://gitee.com/bourneW/other-canary', credentialId: 'gitee:gitee-b' }
const at = '2026-11-01T00:00:00.000Z'
const issue = (binding: RepositoryBinding, sourceId: string, nativeId: string, display: string) => giteeIssueTrigger({
  nativeId, displayNumber: display, threadId: nativeId, title: 'Fix the login', body: '@bourneW please fix the login',
  author: { providerUserId: 'u-alice', login: 'alice' }, createdAt: at, updatedAt: at, webUrl: `${binding.webUrl}/issues/${display}`, comments: 0,
}, 'bourneW', { sourceId, repositoryId: binding.id })

interface PullState { pull: ForgePull; comments: Record<string, unknown>[] }
interface GiteeState { pulls: Record<string, PullState[]>; issueComments: Record<string, Record<string, unknown>[]>; nextPull: number; nextComment: number }

/** A mutable fake Gitee API for one or two bindings, recording every request so a test can scan it. */
function fakeGitee() {
  const state: GiteeState = { pulls: { [A.slug]: [], [B.slug]: [] }, issueComments: { [A.slug]: [], [B.slug]: [] },
    nextPull: 700, nextComment: 9000 }
  const calls: { url: URL; method: string; body: string; authorization: string | null }[] = []
  const path = (url: URL): string => url.pathname.replace(/^\/api\/v5/, '')
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
  const apiPull = (pull: ForgePull) => ({ id: Number(pull.nativeId), number: Number(pull.displayNumber), title: pull.title, body: pull.body,
    state: pull.state, user: { id: Number(pull.author.providerUserId), login: pull.author.login }, created_at: pull.createdAt, updated_at: pull.updatedAt,
    ...pull.mergedAt ? { merged_at: pull.mergedAt } : {}, ...pull.closedAt ? { closed_at: pull.closedAt } : {}, html_url: pull.webUrl,
    head: { ref: pull.head.ref, sha: pull.head.sha, ...pull.head.repositoryId ? { repo: { id: Number(pull.head.repositoryId), full_name: pull.head.repositorySlug } } : {} },
    base: { ref: pull.base.ref, ...pull.base.repositoryId ? { repo: { id: Number(pull.base.repositoryId), full_name: pull.base.repositorySlug } } : {} } })
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: String(init?.body ?? ''), authorization: headers.get('authorization') })
    const address = path(url)
    const slug = /^\/repos\/([^/]+\/[^/]+)\//.exec(address)?.[1] ?? ''
    const pulls = state.pulls[slug] ?? []
    if (method === 'GET' && address.endsWith('/issues')) return json([])
    if (method === 'GET' && address.endsWith('/pulls')) return json(pulls.map(item => apiPull(item.pull)), 200, { total_page: '1' })
    const detail = /\/pulls\/([^/]+)$/.exec(address)
    if (method === 'GET' && detail) {
      const found = pulls.find(item => item.pull.displayNumber === detail[1])
      return found ? json(apiPull(found.pull)) : json({ message: 'Not Found' }, 404)
    }
    if (method === 'POST' && address.endsWith('/pulls')) {
      const form = new URLSearchParams(String(init?.body ?? ''))
      const number = state.nextPull++, nativeId = String(100000 + number)
      const owner = [A, B].find(item => item.slug === slug)!
      const pull: ForgePull = { nativeId, displayNumber: String(number), title: form.get('title') ?? '', body: form.get('body') ?? '', state: 'open',
        author: { providerUserId: '618074', login: 'bourneW' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        webUrl: `https://gitee.com/${slug}/pulls/${number}`, head: { ref: form.get('head') ?? '', sha: 'pushed', repositoryId: owner.providerRepositoryId,
          repositorySlug: slug }, base: { ref: form.get('base') ?? '', repositoryId: owner.providerRepositoryId, repositorySlug: slug } }
      pulls.push({ pull, comments: [] })
      return json(apiPull(pull), 201)
    }
    const commentPath = /\/issues\/([^/]+)\/comments$/.exec(address)
    if (commentPath) {
      const comments = state.issueComments[slug] ??= []
      if (method === 'GET') return json(comments, 200, { total_page: '1' })
      const form = new URLSearchParams(String(init?.body ?? ''))
      const comment = { id: state.nextComment++, body: form.get('body') ?? '', user: { id: 618074, login: 'bourneW' },
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: `https://gitee.com/${slug}/issues/${commentPath[1]}#note` }
      comments.push(comment)
      return json(comment, 201)
    }
    const review = /\/pulls\/([^/]+)\/comments$/.exec(address)
    if (review && method === 'GET') {
      const found = pulls.find(item => item.pull.displayNumber === review[1])
      return json(found?.comments ?? [], 200, { total_page: '1' })
    }
    return json({ message: 'Not Found' }, 404)
  })
  return { state, calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

interface Harness {
  directory: string
  path: string
  store: Store
  board: HealthBoard
  sources: SourceRegistry
  deployment: ReturnType<typeof testDeployment>
  engine: Engine
  candidates: Candidate[]
  starts: string[]
  stops: string[]
  settings: Settings
  bindings: RepositoryBinding[]
  ctx: (sourceId: string) => SourceContext
  ticket: (triggerId: string) => ReturnType<Store['tickets']['get']>
  close(cleanup?: boolean): void
}
const bindingsOf = (items: RepositoryBinding[]) => items
function harness(path?: string, bindings: RepositoryBinding[] = [A], evalMode: 'off' | 'auto' = 'off'): Harness {
  const directory = path ? path.slice(0, path.lastIndexOf('/')) : mkdtempSync(join(tmpdir(), 'gitee-execution-'))
  const database = path ?? join(directory, 'orchestrator.sqlite')
  const store = new Store(database)
  const settings = SettingsSchema.parse({ sources: Object.fromEntries(bindings.map((binding, index) => [`gitee-${index ? 'b' : 'a'}`, {
    kind: 'gitee', enabled: true, config: { repository: binding.slug, tokenEnv: 'GITEE_TOKEN', observeIssues: true, observeComments: true } }])),
    eval: { mode: evalMode }, policy: { sources: Object.fromEntries(bindings.map((_, index) => [`gitee-${index ? 'b' : 'a'}`, { allowed: [{ id: 'alice' }] }])) } })
  store.saveSettings(settings)
  store.atomic(() => {
    store.repositories.reconcile(bindings, bindings.map((binding, index) => ({ sourceId: `gitee-${index ? 'b' : 'a'}`, repositoryId: binding.id })))
  })
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board, undefined, sourceId => {
    const index = sourceId === 'gitee-a' ? 0 : sourceId === 'gitee-b' ? 1 : -1
    return bindings[index]
  })
  sources.register(giteeKind)
  const deployment = testDeployment({ stateDir: directory, github: undefined, credentials: {}, repositories: bindings,
    giteeCredentials: { [A.credentialId]: { tokenEnv: 'GITEE_TOKEN', login: 'bourneW', userId: '618074', commitEmail: 'bourneW@noreply.gitee.com' },
      [B.credentialId]: { tokenEnv: 'GITEE_TOKEN', login: 'bourneW', userId: '618074', commitEmail: 'bourneW@noreply.gitee.com' } } })
  const candidates: Candidate[] = [], starts: string[] = [], stops: string[] = []
  let closed = false
  const assessor: Assessor = { request: candidate => { candidates.push(candidate) } }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor,
    executor: { start: ticket => { starts.push(ticket.id) }, deliver: vi.fn(), stop: (_ticket, _assignment, reason) => { stops.push(reason) } },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    threadRepository: ref => sources.bindingOf(ref.source)?.id ?? ref.repositoryId ?? null, repositoryExists: id => !!store.repositories.get(id),
    executionAllowed: id => id === null ? true : store.repositories.get(id)?.capabilities.execution === true,
    emit: () => {},
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'fix-e2e', directory: `${directory}/work/${ticket.repositoryId}/fix-e2e`, assignment: '' } }) })
  const deps: SourceContextDeps = { store, engine, outbox: { send: vi.fn() }, commands: testCommands(() => deployment, {}, undefined, bindings[0]),
    sources, deployment, ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }
  return { directory, path: database, store, board, sources, deployment, engine, candidates, starts, stops, settings,
    bindings: bindingsOf(bindings), ctx: id => sourceContextOf(deps, giteeKind, id), ticket: id => store.tickets.get(id),
    close: (cleanup = true) => { if (!closed) { closed = true; store.close() }; if (cleanup) rmSync(directory, { recursive: true, force: true }) } }
}
/** Accept one human Gitee Issue and return its Ticket, as the main Session's accept would. */
function accept(h: Harness, binding: RepositoryBinding, sourceId = 'gitee-a', nativeId = '34904144', display = 'IKS47K') {
  const trigger = issue(binding, sourceId, nativeId, display)
  h.engine.receive(trigger)
  h.engine.evaluateDue()
  const candidate = h.candidates.at(-1)!
  const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix the login', scope: 'the login form', reason: 'asked',
    name: 'fix-e2e', evalId: candidate.evalId })
  return h.store.tickets.get(decision.ticketId!)!
}

describe('Gitee execution', () => {
  let h: Harness
  let gitee: ReturnType<typeof fakeGitee>
  beforeEach(() => { process.env.GITEE_TOKEN = token })
  afterEach(() => { h?.close(); vi.unstubAllGlobals(); delete process.env.GITEE_TOKEN })

  const toolHost = (harness: Harness, ticket: NonNullable<ReturnType<Harness['ticket']>>, sourceId = 'gitee-a'): ExecutorToolsHost => {
    const ctx = harness.ctx(sourceId)
    const binding = harness.bindings.find(item => item.id === ticket.repositoryId)!
    const account = harness.deployment.giteeCredentials[binding.credentialId]!
    return { engine: harness.engine, store: harness.store, sessions: { relay: vi.fn(), notify: vi.fn() }, resources: {} as ResourceHost,
      forge: () => ({ binding, adapter: giteeForgeAdapter, sourceId, login: account.login,
        context: giteeForgeAdapter.readContext({ deployment: harness.deployment, binding, commands: ctx.commands, env: process.env }),
        tickets: ctx.tickets, threads: ctx.threads, triggers: ctx.triggers,
        originIssue: originIssueOf(harness.store.triggers.get(ticket.origin.triggerId)) }),
      sendReplies: async () => {} }
  }
  const run = async (ticket: NonNullable<ReturnType<Harness['ticket']>>, name: string, args: unknown, sourceId = 'gitee-a') => {
    const tool = executorTools(toolHost(h, ticket, sourceId), ticket).find(item => item.name === name)!
    return await tool.execute(args, new AbortController().signal) as Record<string, unknown>
  }

  it('creates a real-shape PR, claims it by native ID, writes the result comment once, and observes the merge across a restart', async () => {
    h = harness()
    gitee = fakeGitee()
    vi.stubGlobal('fetch', gitee.fetch)
    const ticket = accept(h, A)
    await writeEnvironment(h.deployment, [])
    const created = await run(ticket, 'orchestrator_pull_request', { operation: 'create', title: 'Fix the login', body: 'Fixes it.', head: 'agent/fix-e2e',
      base: 'master' })
    expect(created).toMatchObject({ claimed: true, native_id: '100700', display_number: '700', state: 'open', head: 'agent/fix-e2e' })
    const followed = h.store.tickets.get(ticket.id)!
    expect(followed.follows).toEqual([{ thread: 'gitee-a:pull:100700', own: true, repositoryId: A.id }])
    expect(h.store.threads.get('gitee-a:pull:100700')?.meta).toMatchObject({ number: '700', nativeId: '100700', isPr: true })
    // The report claims the same PR by its immutable ID instead of guessing from a display number.
    await run(followed, 'orchestrator_report', { state: 'progress', summary: 'PR open', pr_native_id: '100700' })
    // The result comment is idempotent: a repeated key returns the first comment, also after a fresh process reopens the store.
    const first = await run(followed, 'orchestrator_comment', { text: 'PR #700 is ready for review.', key: 'result' })
    const second = await run(followed, 'orchestrator_comment', { text: 'PR #700 is ready for review.', key: 'result' })
    expect(first).toMatchObject({ reused: false })
    expect(second).toMatchObject({ reused: true, comment_id: first.comment_id })
    expect(gitee.state.issueComments[A.slug]).toHaveLength(1)
    expect(gitee.state.issueComments[A.slug]![0]!.body).toContain('PR #700 is ready for review.')
    const before = gitee.state.issueComments[A.slug]![0]!.id
    h.close(false)
    // Restart: reopen the same state, rebuild the contexts, and retry the same comment.
    h = harness(h.path)
    vi.stubGlobal('fetch', gitee.fetch)
    const restored = h.store.tickets.get(ticket.id)!
    const retried = await run(restored, 'orchestrator_comment', { text: 'PR #700 is ready for review.', key: 'result' })
    expect(retried).toMatchObject({ reused: true, comment_id: String(before) })
    expect(gitee.state.issueComments[A.slug]).toHaveLength(1)
    // A comment on the claimed PR reaches the Ticket's Thread once; a repeated poll does not duplicate it.
    const pull = gitee.state.pulls[A.slug]![0]!
    pull.comments.push({ id: 9100, body: 'Please adjust the margin.', user: { id: 7, login: 'alice' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      html_url: `${A.webUrl}/pulls/700#note_9100` })
    gitee.state.issueComments[A.slug]!.push({ id: 9101, body: 'The conversation comment too.', user: { id: 7, login: 'alice' },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      html_url: `${A.webUrl}/pulls/700#note_9101` })
    await pollWhenEnabled(h.ctx('gitee-a'))
    const triggers = h.store.read.threadTriggers('gitee-a:pull:100700', 100)
    expect(triggers.filter(trigger => trigger.meta.kind === 'pull-comment').map(trigger => trigger.meta.commentId))
      .toEqual(expect.arrayContaining(['9100', '9101']))
    const count = triggers.length
    await pollWhenEnabled(h.ctx('gitee-a'))
    expect(h.store.read.threadTriggers('gitee-a:pull:100700', 100)).toHaveLength(count)
    // The merged state, reported as closed with merged_at, ends the correct Ticket as merged after another restart.
    h.close(false)
    h = harness(h.path)
    // Gitee can report a merged pull request as `closed` with `merged_at`; that still ends the Ticket as merged.
    gitee.state.pulls[A.slug]![0]!.pull.state = 'closed'
    gitee.state.pulls[A.slug]![0]!.pull.mergedAt = new Date().toISOString()
    vi.stubGlobal('fetch', gitee.fetch)
    await pollWhenEnabled(h.ctx('gitee-a'))
    expect(h.store.tickets.get(ticket.id)?.ended).toMatchObject({ outcome: 'merged', by: 'executor' })
    // The token never travelled in a URL or body, and never entered the state directory.
    expect(gitee.calls.every(call => !call.url.href.includes(token) && !call.body.includes(token))).toBe(true)
    expect(JSON.stringify(h.store.keys('').map(item => h.store.get(item)))).not.toContain(token)
    for (const file of ['worker-gitee-credential-helper', 'worker-gitee-credential-helper.cjs', 'worker-gitconfig']) {
      expect(readFileSync(join(h.directory, file), 'utf8')).not.toContain(token)
    }
  })



  it('posts an acknowledgement once through the Gitee Channel with its retry marker', async () => {
    h = harness()
    gitee = fakeGitee()
    vi.stubGlobal('fetch', gitee.fetch)
    const message = { id: 'ack-1', channel: { source: 'gitee-a', thread: 'gitee-a:34904144',
      address: { number: 'IKS47K', url: `${A.webUrl}/issues/IKS47K` }, repositoryId: A.id }, text: 'On it: fixing the login.',
      kind: 'acknowledgement' as const, ticketId: 't1' }
    expect(await sendGitee(h.ctx('gitee-a'), message)).toBe('sent')
    expect(await sendGitee(h.ctx('gitee-a'), message)).toBe('sent')
    expect(gitee.state.issueComments[A.slug]).toHaveLength(1)
    expect(gitee.state.issueComments[A.slug]![0]!.body).toContain('On it: fixing the login.')
    expect(gitee.state.issueComments[A.slug]![0]!.body).toContain('<!-- dsh-superagent:ack-1 -->')
  })

  it('runs the slice twice from fresh state directories', async () => {
    for (let round = 0; round < 2; round++) {
      h = harness()
      gitee = fakeGitee()
      vi.stubGlobal('fetch', gitee.fetch)
      const ticket = accept(h, A)
      await run(ticket, 'orchestrator_pull_request', { operation: 'create', title: `Round ${round}`, body: '', head: 'agent/fix-e2e', base: 'master' })
      const comment = await run(ticket, 'orchestrator_comment', { text: `Round ${round} is ready.`, key: 'result' })
      expect(comment).toMatchObject({ reused: false })
      const pullId = h.store.tickets.get(ticket.id)!.follows![0]!.thread
      expect(h.store.tickets.get(ticket.id)!.follows![0]).toMatchObject({ own: true, repositoryId: A.id })
      expect(pullId).toMatch(/^gitee-a:pull:\d+$/)
      gitee.state.pulls[A.slug]![0]!.pull.state = round === 0 ? 'merged' : 'closed'
      gitee.state.pulls[A.slug]![0]!.pull.mergedAt = round === 0 ? new Date().toISOString() : undefined
      await pollWhenEnabled(h.ctx('gitee-a'))
      expect(h.store.tickets.get(ticket.id)?.ended).toMatchObject({ outcome: round === 0 ? 'merged' : 'closed' })
      expect(gitee.state.issueComments[A.slug]).toHaveLength(1)
      h.close()
    }
  })

  it('rejects a PR from another binding, another account, or one already claimed by another open Ticket', async () => {
    h = harness(undefined, [A, B])
    gitee = fakeGitee()
    vi.stubGlobal('fetch', gitee.fetch)
    const ticketA = accept(h, A, 'gitee-a', '34904144', 'IKS47K')
    const ticketB = accept(h, B, 'gitee-b', '34904144', 'IKS47K')
    await run(ticketA, 'orchestrator_pull_request', { operation: 'create', title: 'A', body: '', head: 'agent/fix-e2e', base: 'master' })
    const pullA = gitee.state.pulls[A.slug]![0]!.pull
    const hostA: PullHost = { binding: A, adapter: giteeForgeAdapter, sourceId: 'gitee-a', login: 'bourneW',
      tickets: h.ctx('gitee-a').tickets, threads: h.ctx('gitee-a').threads, triggers: h.ctx('gitee-a').triggers }
    // A pull request whose repository facts name B cannot be claimed for an A ticket.
    const foreign: ForgePull = { ...pullA, nativeId: '888888', displayNumber: '700', head: { ...pullA.head, repositoryId: B.providerRepositoryId,
      repositorySlug: B.slug }, base: { ...pullA.base, repositoryId: B.providerRepositoryId, repositorySlug: B.slug } }
    expect(claimPull(hostA, ticketA.id, foreign)).toContain('PR does not belong to this ticket')
    // A ticket of another binding cannot claim it at all, even with the same numbers and branch.
    expect(claimPull(hostA, ticketB.id, { ...pullA, nativeId: '777777' })).toContain('PR belongs to repository')
    // An account other than the binding's cannot claim the PR unless it is the verified source PR.
    expect(claimPull(hostA, ticketA.id, { ...pullA, nativeId: '777777', author: { providerUserId: '9', login: 'someone' } }))
      .toContain('PR does not belong to this ticket')
    // One open Ticket's claim excludes another open Ticket of the same binding; B's own PR remains B's.
    expect(claimPull(hostA, ticketA.id, pullA)).toBeUndefined()
    const secondA = accept(h, A, 'gitee-a', '34904145', 'IKS47L')
    expect(claimPull(hostA, secondA.id, pullA)).toBe('PR already belongs to another active ticket')
    const claimedB = await run(ticketB, 'orchestrator_pull_request', { operation: 'create', title: 'B', body: '', head: 'agent/fix-e2e', base: 'master' },
      'gitee-b')
    expect(claimedB.native_id).not.toBe(pullA.nativeId)
    expect(h.store.tickets.get(ticketB.id)!.follows).toEqual([{ thread: `gitee-b:pull:${claimedB.native_id}`, own: true, repositoryId: B.id }])
  })

  it('gives workers a binding-scoped Gitee credential helper and broker without a token in its files or environment', async () => {
    h = harness()
    const broker = new GiteeCredentialBroker({ stateDir: h.directory, lookup: bindingId => bindingId === A.id
      ? { binding: A, login: 'bourneW', token } : undefined })
    await broker.start()
    try {
      for (const file of giteeCredentialHelperFiles(h.directory)) writeFileSync(file.path, file.body, { mode: file.mode })
      const helper = join(h.directory, 'worker-gitee-credential-helper')
      const ask = (env: Record<string, string>, path: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        const child = spawn(helper, ['get'], { env: { PATH: process.env.PATH, HOME: h.directory, ...env } })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('close', code => resolve({ code, stdout, stderr }))
        child.stdin.end(`protocol=https\nhost=gitee.com\npath=${path}.git\n\n`)
      })
      const environment = { DSH_SUPERAGENT_REPOSITORY_ID: A.id, DSH_SUPERAGENT_REPOSITORY_PROVIDER: 'gitee', DSH_SUPERAGENT_REPOSITORY: A.slug }
      const granted = await ask(environment, A.slug)
      expect(granted.code).toBe(0)
      expect(granted.stdout).toContain('username=bourneW')
      expect(granted.stdout).toContain('password=')
      // A repository outside the mapped binding, and a binding without a credential, fail closed.
      expect(await ask(environment, B.slug)).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('outside this ticket\'s Gitee repository') })
      expect(await ask({ ...environment, DSH_SUPERAGENT_REPOSITORY_ID: B.id }, B.slug)).toMatchObject({ code: 1, stdout: '' })
      // No token is in the helper's files or the environment they receive.
      for (const file of ['worker-gitee-credential-helper', 'worker-gitee-credential-helper.cjs']) {
        expect(readFileSync(join(h.directory, file), 'utf8')).not.toContain(token)
      }
      expect(JSON.stringify(environment)).not.toContain(token)
      // The prepared worker environment names the binding and account but never the token.
      const values = Object.fromEntries(environmentOf({ deployment: h.deployment, sources: h.sources, settings: h.settings,
        ticket: { id: 't', name: 'fix', directory: h.directory }, repositoryId: A.id }).map(item => [item.key, item.value]))
      expect(values).toMatchObject({ DSH_SUPERAGENT_REPOSITORY_ID: A.id, DSH_SUPERAGENT_REPOSITORY_PROVIDER: 'gitee',
        DSH_SUPERAGENT_REPOSITORY: A.slug, DSH_SUPERAGENT_REPOSITORY_ACCOUNT: 'bourneW' })
      expect(JSON.stringify(values)).not.toContain(token)
    } finally { await broker.stop() }
  })
})
