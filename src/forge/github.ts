/**
 * GitHub behind the forge capability boundary: repository resolution and identity/access through the agent's GitHub CLI,
 * and Issue, comment, and pull-request reads through the same CLI, scoped to one RepositoryBinding.
 */
import { z } from 'zod'
import { GithubAccountsSchema } from './config.ts'
import type { RepositoryBinding } from '../repository.ts'
import { SetupError } from '../setup.ts'
import type { ForgeAdapter, ForgeActor, ForgeComment, ForgeIssue, ForgePage, ForgePull, ForgeReadContext, ForgeReadQuery, ForgeResolveInput,
  ForgeResolution, ForgeSetupEnvironment } from './ports.ts'
import type { ForgeCapabilities } from './capabilities.ts'

const GITHUB_CAPABILITIES: ForgeCapabilities = {
  repository: 'read-write', identity: true, issues: { read: true, comment: true },
  pulls: { read: true, create: true, comment: true, reviews: true }, ci: true, execution: true,
}
const GithubUserSchema = z.looseObject({ login: z.string(), id: z.number().int().positive().optional(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/** What `gh api repos/<slug> --jq` prints for repository resolution; a display name, never identity. */
const GithubRepositorySchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]),
  name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  url: z.string().url(),
  push: z.boolean().nullish(),
  default_branch: z.string().nullish(),
})
const GithubAccountSchema = z.looseObject({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const GithubIssueSchema = z.looseObject({
  id: z.number(), number: z.number().int().positive(), title: z.string(), body: z.string().nullish(), user: GithubUserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), html_url: z.string().url(), comments: z.number().nullish(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
const GithubCommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: GithubUserSchema, html_url: z.string().nullish(), created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
})
const GithubPullSchema = z.looseObject({
  id: z.number(), number: z.number().int().positive(), title: z.string(), body: z.string().nullish(), state: z.string(),
  user: GithubUserSchema, created_at: z.string(), updated_at: z.string(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  html_url: z.string().url(), head: z.looseObject({ ref: z.string(), sha: z.string() }), base: z.looseObject({ ref: z.string() }),
})

const actor = (user: { login: string; id?: number | undefined; type?: string | undefined }): ForgeActor => ({
  providerUserId: String(user.id ?? user.login), login: user.login, bot: user.type === 'Bot' || /\[bot\]$/.test(user.login),
})
/** GitHub web pages live at the repository's HTML URL without the `.git` clone suffix. */
const page = (url: string): string => url.replace(/\.git$/, '')
const sinceQuery = (since: string | undefined): string => since ? `&since=${encodeURIComponent(since)}` : ''

/** The GitHub adapter; reads require `context.commands` scoped to the binding. */
export const githubForgeAdapter: ForgeAdapter = {
  provider: 'github',
  capabilities: GITHUB_CAPABILITIES,
  presentation: {
    issueUrl: (repository, number) => `${repository.webUrl}/issues/${number}`,
    pullUrl: (repository, number) => `${repository.webUrl}/pull/${number}`,
    accountUrl: login => `https://github.com/${login}`,
  },
  async resolveRepository(input: ForgeResolveInput, environment: ForgeSetupEnvironment): Promise<ForgeResolution | undefined> {
    const config = GithubAccountsSchema.parse(input.config ?? {})
    if (!config.repository && !config.cli) return undefined
    if (!config.repository) throw new SetupError('repositoryUnset')
    if (!config.cli) throw new SetupError('agentCliUnset')
    let cli: string
    try { cli = environment.executable(config.cli) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
    const text = await environment.probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
    const account = parsed(GithubAccountSchema, text)
    if (!account) throw new SetupError('agentCliNoAccount')
    const text2 = await environment.probe([cli, 'api', `repos/${config.repository}`, '--jq',
      '{id, name: .full_name, url: .html_url, push: .permissions.push}']).catch((error: unknown) => {
      throw new SetupError('repositoryUnreadable', { account: account.login, repository: config.repository, output: reason(error) })
    })
    const repository = parsed(GithubRepositorySchema, text2)
    if (!repository) throw new SetupError('repositoryUnreported', { repository: config.repository })
    if (repository.push !== true) throw new SetupError('repositoryReadOnly', { account: account.login, repository: repository.name })
    return {
      repository: { providerRepositoryId: String(repository.id), slug: repository.name, webUrl: page(repository.url),
        defaultBranch: repository.default_branch ?? '' },
      identity: { providerUserId: String(account.id), login: account.login },
      push: true,
      capabilities: GITHUB_CAPABILITIES,
      credential: { reference: cli, commitEmail: `${account.id}+${account.login}@users.noreply.github.com` },
    }
  },
  async listIssues(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgeIssue>> {
    const commands = required(context.commands, 'GitHub')
    const items = await commands.pages(GithubIssueSchema, `issues?state=all&sort=updated&direction=asc&per_page=${limit(query)}${sinceQuery(query.since)}`)
    return { items: items.map(issue => mapIssue(issue)) }
  },
  async readIssue(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgeIssue> {
    const commands = required(context.commands, 'GitHub')
    return mapIssue(await commands.api(GithubIssueSchema, `issues/${encodeURIComponent(displayNumber)}`))
  },
  async listComments(binding: RepositoryBinding, issue: ForgeIssue, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgeComment>> {
    const commands = required(context.commands, 'GitHub')
    const items = await commands.pages(GithubCommentSchema, `issues/${encodeURIComponent(issue.displayNumber)}/comments?per_page=${limit(query)}${sinceQuery(query.since)}`)
    return { items: items.map(comment => mapComment(comment)) }
  },
  async listPulls(binding: RepositoryBinding, query: ForgeReadQuery, context: ForgeReadContext): Promise<ForgePage<ForgePull>> {
    const commands = required(context.commands, 'GitHub')
    const items = await commands.pages(GithubPullSchema, `pulls?state=all&sort=updated&direction=asc&per_page=${limit(query)}`)
    return { items: items.map(pull => mapPull(pull)) }
  },
  async readPull(binding: RepositoryBinding, displayNumber: string, context: ForgeReadContext): Promise<ForgePull> {
    const commands = required(context.commands, 'GitHub')
    return mapPull(await commands.api(GithubPullSchema, `pulls/${encodeURIComponent(displayNumber)}`))
  },
}

const limit = (query: ForgeReadQuery): number => Math.min(Math.max(query.limit ?? 100, 1), 100)
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; setup reports the failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
function required(commands: ForgeReadContext['commands'], provider: string) {
  if (!commands) throw new Error(`The ${provider} adapter reads through the binding's commands; none was supplied`)
  return commands
}
const mapIssue = (issue: z.infer<typeof GithubIssueSchema>): ForgeIssue => ({
  nativeId: String(issue.id), displayNumber: String(issue.number), threadId: String(issue.number), title: issue.title, body: issue.body ?? '',
  author: actor(issue.user), createdAt: issue.created_at, updatedAt: issue.updated_at ?? issue.created_at, webUrl: issue.html_url,
  comments: issue.comments ?? 0, pullRequest: !!issue.pull_request,
})
const mapComment = (comment: z.infer<typeof GithubCommentSchema>): ForgeComment => ({
  nativeId: String(comment.id), body: comment.body ?? '', author: actor(comment.user), createdAt: comment.created_at ?? comment.updated_at ?? '',
  updatedAt: comment.updated_at ?? comment.created_at ?? '', ...comment.html_url ? { webUrl: comment.html_url } : {},
})
const mapPull = (pull: z.infer<typeof GithubPullSchema>): ForgePull => ({
  nativeId: String(pull.id), displayNumber: String(pull.number), title: pull.title, body: pull.body ?? '',
  state: pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open', author: actor(pull.user),
  createdAt: pull.created_at, updatedAt: pull.updated_at, ...pull.merged_at ? { mergedAt: pull.merged_at } : {}, ...pull.closed_at ? { closedAt: pull.closed_at } : {},
  webUrl: pull.html_url, head: { ref: pull.head.ref, sha: pull.head.sha }, base: { ref: pull.base.ref },
})
