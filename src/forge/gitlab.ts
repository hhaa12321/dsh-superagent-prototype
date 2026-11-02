/**
 * GitLab REST API v4 behind the forge capability boundary: repository resolution with authenticated identity and push
 * access, Issue and comment reads and writes, and merge-request reads, creation, and note reads. Uses Node `fetch`,
 * `AbortSignal`, `URL`, and `zod`, with every response validated at the adapter boundary. The token is read only through
 * the binding's credential reference and is sent as `PRIVATE-TOKEN`; it is never logged, persisted, or placed in a URL.
 */
import { z } from 'zod'
import type { RepositoryBinding } from '../repository.ts'
import { GitlabAccountsSchema } from './config.ts'
import { SetupError } from '../setup.ts'
import type { ForgeCapabilities } from './capabilities.ts'
import { ForgeHttpError } from './ports.ts'
import type { ForgeAdapter, ForgeActor, ForgeComment, ForgeIssue, ForgePage, ForgePull, ForgePullInput, ForgeReadContext, ForgeReadQuery,
  ForgeResolveInput, ForgeResolution, ForgeSetupEnvironment } from './ports.ts'

/** Default API base; tests pass a stub transport rather than another URL. */
export const GITLAB_API = 'https://gitlab.com/api/v4'
const PAGE_SIZE = 100
const TIMEOUT_MS = 30_000
/** Project access level that allows pushing: Developer, Maintainer, or Owner. */
const DEVELOPER_ACCESS = 30
/**
 * The operations this adapter implements. GitLab supports Issue and merge-request notes, merge-request creation, and the
 * complete write path a Ticket needs; it reports no review or CI port.
 */
const GITLAB_CAPABILITIES: ForgeCapabilities = {
  repository: 'read-write', identity: true, issues: { read: true, comment: true },
  pulls: { read: true, create: true, comment: true, reviews: false }, ci: false, execution: true,
}
const GitlabUserSchema = z.looseObject({ id: z.number().int().positive(), username: z.string().min(1), name: z.string().nullish(),
  email: z.string().nullish(), bot: z.boolean().nullish() })
const GitlabAccessSchema = z.looseObject({ access_level: z.number().int().nullish() }).nullish()
const GitlabRepositorySchema = z.looseObject({
  id: z.number().int().positive(),
  path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/),
  web_url: z.string().url(),
  default_branch: z.string().nullish(),
  permissions: z.looseObject({ project_access: GitlabAccessSchema, group_access: GitlabAccessSchema }).nullish(),
})
const GitlabIssueSchema = z.looseObject({
  id: z.number().int().positive(), iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(),
  author: GitlabUserSchema, created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string(), user_notes_count: z.number().nullish(),
})
const GitlabNoteSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string().nullish(), author: GitlabUserSchema, created_at: z.string(),
  updated_at: z.string().nullish(), system: z.boolean().nullish(),
})
const GitlabPullSchema = z.looseObject({
  id: z.number().int().positive(), iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']), author: GitlabUserSchema, created_at: z.string(), updated_at: z.string(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), web_url: z.string(),
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullish(), source_project_id: z.number().int().nullish(),
  target_project_id: z.number().int().nullish(),
})

const actor = (user: z.infer<typeof GitlabUserSchema>): ForgeActor => ({ providerUserId: String(user.id), login: user.username,
  bot: user.bot === true })
