/**
 * The forge capability boundary: narrow ports for repository resolution and identity/access, Issue and comment reads,
 * pull-request reads, and presentation. Reads return provider-neutral records that still carry every native identity the
 * provider exposes (its immutable ID separately from its display number), so the domain never flattens two providers into
 * one provider's response object and never hides an ID behind a display value.
 */
import type { RepositoryBinding } from '../repository.ts'
import type { Commands } from '../infra/commands.ts'
import type { ForgeCapabilities } from './capabilities.ts'

/** A person, bot, or agent in a provider's own identity space. */
export interface ForgeActor { providerUserId: string; login: string; bot?: boolean }
/** One repository as its provider identifies it: the immutable ID is identity, the slug only display and lookup input. */
export interface ForgeRepository { providerRepositoryId: string; slug: string; webUrl: string; defaultBranch: string }
/** The authenticated account behind a binding's credential reference. */
export interface ForgeIdentity { providerUserId: string; login: string; name?: string }
/** An Issue as the provider reports it; `threadId` is the provider's native thread identity and never the display number. */
export interface ForgeIssue {
  nativeId: string
  displayNumber: string
  /** Native Thread identity: Gitee's numeric Issue ID, GitHub's Issue number. */
  threadId: string
  title: string
  body: string
  author: ForgeActor
  createdAt: string
  updatedAt: string
  webUrl: string
  comments: number
  /** True when the provider lists pull requests in its Issue stream, as GitHub does. */
  pullRequest?: boolean
}
/** One Issue comment; `nativeId` is the provider's comment ID, never a position in a list. */
export interface ForgeComment {
  nativeId: string
  body: string
  author: ForgeActor
  createdAt: string
  updatedAt: string
  webUrl?: string
}
export type ForgePullState = 'open' | 'closed' | 'merged'
/** One pull request, keeping the provider's numeric ID apart from its display number. */
export interface ForgePull {
  nativeId: string
  displayNumber: string
  title: string
  body: string
  state: ForgePullState
  author: ForgeActor
  createdAt: string
  updatedAt: string
  mergedAt?: string
  closedAt?: string
  webUrl: string
  head: { ref: string; sha: string }
  base: { ref: string }
}
/** A page of reads; `next` is the provider's cursor for the following page, when there is one. */
export interface ForgePage<T> { items: T[]; next?: string | undefined }
/** Bounded read query shared by list ports: an ISO timestamp floor and the provider cursor. */
export interface ForgeReadQuery { since?: string | undefined; cursor?: string | undefined; limit?: number | undefined }

/** Where provider repository resolution runs: a worker-style probe, executable lookup, and the process environment. */
export interface ForgeSetupEnvironment {
  /** Runs an argv through the same subprocess boundary as workers and returns stdout. */
  probe(argv: string[]): Promise<string>
  /** Resolves a configured command name or absolute path, skipping the worker shim directory. */
  executable(name: string): string
  /** The process environment, whose variables a credential reference names; values are never persisted. */
  env: Record<string, string | undefined>
  signal: AbortSignal
  /** HTTP transport for tests; defaults to the process `fetch`. */
  fetch?: typeof globalThis.fetch | undefined
}

/** One source instance's configuration as its provider adapter resolves it. */
export interface ForgeResolveInput { sourceId: string; config: Record<string, unknown> }

/**
 * What repository resolution established: identity, access, capabilities, and a credential reference. The adapter never
 * returns a secret; it names the environment variable or CLI whose account was verified.
 */
export interface ForgeResolution {
  repository: ForgeRepository
  identity: ForgeIdentity
  /** True only after the provider confirmed push access for the bound account. */
  push: boolean
  capabilities: ForgeCapabilities
  /** Reference into a protected credential source, such as a GitHub CLI path or an environment variable name. */
  credential: { reference: string; commitEmail?: string }
}

/** Per-call read context: the binding's resolved secret (never logged or persisted) and provider-specific transports. */
export interface ForgeReadContext {
  signal?: AbortSignal | undefined
  /** The binding's secret resolved from its credential reference; a GitHub adapter reads through `commands` instead. */
  token?: string | undefined
  /** GitHub CLI commands scoped to this binding; providers that read over HTTP ignore it. */
  commands?: Commands | undefined
  /** HTTP transport for tests; defaults to the process `fetch`. */
  fetch?: typeof globalThis.fetch | undefined
}

/** Provider URL facts: links are built from the repository and display values the provider controls. */
export interface ForgePresentation {
  issueUrl(repository: Pick<RepositoryBinding, 'webUrl'>, displayNumber: string): string
  pullUrl(repository: Pick<RepositoryBinding, 'webUrl'>, displayNumber: string): string
  accountUrl(login: string): string
}

/**
 * One registered forge adapter. `resolveRepository` serves setup and identity/access; the read ports serve polling and
 * the panel's on-demand reads. Unsupported operations are reported through `capabilities`, not by a generic failure.
 */
export interface ForgeAdapter {
  readonly provider: string
  readonly capabilities: ForgeCapabilities
  readonly presentation: ForgePresentation
  /** Resolves one configured Source, or `undefined` when its configuration names no repository to bind yet. */
  resolveRepository(input: ForgeResolveInput, environment: ForgeSetupEnvironment): Promise<ForgeResolution | undefined>
  listIssues(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgeIssue>>
  readIssue(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgeIssue>
  listComments(binding: RepositoryBinding, issue: ForgeIssue, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgeComment>>
  listPulls(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgePull>>
  /** Reads a pull request by its display number, which the provider's read endpoint uses; the result keeps its native ID. */
  readPull(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgePull>
}
