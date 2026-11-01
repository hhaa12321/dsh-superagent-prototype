/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type GithubSourceInput, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import type { Store } from './store.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  /** Persists resolved RepositoryBindings and the one-to-one Source instance mapping. */
  readonly store: Pick<Store, 'repositories' | 'atomic'>
  restart(): void
}

/** The setup-read fields of every configured Source instance, by instance ID, so moving or renaming one is noticed. */
const setupFields = (settings: Settings): string => JSON.stringify(Object.entries(settings.sources).flatMap(([id, source]) => {
  const keys = SETUP_FIELDS[source.kind]
  return keys ? [[id, keys.map(key => source.config[key] ?? '')]] : []
}).sort(([a], [b]) => String(a).localeCompare(String(b))))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/** Every configured GitHub instance; a deployment with none fails setup with `repositoryUnset`. */
function githubSources(settings: Settings): GithubSourceInput[] {
  return Object.entries(settings.sources).filter(([, source]) => source.kind === 'github')
    .map(([sourceId, source]) => ({ sourceId, kind: 'github', enabled: source.enabled, config: source.config }))
}

/**
 * Resolves the target repositories, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the
 * isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update
 * blocked command shims, and schedule restarts. Repository identity is persisted as a RepositoryBinding before readiness.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and RepositoryBindings and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const id = block.startsWith('source:') ? block.slice('source:'.length) : undefined
    const source = id === undefined ? undefined : settings.sources[id]
    const kind = source?.kind
    const check = kind === 'feishu' ? resolveFeishuBot(machine, source?.config, this.probe())
      : resolveDeployment(machine, githubSources(settings), this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === id || error.place === kind) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, githubSources(settings), probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    // Atomically replace the provider-resolved bindings and Source mapping: removed Sources leave no stale enabled binding.
    const sources = githubSources(settings)
    this.host.store.repositories.reconcile(deployment.repositories, sources.flatMap(source => {
      const binding = deployment.repositories.find(item => item.credentialId === `github:${source.sourceId}`)
      return binding ? [{ sourceId: source.sourceId, repositoryId: binding.id }] : []
    }))
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