const normalized = (value: string): string => new Date(Date.parse(value)).toISOString()
const json = (value: unknown, token: string | undefined): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return (token ? text.replaceAll(token, '***') : text).slice(0, 300)
}
/** GitLab reports a provider message as a string or a field map; keep it short and never include the token. */
const message = (parsed: unknown, statusText: string, token: string | undefined): string => {
  if (parsed && typeof parsed === 'object') {
    const body = parsed as { message?: unknown; error?: unknown }
    return json(body.message ?? body.error ?? statusText, token)
  }
  return json(statusText, token)
}
async function send<T>(url: URL, schema: z.ZodType<T>, context: ForgeReadContext, init: RequestInit): Promise<{ value: T; headers: Headers }> {
  const token = context.token
  if (!token) throw new Error('The GitLab credential reference did not resolve a token')
  const fetchImpl = context.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, headers: { 'private-token': token, accept: 'application/json', ...init.headers },
      signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    if (context.signal?.aborted) throw error
    throw new ForgeHttpError(`GitLab request failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'gitlab')
  }
  const text = await response.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = undefined }
  if (!response.ok) throw new ForgeHttpError(`GitLab API ${response.status}: ${message(parsed, response.statusText, token)}`, response.status,
    'gitlab')
  const value = schema.safeParse(parsed)
  if (!value.success) throw new ForgeHttpError(`GitLab returned an unexpected ${url.pathname.split('/api/v4').at(-1)} response`, response.status,
    'gitlab')
  return { value: value.data, headers: response.headers }
}
const get = <T>(path: string, schema: z.ZodType<T>, context: ForgeReadContext, token?: string) =>
  send(new URL(`${GITLAB_API}${path}`), schema, { ...context, ...token !== undefined ? { token } : {} }, { method: 'GET' })
const submit = async <T>(path: string, schema: z.ZodType<T>, body: Record<string, unknown>, context: ForgeReadContext): Promise<T> =>
  (await send(new URL(`${GITLAB_API}${path}`), schema, context, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).value
/** Next page from GitLab's `X-Next-Page` header, or from a full page when a stub reports no header at all. */
function nextPage(headers: Headers, page: number, count: number, limit: number): string | undefined {
  if (headers.has('x-next-page')) {
    const next = headers.get('x-next-page')?.trim() ?? ''
    return next ? next : undefined
  }
  return count >= limit ? String(page + 1) : undefined
}
const pageOf = (cursor: string | undefined): number => {
  const page = Number(cursor ?? '1')
  return Number.isInteger(page) && page > 0 ? page : 1
}
const limitOf = (query: ForgeReadQuery): number => Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), PAGE_SIZE)
/** GitLab's list endpoints take `updated_after` (inclusive) and page/per_page. */
const listQuery = (query: ForgeReadQuery): string => {
  const limit = limitOf(query)
  return `page=${pageOf(query.cursor)}&per_page=${limit}${query.since ? `&updated_after=${encodeURIComponent(query.since)}` : ''}`
}
/** Notes take no timestamp filter, so the adapter pages them and applies the cursor's inclusive comparison itself. */
const noteQuery = (query: ForgeReadQuery): string =>
  `page=${pageOf(query.cursor)}&per_page=${limitOf(query)}&sort=asc&order_by=updated_at&activity_filter=only_comments`
const since = (query: ForgeReadQuery): number => Date.parse(query.since ?? '') || Number.NEGATIVE_INFINITY
/** The project path segment: the numeric ID for normal operations, URL-encoded for resolution by slug. */
const project = (binding: Pick<RepositoryBinding, 'providerRepositoryId'>): string => encodeURIComponent(binding.providerRepositoryId)
const repoPath = (slug: string): string => encodeURIComponent(slug)

const mapIssue = (issue: z.infer<typeof GitlabIssueSchema>): ForgeIssue => ({
  nativeId: String(issue.id), displayNumber: String(issue.iid), threadId: String(issue.id), title: issue.title,
  body: issue.description ?? '', author: actor(issue.author), createdAt: normalized(issue.created_at),
  updatedAt: normalized(issue.updated_at ?? issue.created_at), webUrl: issue.web_url, comments: issue.user_notes_count ?? 0,
  pullRequest: false,
})
const mapComment = (note: z.infer<typeof GitlabNoteSchema>): ForgeComment => ({
  nativeId: String(note.id), body: note.body ?? '', author: actor(note.author), createdAt: normalized(note.created_at),
  updatedAt: normalized(note.updated_at ?? note.created_at),
})
const mapState = (state: z.infer<typeof GitlabPullSchema>['state']): ForgePull['state'] =>
  state === 'merged' ? 'merged' : state === 'closed' || state === 'locked' ? 'closed' : 'open'
const mapPull = (pull: z.infer<typeof GitlabPullSchema>): ForgePull => ({
  nativeId: String(pull.id), displayNumber: String(pull.iid), title: pull.title, body: pull.description ?? '', state: mapState(pull.state),
  author: actor(pull.author), createdAt: normalized(pull.created_at), updatedAt: normalized(pull.updated_at),
  ...pull.merged_at ? { mergedAt: normalized(pull.merged_at) } : {}, ...pull.closed_at ? { closedAt: normalized(pull.closed_at) } : {},
  webUrl: pull.web_url, head: { ref: pull.source_branch, sha: pull.sha ?? '', ...pull.source_project_id !== null && pull.source_project_id !== undefined
    ? { repositoryId: String(pull.source_project_id) } : {} },
  base: { ref: pull.target_branch, ...pull.target_project_id !== null && pull.target_project_id !== undefined
    ? { repositoryId: String(pull.target_project_id) } : {} },
})
/** The strongest access the authenticated user has on the project, or 0 when GitLab reports none. */
const access = (permissions: z.infer<typeof GitlabRepositorySchema>['permissions']): number =>
  Math.max(permissions?.project_access?.access_level ?? 0, permissions?.group_access?.access_level ?? 0)

/** Resolves the token a binding's credential reference names, without ever returning the variable value elsewhere. */
function tokenOf(environment: ForgeSetupEnvironment, variable: string): string {
  const token = environment.env[variable]
  if (!token) throw new SetupError('tokenCredentialUnset', { provider: 'GitLab', variable }, 'gitlab')
  return token
}

/** The GitLab adapter; a read requires the token resolved from the binding's credential reference. */
export const gitlabForgeAdapter: ForgeAdapter = {
  provider: 'gitlab',
  capabilities: GITLAB_CAPABILITIES,
  gitHost: 'gitlab.com',
  credentialKind: 'token',
  presentation: {
    issueUrl: (repository, number) => `${repository.webUrl}/-/issues/${encodeURIComponent(number)}`,
    pullUrl: (repository, number) => `${repository.webUrl}/-/merge_requests/${encodeURIComponent(number)}`,
    accountUrl: login => `https://gitlab.com/${login}`,
  },
  /** GitLab keeps merge-request IIDs and Issue IIDs in separate projects streams, but a global MR ID keeps its Thread unique. */
  pullThreadId: pull => `pull:${pull.nativeId}`,
  readContext({ binding, deployment, env }) {
    const credential = deployment.tokenCredentials[binding.credentialId]
    if (!credential) throw new Error(`Repository ${binding.id} has no resolved GitLab credential ${binding.credentialId}`)
    const token = env[credential.tokenEnv]
    if (!token) throw new Error(`The GitLab credential ${credential.tokenEnv} is not set in the dsh-superagent process`)
    return { token }
  },
  async resolveRepository(input: ForgeResolveInput, environment: ForgeSetupEnvironment): Promise<ForgeResolution | undefined> {
    const config = GitlabAccountsSchema.parse(input.config ?? {})
    if (!config.repository) return undefined
    const token = tokenOf(environment, config.tokenEnv)
    const user = await get('/user', GitlabUserSchema, { signal: environment.signal, fetch: environment.fetch }, token).then(result => result.value)
      .catch((error: unknown) => {
        if (error instanceof ForgeHttpError && (error.status === 401 || error.status === 403)) {
          throw new SetupError('tokenCredentialRejected', { provider: 'GitLab', output: error.message }, 'gitlab')
        }
        throw error
      })
    const repository = await get(`/projects/${repoPath(config.repository)}`, GitlabRepositorySchema,
      { signal: environment.signal, fetch: environment.fetch }, token).then(result => result.value).catch((error: unknown) => {
      throw new SetupError(error instanceof ForgeHttpError && error.status === 404 ? 'tokenRepositoryUnreadable' : 'tokenRepositoryUnreported',
        { provider: 'GitLab', account: user.username, repository: config.repository, output: error instanceof Error ? error.message : String(error) }, 'gitlab')
    })
    const push = access(repository.permissions) >= DEVELOPER_ACCESS
    if (!push) throw new SetupError('tokenRepositoryReadOnly', { provider: 'GitLab', account: user.username, repository: repository.path_with_namespace }, 'gitlab')
    return {
      repository: { providerRepositoryId: String(repository.id), slug: repository.path_with_namespace, webUrl: repository.web_url,
        defaultBranch: repository.default_branch ?? '' },
      identity: { providerUserId: String(user.id), login: user.username, ...user.name ? { name: user.name } : {},
        ...user.email ? { email: user.email } : {} },
      push,
      capabilities: { ...GITLAB_CAPABILITIES, repository: push ? 'read-write' : 'read' },
      credential: { reference: config.tokenEnv, commitEmail: user.email ?? `${user.id}-${user.username}@users.noreply.gitlab.com` },
    }
  },
  async listIssues(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgeIssue>> {
    const { value, headers } = await get(`/projects/${project(binding)}/issues?state=all&scope=all&sort=asc&order_by=updated_at&${listQuery(query)}`,
      z.array(GitlabIssueSchema), context)
    const items = value.map(mapIssue)
    const next = nextPage(headers, pageOf(query.cursor), items.length, limitOf(query))
    return { items, ...next ? { next } : {} }
  },
  async readIssue(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgeIssue> {
    return mapIssue((await get(`/projects/${project(binding)}/issues/${encodeURIComponent(displayNumber)}`, GitlabIssueSchema, context)).value)
  },
  async listComments(binding: RepositoryBinding, issue: Pick<ForgeIssue, 'displayNumber'>, query: ForgeReadQuery, context: ForgeReadContext):
    Promise<ForgePage<ForgeComment>> {
    const { value, headers } = await get(`/projects/${project(binding)}/issues/${encodeURIComponent(issue.displayNumber)}/notes?${noteQuery(query)}`,
      z.array(GitlabNoteSchema), context)
    // GitLab marks system activity as `system: true`; only human notes are messages a Source may ingest.
    const items = value.filter(note => note.system !== true).map(mapComment).filter(comment => Date.parse(comment.updatedAt) >= since(query))
    const next = nextPage(headers, pageOf(query.cursor), value.length, limitOf(query))
    return { items, ...next ? { next } : {} }
  },
  async createComment(binding: RepositoryBinding, issue: Pick<ForgeIssue, 'displayNumber'>, body: string, context: ForgeReadContext):
    Promise<ForgeComment> {
    return mapComment(await submit(`/projects/${project(binding)}/issues/${encodeURIComponent(issue.displayNumber)}/notes`, GitlabNoteSchema,
      { body }, context))
  },
  async listPulls(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgePull>> {
    const { value, headers } = await get(`/projects/${project(binding)}/merge_requests?state=all&scope=all&sort=asc&order_by=updated_at&${listQuery(query)}`,
      z.array(GitlabPullSchema), context)
    const items = value.map(mapPull)
    const next = nextPage(headers, pageOf(query.cursor), items.length, limitOf(query))
    return { items, ...next ? { next } : {} }
  },
  async readPull(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgePull> {
    return mapPull((await get(`/projects/${project(binding)}/merge_requests/${encodeURIComponent(displayNumber)}`, GitlabPullSchema, context)).value)
  },
  async createPull(binding: RepositoryBinding, input: ForgePullInput, context: ForgeReadContext): Promise<ForgePull> {
    return mapPull(await submit(`/projects/${project(binding)}/merge_requests`, GitlabPullSchema,
      { title: input.title, description: input.body, source_branch: input.head, target_branch: input.base }, context))
  },
  async createPullComment(binding: RepositoryBinding, pull: Pick<ForgePull, 'displayNumber'>, body: string, context: ForgeReadContext):
    Promise<ForgeComment> {
    return mapComment(await submit(`/projects/${project(binding)}/merge_requests/${encodeURIComponent(pull.displayNumber)}/notes`, GitlabNoteSchema,
      { body }, context))
  },
  async listPullComments(binding: RepositoryBinding, pull: Pick<ForgePull, 'displayNumber'>, query: ForgeReadQuery, context: ForgeReadContext):
    Promise<ForgePage<ForgeComment>> {
    const { value, headers } = await get(`/projects/${project(binding)}/merge_requests/${encodeURIComponent(pull.displayNumber)}/notes?${noteQuery(query)}`,
      z.array(GitlabNoteSchema), context)
    const items = value.filter(note => note.system !== true).map(mapComment).filter(comment => Date.parse(comment.updatedAt) >= since(query))
    const next = nextPage(headers, pageOf(query.cursor), value.length, limitOf(query))
    return { items, ...next ? { next } : {} }
  },
}
