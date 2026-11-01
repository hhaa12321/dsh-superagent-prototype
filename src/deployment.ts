/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError, type SetupProblem } from './setup.ts'
import { forgeCredentialId } from './repository.ts'
import type { RepositoryBinding } from './repository.ts'
import { GiteeAccountsSchema, GithubAccountsSchema } from './forge/config.ts'
import { ForgeRegistry } from './forge/registry.ts'
import { githubForgeAdapter } from './forge/github.ts'
import { giteeForgeAdapter } from './forge/gitee.ts'
import type { ForgeSetupEnvironment } from './forge/ports.ts'

export { GiteeAccountsSchema, GithubAccountsSchema } from './forge/config.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: ['repository', 'cli'], gitee: ['repository', 'tokenEnv'],
  feishu: Object.keys(FeishuBotSchema.shape) }

/** One resolved GitHub CLI identity; `credentialId` of a binding names one of these entries. */
export interface GithubCredential { cli: string; login: string; noreply: string }
/** One resolved Gitee identity and the environment variable that holds its token; the token itself is never stored here. */
export interface GiteeCredential { tokenEnv: string; login: string; userId: string }
/** Built-in forge adapters; setup resolves every repository-bound Source through its provider's adapter. */
export const FORGE_ADAPTERS = new ForgeRegistry([githubForgeAdapter, giteeForgeAdapter])
export interface Deployment extends Machine {
  /** The first GitHub account, used by repository-less paths such as the shared worker shim; absent in a Gitee-only deployment. */
  github?: GithubCredential
  /** GitHub CLI credentials by binding `credentialId`; a ticket's tool calls resolve their own binding's entry. */
  credentials: Record<string, GithubCredential>
  /** Gitee identities by binding `credentialId`; each names the variable its token is read from at use. */
  giteeCredentials: Record<string, GiteeCredential>
  /** Persisted repository bindings resolved and verified at startup. */
  repositories: RepositoryBinding[]
  /** Setup failures scoped to one Source instance; other Sources keep running, and the panel shows each on its own card. */
  sourceProblems?: Record<string, SetupProblem>
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** A Source instance's config as setup reads it; `kind` defaults to the instance ID and selects the forge adapter. */
export interface ForgeSourceInput { sourceId: string; kind?: string; enabled: boolean; config: unknown; repositoryId?: string | null }
/** @deprecated Kept for callers that still name the GitHub shape; every forge Source resolves through the same input. */
export type GithubSourceInput = ForgeSourceInput
/**
 * Resolve every configured repository-bound Source through its provider's forge adapter. Each enabled instance resolves
 * exactly one RepositoryBinding whose stable ID is the provider's immutable repository ID; a slug is only a display name
 * and the input used to find the repository. Re-resolving keeps the binding ID across slug changes. A deployment may have
 * Gitee bindings alone: no GitHub Source is invented or required.
 */
export async function resolveDeployment(machine: Machine, sources: readonly ForgeSourceInput[], probe: Probe, path = process.env.PATH ?? '',
  env: Record<string, string | undefined> = process.env, adapters: ForgeRegistry = FORGE_ADAPTERS): Promise<Deployment> {
  const { stateDir } = machine
  const environment: ForgeSetupEnvironment = {
    probe,
    executable: name => executable(name, path, workerBin(stateDir)),
    env,
    signal: AbortSignal.timeout(60_000),
  }
  const credentials: Record<string, GithubCredential> = {}
  const giteeCredentials: Record<string, GiteeCredential> = {}
  const repositories: RepositoryBinding[] = []
  const sourceProblems: Record<string, SetupProblem> = {}
  const owners = new Map<string, string[]>()
  let repositoryBound = false
  for (const source of sources) {
    const provider = source.kind ?? source.sourceId
    const adapter = adapters.adapter(provider)
    if (!adapter) continue
    repositoryBound = true
    let resolution
    try {
      resolution = await adapter.resolveRepository({ sourceId: source.sourceId, config: (source.config ?? {}) as Record<string, unknown> }, environment)
    } catch (error) {
      // A failed Source keeps its problem; only a deployment-level failure, or one with no remaining Source, stops setup.
      if (!(error instanceof SetupError) || error.place === 'deployment') throw error
      sourceProblems[source.sourceId] = { ...error.problem, source: source.sourceId }
      continue
    }
    if (!resolution) {
      if (source.enabled) {
        const problem = new SetupError(provider === 'gitee' ? 'giteeRepositoryUnset' : 'repositoryUnset')
        sourceProblems[source.sourceId] = { ...problem.problem, source: source.sourceId }
      }
      continue
    }
    const id = `${provider}:${resolution.repository.providerRepositoryId}`
    const owner = owners.get(id) ?? []
    if (owner.length) throw new SetupError('repositoryDuplicate', { repository: resolution.repository.slug, sources: [...owner, source.sourceId].join(', ') })
    owners.set(id, [source.sourceId])
    const credentialId = forgeCredentialId(provider, source.sourceId)
    if (provider === 'github') {
      credentials[credentialId] = { cli: resolution.credential.reference, login: resolution.identity.login,
        noreply: resolution.credential.commitEmail ?? `${resolution.identity.providerUserId}+${resolution.identity.login}@users.noreply.github.com` }
    } else if (provider === 'gitee') {
      giteeCredentials[credentialId] = { tokenEnv: resolution.credential.reference, login: resolution.identity.login,
        userId: resolution.identity.providerUserId }
    }
    repositories.push({ id, provider, providerRepositoryId: resolution.repository.providerRepositoryId, slug: resolution.repository.slug,
      webUrl: resolution.repository.webUrl, credentialId, capabilities: resolution.capabilities, enabled: source.enabled })
  }
  if (!repositoryBound) throw new SetupError('repositoryUnset')
  const failed = Object.keys(sourceProblems)
  if (!repositories.length && failed.length) {
    const first = sourceProblems[failed[0]!]!
    throw new SetupError(first.code, first.values)
  }
  const github = [...new Set(Object.values(credentials))][0]
  return { ...machine, ...github ? { github } : {}, credentials, giteeCredentials, repositories,
    ...failed.length ? { sourceProblems } : {} }
}

/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
