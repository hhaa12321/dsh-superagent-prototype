/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { GithubCredential } from '../deployment.ts'
import type { RepositoryBinding } from '../repository.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** The native PR number encoded at the end of a followed Thread key (`<sourceId>:<number>`). */
export const pullNumber = (thread: string): number | undefined => {
  const native = thread.slice(thread.lastIndexOf(':') + 1)
  return /^[1-9]\d*$/.test(native) ? Number(native) : undefined
}
/** PR numbers a ticket follows, optionally only those of one repository binding and only while open. */
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false, repositoryId?: string): number[] =>
  (ticket.follows ?? []).filter(item => (!open || !item.closed) && (repositoryId === undefined || (item.repositoryId ?? null) === repositoryId))
    .flatMap(item => pullNumber(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>, repositoryId?: string): number | undefined =>
  pullsOf(ticket, true, repositoryId).at(-1) ?? pullsOf(ticket, false, repositoryId).at(-1)
/** True when the PR was opened by the binding's agent account from a branch in the bound repository (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  credential: Pick<GithubCredential, 'login'>, binding: Pick<RepositoryBinding, 'slug'>): boolean =>
  sameName(pr.user.login, credential.login) && sameName(pr.head?.repo?.full_name ?? '', binding.slug)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/** The credential and binding governing a GitHub Source context; throws for a Source without a repository binding. */
export function pullHost(ctx: SourceContext): { sourceId: string; binding: RepositoryBinding; credential: GithubCredential } {
  const binding = ctx.repository
  if (!binding) throw new Error('The GitHub Source has no repository binding')
  const credential = ctx.deployment.credentials[binding.credentialId]
  if (!credential) throw new Error(`Repository ${binding.id} has no resolved credential ${binding.credentialId}`)
  return { sourceId: ctx.sourceId, binding, credential }
}
/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's
 * branch, enforcing that one PR binds to at most one open ticket and that the PR belongs to the ticket's repository binding.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const { sourceId, binding, credential } = pullHost(ctx)
  if ((ticket.repositoryId ?? null) !== binding.id) {
    return `PR belongs to repository ${binding.id}, but this ticket belongs to ${ticket.repositoryId ?? 'no repository'}; a PR cannot be claimed across repository bindings`
  }
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === sourceId && source.repositoryId === binding.id && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, credential, binding) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    return `PR does not belong to this ticket: use the source PR or a PR by ${credential.login} in ${binding.slug} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().filter(item => (item.repositoryId ?? null) === binding.id)
    .find(item => pullsOf(item, true, binding.id).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${sourceId}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened, binding.id)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const { sourceId, binding, credential } = pullHost(ctx)
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr, binding.id)
  else {
    const candidates = agentPull(pr, credential, binding) ? ctx.tickets.open()
      .filter(ticket => (ticket.repositoryId ?? null) === binding.id && ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${sourceId}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true, binding.id).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`${sourceId}:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean, repositoryId: string): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: ctx.sourceId, id: String(pr.number), repositoryId }, own)
    ctx.threads.patch(`${ctx.sourceId}:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull, repositoryId: string): void {
  const thread = `${ctx.sourceId}:${pr.number}`
  if (!ctx.tickets.open().some(ticket => (ticket.repositoryId ?? null) === repositoryId && pullsOf(ticket, true, repositoryId).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: ctx.sourceId, id: String(pr.number), repositoryId }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(follow.thread)!
  const url = githubPage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so repository-bound GitHub channels are skipped.
  return ticket.channels.filter(channel => !channel.repositoryId).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
