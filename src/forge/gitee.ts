/**
 * Gitee API v5 behind the forge capability boundary: repository resolution with authenticated identity and push access,
 * Issue and comment reads, and pull-request reads. Uses Node `fetch`, `AbortSignal`, `URL`, and `zod`, with every response
 * validated at the adapter boundary. The token is resolved from a credential reference and never logged, persisted, or
 * placed in a URL.
 */
import { z } from 'zod'
import type { RepositoryBinding } from '../repository.ts'
import { GiteeAccountsSchema } from './config.ts'
import { SetupError } from '../setup.ts'
import type { ForgeCapabilities } from './capabilities.ts'
import type { ForgeAdapter, ForgeActor, ForgeComment, ForgeIssue, ForgePage, ForgePull, ForgeReadContext, ForgeReadQuery, ForgeResolveInput,
  ForgeResolution, ForgeSetupEnvironment } from './ports.ts'

/** Default API base; tests pass a stub transport rather than another URL. */
export const GITEE_API = 'https://gitee.com/api/v5'
const PAGE_SIZE = 100
const TIMEOUT_MS = 30_000
/**
 * The operations this adapter implements. Issue and pull requests are read-only: Phase 3 has no Gitee writes, CI, or
 * review APIs, and the panel reports that rather than failing a generic read.
 */
const GITEE_CAPABILITIES: ForgeCapabilities = {
  repository: 'read-write', identity: true, issues: { read: true, comment: false },
  pulls: { read: true, create: false, comment: false, reviews: false }, ci: false, execution: false,
}
const GiteeUserSchema = z.looseObject({ login: z.string(), id: z.number().int().positive().optional(), name: z.string().nullish() })
const GiteeRepositorySchema = z.looseObject({
  id: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  html_url: z.string(),
  default_branch: z.string().nullish(),
  permission: z.looseObject({ push: z.boolean().nullish() }).nullish(),
})
const GiteeIssueSchema = z.looseObject({
  id: z.number().int().positive(), number: z.string().min(1), title: z.string(), body: z.string().nullish(), user: GiteeUserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), html_url: z.string(), comments: z.number().nullish(),
})
const GiteeCommentSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string().nullish(), user: GiteeUserSchema, created_at: z.string(), updated_at: z.string().nullish(),
})
const GiteePullSchema = z.looseObject({
  id: z.number().int().positive(), number: z.number().int().positive(), title: z.string(), body: z.string().nullish(),
  state: z.enum(['open', 'closed', 'merged']), user: GiteeUserSchema, created_at: z.string(), updated_at: z.string(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), html_url: z.string(),
  head: z.looseObject({ ref: z.string(), sha: z.string().nullish() }), base: z.looseObject({ ref: z.string() }),
})

/** A provider HTTP failure, normalized to its status and a sanitized provider message without the request URL or token. */
export class ForgeHttpError extends Error {
  constructor(message: string, readonly status: number, readonly provider: string) { super(message) }
}
const actor = (user: z.infer<typeof GiteeUserSchema>): ForgeActor => ({ providerUserId: String(user.id ?? user.login), login: user.login })
const normalized = (value: string): string => new Date(Date.parse(value)).toISOString()
const pageUrl = (url: string): string => url.replace(/\.git$/, '')
const json = (value: unknown, token: string | undefined): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return (token ? text.replaceAll(token, '***') : text).slice(0, 300)
}

