/**
 * Gitee Source kind: reads one bound repository's Issues, their comments, and pull requests through the Gitee forge adapter,
 * ingests them as repository-scoped Triggers, follows the pull requests its Tickets claim, and reports source-instance health.
 */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { escapeRegExp } from '../infra/text.ts'
import { z } from 'zod'
import type { RepositoryBinding } from '../repository.ts'
import type { ForgeComment, ForgeIssue, ForgePage, ForgePull, ForgeReadContext } from '../forge/ports.ts'
import { giteeForgeAdapter } from '../forge/gitee.ts'
import { nativePullId } from '../forge/pulls.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { giteeLink, sendGitee } from './gitee-channel.ts'
import type { Localized, SourceKind } from './kind.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollFailure } from './poll.ts'

export const GiteeConfigSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  /** The environment variable that holds the token; the token itself never enters settings, logs, or the database. */
  tokenEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'an environment variable name').default('GITEE_TOKEN'),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observePulls: z.boolean().default(false),
}).strict()
export type GiteeConfig = z.infer<typeof GiteeConfigSchema>
type Scope = 'issues' | 'comments' | 'pulls'
const OBSERVED: Record<Scope, 'observeIssues' | 'observeComments' | 'observePulls'> =
  { issues: 'observeIssues', comments: 'observeComments', pulls: 'observePulls' }
/** The receiving-scope row a Gitee event belongs to, matching the Policy's admission table. */
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'comment' ? 'comments' : undefined
}
/** A Gitee account mentioned in text as `@login`, the Source's own addressing convention. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const threadRef = (ref: GiteeRef, id: string) => ({ source: ref.sourceId, id, repositoryId: ref.repositoryId })
/** Where a Gitee Issue or pull request can receive a reply; `isPr` selects the pull-request page and label. */
const channelRef = (ref: GiteeRef, threadId: string, number: string, url: string, isPr = false) => ({ source: ref.sourceId,
  thread: `${ref.sourceId}:${threadId}`, address: { number, ...(url ? { url } : {}), ...(isPr ? { isPr: 'true' } : {}) }, repositoryId: ref.repositoryId })