/** One authenticated request against a Gitee API base, validated by `zod` before any caller sees it. */
async function request<T>(path: string, schema: z.ZodType<T>, context: ForgeReadContext, supplied?: string | undefined):
  Promise<{ value: T; headers: Headers }> {
  const token = supplied ?? context.token
  if (!token) throw new Error('The Gitee credential reference did not resolve a token')
  const url = new URL(`${GITEE_API}${path}`)
  const fetchImpl = context.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `token ${token}`, accept: 'application/json' },
      signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    if (context.signal?.aborted) throw error
    throw new ForgeHttpError(`Gitee request failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'gitee')
  }
  const text = await response.text()
  let parsed: unknown
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = undefined }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed ? String((parsed as { message: unknown }).message) : response.statusText
    throw new ForgeHttpError(`Gitee API ${response.status}: ${json(message, token)}`, response.status, 'gitee')
  }
  const value = schema.safeParse(parsed)
  if (!value.success) throw new ForgeHttpError(`Gitee returned an unexpected ${path.split('?')[0]} response`, response.status, 'gitee')
  return { value: value.data, headers: response.headers }
}
/** Next page from Gitee's `total_page`/`total_count` headers, or from a full page when they are absent. */
function nextPage(headers: Headers, page: number, count: number, limit: number): string | undefined {
  const totalPage = Number(headers.get('total_page') ?? '')
  if (Number.isFinite(totalPage) && totalPage > 0) return page < totalPage ? String(page + 1) : undefined
  return count >= limit ? String(page + 1) : undefined
}
const pageOf = (cursor: string | undefined): number => {
  const page = Number(cursor ?? '1')
  return Number.isInteger(page) && page > 0 ? page : 1
}
const listQuery = (query: ForgeReadQuery): string => {
  const page = pageOf(query.cursor)
  const limit = Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), PAGE_SIZE)
  return `page=${page}&per_page=${limit}${query.since ? `&since=${encodeURIComponent(query.since)}` : ''}`
}
/** Page parameters without `since`: Gitee's comment endpoint filters strictly after the timestamp, which would drop an equal one. */
const pageQuery = (query: ForgeReadQuery): string => {
  const page = pageOf(query.cursor)
  return `page=${page}&per_page=${Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), PAGE_SIZE)}`
}
const since = (query: ForgeReadQuery): number => Date.parse(query.since ?? '') || Number.NEGATIVE_INFINITY

const mapIssue = (issue: z.infer<typeof GiteeIssueSchema>): ForgeIssue => ({
  nativeId: String(issue.id), displayNumber: issue.number, threadId: String(issue.id), title: issue.title, body: issue.body ?? '',
  author: actor(issue.user), createdAt: normalized(issue.created_at), updatedAt: normalized(issue.updated_at ?? issue.created_at),
  webUrl: issue.html_url, comments: issue.comments ?? 0, pullRequest: false,
})
const mapComment = (comment: z.infer<typeof GiteeCommentSchema>): ForgeComment => ({
  nativeId: String(comment.id), body: comment.body ?? '', author: actor(comment.user), createdAt: normalized(comment.created_at),
  updatedAt: normalized(comment.updated_at ?? comment.created_at),
})
const mapPull = (pull: z.infer<typeof GiteePullSchema>): ForgePull => ({
  nativeId: String(pull.id), displayNumber: String(pull.number), title: pull.title, body: pull.body ?? '',
  state: pull.state === 'merged' || pull.merged_at ? 'merged' : pull.state, author: actor(pull.user),
  createdAt: normalized(pull.created_at), updatedAt: normalized(pull.updated_at),
  ...pull.merged_at ? { mergedAt: normalized(pull.merged_at) } : {}, ...pull.closed_at ? { closedAt: normalized(pull.closed_at) } : {},
  webUrl: pull.html_url, head: { ref: pull.head.ref, sha: pull.head.sha ?? '' }, base: { ref: pull.base.ref },
})

/** Resolves the token a binding's credential reference names, without ever returning the variable value elsewhere. */
function tokenOf(environment: ForgeSetupEnvironment, variable: string): string {
  const token = environment.env[variable]
  if (!token) throw new SetupError('giteeTokenUnset', { variable })
  return token
}

/** The Gitee adapter; a read requires the token resolved from the binding's credential reference. */
export const giteeForgeAdapter: ForgeAdapter = {
  provider: 'gitee',
  capabilities: GITEE_CAPABILITIES,
  presentation: {
    issueUrl: (repository, number) => `${repository.webUrl}/issues/${encodeURIComponent(number)}`,
    pullUrl: (repository, number) => `${repository.webUrl}/pulls/${encodeURIComponent(number)}`,
    accountUrl: login => `https://gitee.com/${login}`,
  },
  async resolveRepository(input: ForgeResolveInput, environment: ForgeSetupEnvironment): Promise<ForgeResolution | undefined> {
    const config = GiteeAccountsSchema.parse(input.config ?? {})
    if (!config.repository) return undefined
    const token = tokenOf(environment, config.tokenEnv)
    const user = await request('/user', GiteeUserSchema, { signal: environment.signal, fetch: environment.fetch }, token).then(result => result.value)
      .catch((error: unknown) => {
        if (error instanceof ForgeHttpError && (error.status === 401 || error.status === 403)) throw new SetupError('giteeTokenRejected', { output: error.message })
        throw error
      })
    const repository = await request(`/repos/${config.repository}`, GiteeRepositorySchema, { signal: environment.signal, fetch: environment.fetch }, token)
      .then(result => result.value).catch((error: unknown) => {
        throw new SetupError(error instanceof ForgeHttpError && error.status === 404 ? 'giteeRepositoryUnreadable' : 'giteeRepositoryUnreported',
          { account: user.login, repository: config.repository, output: error instanceof Error ? error.message : String(error) })
      })
    const push = repository.permission?.push === true
    if (!push) throw new SetupError('giteeRepositoryReadOnly', { account: user.login, repository: repository.full_name })
    return {
      repository: { providerRepositoryId: String(repository.id), slug: repository.full_name, webUrl: pageUrl(repository.html_url),
        defaultBranch: repository.default_branch ?? '' },
      identity: { providerUserId: String(user.id ?? user.login), login: user.login, ...user.name ? { name: user.name } : {} },
      push,
      capabilities: { ...GITEE_CAPABILITIES, repository: push ? 'read-write' : 'read' },
      credential: { reference: config.tokenEnv },
    }
  },
  async listIssues(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgeIssue>> {
    const path = `/repos/${binding.slug}/issues?state=all&sort=updated&direction=asc&${listQuery(query)}`
    const { value, headers } = await request(path, z.array(GiteeIssueSchema), context)
    const items = value.map(mapIssue)
    const next = nextPage(headers, pageOf(query.cursor), items.length, Math.min(query.limit ?? PAGE_SIZE, PAGE_SIZE))
    return { items, ...next ? { next } : {} }
  },
  async readIssue(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgeIssue> {
    return mapIssue((await request(`/repos/${binding.slug}/issues/${encodeURIComponent(displayNumber)}`, GiteeIssueSchema, context)).value)
  },
  async listComments(binding: RepositoryBinding, issue: ForgeIssue, query: ForgeReadQuery, context: ForgeReadContext):
    Promise<ForgePage<ForgeComment>> {
    // Gitee's comment endpoint applies `since` strictly after the timestamp, which drops a comment updated at exactly that
    // time; read the page and apply the cursor's inclusive comparison here instead.
    const { value, headers } = await request(`/repos/${binding.slug}/issues/${encodeURIComponent(issue.displayNumber)}/comments?${pageQuery(query)}`,
      z.array(GiteeCommentSchema), context)
    const items = value.map(mapComment).filter(comment => Date.parse(comment.updatedAt) >= since(query))
    const next = nextPage(headers, pageOf(query.cursor), value.length, Math.min(query.limit ?? PAGE_SIZE, PAGE_SIZE))
    return { items, ...next ? { next } : {} }
  },
  async listPulls(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgePull>> {
    const { value, headers } = await request(`/repos/${binding.slug}/pulls?state=all&sort=updated&direction=asc&${listQuery(query)}`,
      z.array(GiteePullSchema), context)
    const items = value.map(mapPull)
    const next = nextPage(headers, pageOf(query.cursor), items.length, Math.min(query.limit ?? PAGE_SIZE, PAGE_SIZE))
    return { items, ...next ? { next } : {} }
  },
  async readPull(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgePull> {
    return mapPull((await request(`/repos/${binding.slug}/pulls/${encodeURIComponent(displayNumber)}`, GiteePullSchema, context)).value)
  },
}