/** The Source instance and repository binding a Gitee event belongs to. */
export interface GiteeRef { sourceId: string; repositoryId: string }
/** Builds the Trigger of a newly opened or newly updated Issue; its identity is Gitee's immutable numeric Issue ID. */
export function giteeIssueTrigger(issue: ForgeIssue, agent: string, ref: GiteeRef): Trigger {
  return { id: key('gitee-issue', ref.sourceId, ref.repositoryId, issue.nativeId), source: ref.sourceId, repositoryId: ref.repositoryId,
    threads: [threadRef(ref, issue.threadId)], actor: { source: ref.sourceId, id: issue.author.login },
    human: !sameName(issue.author.login, agent), at: issue.createdAt, text: `${issue.title}\n\n${issue.body}`,
    ...mentions(`${issue.title}\n${issue.body}`, agent) ? { addressed: 'mention' as const } : {}, url: issue.webUrl,
    channel: channelRef(ref, issue.threadId, issue.displayNumber, issue.webUrl),
    meta: { kind: 'issue', number: issue.displayNumber, nativeId: issue.nativeId, threadId: issue.threadId, provider: 'gitee',
      ...sameName(issue.author.login, agent) ? { self: true } : {} } }
}
/** Builds the Trigger of one comment; its identity is Gitee's native comment ID, never a position in the list. */
export function giteeCommentTrigger(comment: ForgeComment, issue: ForgeIssue, agent: string, ref: GiteeRef): Trigger {
  return { id: key('gitee-comment', ref.sourceId, ref.repositoryId, comment.nativeId), source: ref.sourceId, repositoryId: ref.repositoryId,
    threads: [threadRef(ref, issue.threadId)], actor: { source: ref.sourceId, id: comment.author.login },
    human: !sameName(comment.author.login, agent), at: comment.updatedAt, text: comment.body,
    ...mentions(comment.body, agent) ? { addressed: 'mention' as const } : {}, ...comment.webUrl ? { url: comment.webUrl } : { url: issue.webUrl },
    channel: channelRef(ref, issue.threadId, issue.displayNumber, issue.webUrl),
    meta: { kind: 'comment', number: issue.displayNumber, nativeId: issue.nativeId, threadId: issue.threadId, commentId: comment.nativeId,
      issueNumber: issue.displayNumber, issueNativeId: issue.nativeId, provider: 'gitee',
      ...sameName(comment.author.login, agent) ? { self: true } : {} } }
}
/** Builds the Trigger of a pull request's description; its Thread identity keeps the PR's numeric ID apart from Issue IDs. */
export function giteePullTrigger(pull: ForgePull, agent: string, ref: GiteeRef): Trigger {
  const thread = `pull:${pull.nativeId}`
  return { id: key('gitee-pull', ref.sourceId, ref.repositoryId, pull.nativeId), source: ref.sourceId, repositoryId: ref.repositoryId,
    threads: [threadRef(ref, thread)], actor: { source: ref.sourceId, id: pull.author.login }, human: !sameName(pull.author.login, agent),
    at: pull.createdAt, text: `${pull.title}\n\n${pull.body}`, ...mentions(`${pull.title}\n${pull.body}`, agent) ? { addressed: 'mention' as const } : {},
    url: pull.webUrl, channel: channelRef(ref, thread, pull.displayNumber, pull.webUrl, true),
    meta: { kind: 'pull', number: pull.displayNumber, nativeId: pull.nativeId, threadId: thread, isPr: true, provider: 'gitee',
      ...sameName(pull.author.login, agent) ? { self: true } : {} } }
}
/** Builds the Trigger of a comment on a claimed pull request, keeping its own native comment identity. */
export function giteePullCommentTrigger(comment: ForgeComment, pull: ForgePull, agent: string, ref: GiteeRef): Trigger {
  const thread = `pull:${pull.nativeId}`
  return { id: key('gitee-pull-comment', ref.sourceId, ref.repositoryId, pull.nativeId, comment.nativeId), source: ref.sourceId,
    repositoryId: ref.repositoryId, threads: [threadRef(ref, thread)], actor: { source: ref.sourceId, id: comment.author.login },
    human: !sameName(comment.author.login, agent), at: comment.updatedAt, text: comment.body,
    ...mentions(comment.body, agent) ? { addressed: 'mention' as const } : {}, ...comment.webUrl ? { url: comment.webUrl } : { url: pull.webUrl },
    channel: channelRef(ref, thread, pull.displayNumber, pull.webUrl, true),
    meta: { kind: 'pull-comment', number: pull.displayNumber, nativeId: pull.nativeId, threadId: thread, commentId: comment.nativeId, isPr: true,
      provider: 'gitee', ...sameName(comment.author.login, agent) ? { self: true } : {} } }
}

export const giteeKind: SourceKind<GiteeConfig> = {
  kind: 'gitee',
  repositoryBound: true,
  title: { zh: 'Gitee', en: 'Gitee' },
  description: { zh: '一个 Gitee 仓库的来源：接收发给智能体的 Issue、评论和新 PR，把它们保存为仓库范围内的触发与对话，并在该仓库里运行工单、创建 PR、写评论。',
    en: 'A Source for one Gitee repository: receives Issues, comments, and new pull requests addressed to the agent, stores them as repository-scoped Triggers and Threads, and runs Tickets there, opening pull requests and writing comments.' },
  schema: GiteeConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name，例如 bourneW/dsh-superagent-gitee-canary。保存时用凭据引用解析的令牌检查仓库与推送权限，然后重启 dsh-superagent；仓库改名但 Gitee 仓库 ID 不变时仍可保存，改到另一个仓库请新增来源。',
        en: 'Written owner/name, such as bourneW/dsh-superagent-gitee-canary. Saving checks the repository and push access with the token its credential reference names, then restarts dsh-superagent. A rename that keeps Gitee\'s repository ID is allowed; switching to another repository needs a new Source.' } },
    { key: 'tokenEnv', type: 'text', pattern: '[A-Z][A-Z0-9_]*', label: { zh: '令牌的环境变量名', en: 'Token environment variable' },
      hint: { zh: '只写变量名（默认 GITEE_TOKEN），令牌由运行 dsh-superagent 的进程持有；它不会被保存、写进日志或传给工人子进程。',
        en: 'The variable name only (default GITEE_TOKEN). The token stays in the process that runs dsh-superagent; it is never saved, logged, or passed to worker subprocesses.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。',
        en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。评论里的 @ 总会收到。',
        en: 'Comments on Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. A mention in a comment is always received.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到。工单认领的 PR 无论这个开关如何，都会观察它的状态和评论。',
        en: 'New pull requests that do not mention the agent are received too. A pull request a Ticket claims is observed for its state and comments whatever this switch says.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitee'],
  channel: { send: sendGitee, link: giteeLink },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitee 账号', en: 'Gitee accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GiteeConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      return (['issues', 'comments', 'pulls'] as const).map(id => ({ id, label: id === 'issues' ? { zh: '新 Issue', en: 'New Issues' }
        : id === 'comments' ? { zh: '评论', en: 'Comments' } : { zh: '新 PR', en: 'New pull requests' }, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } }))
    },
  },
}
export { giteeKind as kind }

/** The credential of this instance's binding, and the token the host process holds for it; neither is persisted here. */
function credentialOf(ctx: SourceContext, binding: RepositoryBinding): { credential: { login: string; tokenEnv: string }; token: string } {
  const credential = ctx.deployment.giteeCredentials[binding.credentialId]
  if (!credential) throw new Error(`Repository ${binding.id} has no resolved Gitee credential ${binding.credentialId}`)
  const token = process.env[credential.tokenEnv]
  if (!token) throw new Error(`The Gitee credential ${credential.tokenEnv} is not set in the dsh-superagent process`)
  return { credential, token }
}
/**
 * One poll of an enabled Gitee Source: reads its binding's Issues, comments, and pull requests from persisted cursors. A
 * disabled Source takes in nothing new, but still observes the pull requests of the open Tickets it accepted, so a merge
 * or close can end them.
 */
export async function pollWhenEnabled(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  if (!ctx.config<GiteeConfig>()) {
    if (!ctx.repository) { ctx.report('gitee', health('paused', 'sourceOff')); return 60 }
    // A Source disabled before setup resolved a binding has nothing to observe.
    const binding = ctx.repository
    const { credential, token } = credentialOf(ctx, binding)
    const started = new Date().toISOString()
    try { await pollTicketPulls(ctx, binding, credential.login, { signal, token }, started, () => !!signal?.aborted) }
    catch (error) { if (!signal?.aborted) throw error }
    ctx.report('gitee', health('paused', 'sourceOff'))
    return 60
  }
  // A failed setup leaves this binding unresolved; its card states the problem and this loop reads nothing.
  if (!ctx.repository) { ctx.report('gitee', health('paused', 'setupPending')); return 60 }
  return pollRound(ctx, signal)
}
/**
 * Reads the bound repository from its stream cursors and ingests each new or updated Issue, its comments, and new pull
 * requests. Trigger IDs derive from native IDs, so overlapping cursors and restarts never produce a duplicate Trigger.
 * A failed read leaves its stream cursor where it was for the next round.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const config = ctx.config<GiteeConfig>()
  if (!config) return 60
  const binding = ctx.repository
  if (!binding) throw new Error(`Gitee Source ${ctx.sourceId} has no repository binding`)
  const { credential, token } = credentialOf(ctx, binding)
  const started = new Date().toISOString()
  const context: ForgeReadContext = { signal, token }
  const ref: GiteeRef = { sourceId: ctx.sourceId, repositoryId: binding.id }
  const counts = { issues: 0, comments: 0, pulls: 0 }
  const failures: string[] = []
  const stopped = () => !!signal?.aborted || !ctx.config<GiteeConfig>()
  const issuesKey = KV.gitee.stream(ctx.sourceId, binding.id, 'issues')
  const since = ctx.state.get(issuesKey)?.since ?? cursorAt(started)
  const cursor = cursorAt(started)
  const issues = await pages(next => giteeForgeAdapter.listIssues(binding, { since, cursor: next }, context))
  for (const issue of issues) {
    if (stopped()) throw new Error('The Gitee Source stopped during the poll')
    try {
      // The Issue's own event is emitted once per native ID; a later comment changes updated_at, not that identity.
      // The account's own events are recorded as non-human facts, never dropped silently and never able to authorize work.
      if (Date.parse(issue.createdAt) >= Date.parse(since)
        && (config.observeIssues || mentions(`${issue.title}\n${issue.body}`, credential.login))) {
        await ctx.receive(giteeIssueTrigger(issue, credential.login, ref))
        counts.issues += 1
      }
      await nameThread(ctx, issue)
      counts.comments += await readComments(ctx, binding, issue, config, credential.login, ref, context, stopped)
      ctx.state.set(KV.gitee.issue(ctx.sourceId, binding.id, issue.threadId), { since: cursor })
    } catch (error) {
      if (stopped()) throw error
      failures.push(`${issue.displayNumber}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!failures.length) ctx.state.set(issuesKey, { since: cursor })
  const prKey = KV.gitee.stream(ctx.sourceId, binding.id, 'pulls')
  if (!config.observePulls) ctx.state.set(prKey, undefined)
  else {
    const prSince = ctx.state.get(prKey)?.since ?? since
    try {
      const pulls = await pages(next => giteeForgeAdapter.listPulls(binding, { since: prSince, cursor: next }, context))
      for (const pull of pulls) {
        if (stopped()) throw new Error('The Gitee Source stopped during the poll')
        if (Date.parse(pull.createdAt) < Date.parse(prSince) || !(config.observePulls || mentions(`${pull.title}\n${pull.body}`, credential.login))) continue
        await ctx.receive(giteePullTrigger(pull, credential.login, ref))
        ctx.threads.describe(`${ctx.sourceId}:pull:${pull.nativeId}`, { label: `#${pull.displayNumber} ${pull.title}`,
          facts: { number: { value: `#${pull.displayNumber}` }, provider: { value: 'Gitee' } } })
        counts.pulls += 1
      }
      ctx.state.set(prKey, { since: cursor })
    } catch (error) {
      if (stopped()) throw error
      failures.push(`pull requests: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Claimed pull requests are observed for every open Ticket, whether or not new PRs are received at all.
  let claimed = 0
  try { claimed = await pollTicketPulls(ctx, binding, credential.login, context, started, stopped) }
  catch (error) {
    if (stopped()) throw error
    failures.push(`claimed pull requests: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (failures.length) throw new Error(`${failures.length} Gitee reads failed: ${failures.slice(0, 3).join('; ')}`)
  ctx.report('gitee', { state: 'ready', detail: `${counts.issues} new Issues, ${counts.comments} comments, ${counts.pulls} pull requests`
    + `${claimed ? `, ${claimed} claimed pull-request updates` : ''}; next poll ≥ ${config.pollSeconds}s`, at: started })
  return Math.max(60, config.pollSeconds)
}
/**
 * Observes the pull requests open Tickets of this binding follow: their provider state, which ends the correct Ticket on
 * merge or close, and their conversation and code comments, which arrive as Triggers on the PR Thread. The Thread key keeps
 * the provider-native PR ID, and its stored display number is what Gitee's detail endpoint takes; both survive a restart.
 */
async function pollTicketPulls(ctx: SourceContext, binding: RepositoryBinding, login: string, context: ForgeReadContext, started: string,
  stopped: () => boolean): Promise<number> {
  let updates = 0
  let failures = 0
  const seen = new Set<string>()
  const ref: GiteeRef = { sourceId: ctx.sourceId, repositoryId: binding.id }
  for (const ticket of ctx.tickets.open().filter(item => (item.repositoryId ?? null) === binding.id)) {
    for (const follow of ticket.follows ?? []) {
      if (follow.closed || stopped()) continue
      const nativeId = nativePullId(follow.thread)
      if (!nativeId || seen.has(nativeId)) continue
      seen.add(nativeId)
      const thread = ctx.threads.get(follow.thread)
      try {
        const display = thread?.meta.number === undefined ? '' : String(thread.meta.number)
        if (!display) throw new Error(`Thread ${follow.thread} has no pull-request display number`)
        const pull = await giteeForgeAdapter.readPull(binding, display, context)
        if (pull.nativeId !== nativeId) throw new Error(`Pull request #${display} is ${pull.nativeId}, not the claimed ${nativeId}`)
        ctx.threads.patch(follow.thread, { number: pull.displayNumber, nativeId: pull.nativeId, isPr: true, url: pull.webUrl, prAuthor: pull.author.login })
        ctx.threads.describe(follow.thread, { facts: { state: { value: pull.state } } })
        if (pull.state !== 'open') {
          // Gitee reports a merged pull request as `merged`, or as `closed` with `merged_at`; both end the Ticket as merged.
          const outcome = pull.state === 'merged' ? 'merged' : 'closed'
          ctx.tickets.threadClosed({ source: ctx.sourceId, id: follow.thread.slice(follow.thread.indexOf(':') + 1), repositoryId: binding.id },
            outcome, pull.mergedAt ?? pull.closedAt ?? started)
          updates += 1
          continue
        }
        const cursorKey = KV.gitee.pull(ctx.sourceId, binding.id, follow.thread.slice(follow.thread.indexOf(':') + 1))
        const since = ctx.state.get(cursorKey)?.since ?? thread?.createdAt ?? started
        // Gitee exposes a PR's conversation and diff comments only through its pull-request comment endpoint; the Issue
        // comment endpoint takes Issue numbers and answers 404 for a PR display number. Read that stream and deduplicate
        // by the native comment ID, which also covers a page overlap.
        const listed = await pages(next => giteeForgeAdapter.listPullComments(binding, pull, { since, cursor: next }, context))
        const comments = new Map<string, ForgeComment>()
        for (const comment of listed) comments.set(comment.nativeId, comment)
        for (const comment of comments.values()) {
          if (stopped()) throw new Error('The Gitee Source stopped during the poll')
          if (Date.parse(comment.updatedAt) < Date.parse(since) || sameName(comment.author.login, login)) continue
          await ctx.receive(giteePullCommentTrigger(comment, pull, login, ref))
          updates += 1
        }
        ctx.state.set(cursorKey, { since: cursorAt(started) })
        ctx.threads.patch(follow.thread, { pollError: undefined })
      } catch (error) {
        if (stopped()) throw error
        failures += 1
        ctx.threads.patch(follow.thread, { pollError: String(error) })
      }
    }
  }
  if (failures) throw new Error(`${failures} claimed pull-request reads failed`)
  return updates
}
/** Reads one Issue's comments since its own cursor; returns how many were ingested. */
async function readComments(ctx: SourceContext, binding: RepositoryBinding, issue: ForgeIssue, config: GiteeConfig, agent: string, ref: GiteeRef,
  context: ForgeReadContext, stopped: () => boolean): Promise<number> {
  const key = KV.gitee.issue(ctx.sourceId, binding.id, issue.threadId)
  const since = ctx.state.get(key)?.since ?? issue.updatedAt
  const comments = await pages(next => giteeForgeAdapter.listComments(binding, issue, { since, cursor: next }, context))
  let count = 0
  for (const comment of comments) {
    if (stopped()) throw new Error('The Gitee Source stopped during the poll')
    if (Date.parse(comment.updatedAt) < Date.parse(since)) continue
    if (!config.observeComments && !mentions(comment.body, agent)) continue
    await ctx.receive(giteeCommentTrigger(comment, issue, agent, ref))
    count += 1
  }
  return count
}
/** Reads every page a list port offers, bounded so one runaway pagination cannot hold the poll forever. */
async function pages<T>(read: (cursor: string | undefined) => Promise<ForgePage<T>>): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await read(cursor)
    items.push(...result.items)
    if (!result.next || result.next === cursor) break
    cursor = result.next
  }
  return items
}
/** Publishes the repository-scoped Thread's label, display number, native ID, provider, and URL after its Trigger arrived. */
async function nameThread(ctx: SourceContext, issue: ForgeIssue): Promise<void> {
  const thread = `${ctx.sourceId}:${issue.threadId}`
  ctx.threads.patch(thread, { title: issue.title, number: issue.displayNumber, nativeId: issue.nativeId, isPr: false, url: issue.webUrl, provider: 'gitee' })
  ctx.threads.describe(thread, { label: `${issue.displayNumber} ${issue.title}`, facts: { number: { value: issue.displayNumber }, provider: { value: 'Gitee' } } })
}
/** One poll loop per configured Gitee Source instance, each bound to its own repository and cursor namespace. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitee', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteeConfig>()
    try {
      interval = await pollWhenEnabled(ctx, signal)
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitee', failed)
    }
    await pause(Math.max(interval, ctx.config<GiteeConfig>()?.pollSeconds ?? 60) * 1000, signal)
  }
}
export const name = 'dsh-superagent-gitee'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteeKind), 'gitee: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = ctx.orchestrator.ready.then(async () => {
      const instances = ctx.orchestrator.sources.instancesOfKind(giteeKind.kind)
      await Promise.all(instances.map(instance => {
        const source = sourceContext(ctx.orchestrator, giteeKind, instance.id)
        return watch(source, controller.signal).catch((error: unknown) => { source.report('gitee', { state: 'error', detail: String(error) }) })
      }))
    }).catch((error: unknown) => {
      const instance = ctx.orchestrator.sources.instancesOfKind(giteeKind.kind)[0]
      try { if (instance) sourceContext(ctx.orchestrator, giteeKind, instance.id).report('gitee', { state: 'error', detail: String(error) }) }
      catch { /* The Source is not registered (uninstalled); setup health reports its failure. */ }
    })
    return async () => { controller.abort(); await running }
  })
}
