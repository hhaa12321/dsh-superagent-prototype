/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { GithubCredential } from '../deployment.ts'
import type { RepositoryBinding } from '../repository.ts'
import { sameName } from '../infra/text.ts'
import { claimPull as claimForgePull, ticketBranch } from '../forge/pulls.ts'
import type { ForgePull } from '../forge/ports.ts'
import { githubForgeAdapter } from '../forge/github.ts'
import type { SourceContext } from './host.ts'
import { githubPage, UserSchema } from './github-trigger.ts'

export { ticketBranch } from '../forge/pulls.ts'

const PullSchema = z.looseObject({
  id: z.number().optional(), title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
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
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
/** The credential and binding governing a GitHub Source context; throws for a Source without a repository binding. */
export function pullHost(ctx: SourceContext): { sourceId: string; binding: RepositoryBinding; credential: GithubCredential } {
  const binding = ctx.repository
  if (!binding) throw new Error('The GitHub Source has no repository binding')
  const credential = ctx.deployment.credentials[binding.credentialId]
  if (!credential) throw new Error(`Repository ${binding.id} has no resolved credential ${binding.credentialId}`)
  return { sourceId: ctx.sourceId, binding, credential }
}
/** The provider-neutral record of a GitHub pull request, keeping the native ID when the read supplied it. */
export function forgePull(pr: Pull): ForgePull {
  return {
    nativeId: pr.id !== undefined ? String(pr.id) : String(pr.number), displayNumber: String(pr.number), title: pr.title ?? '', body: pr.body ?? '',
    state: pr.merged || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    author: { providerUserId: pr.user.id !== undefined ? String(pr.user.id) : pr.user.login, login: pr.user.login,
      ...pr.user.type === 'Bot' ? { bot: true } : {} },
    createdAt: pr.created_at ?? '', updatedAt: pr.closed_at ?? pr.created_at ?? '', ...pr.merged_at ? { mergedAt: pr.merged_at } : {},
    ...pr.closed_at ? { closedAt: pr.closed_at } : {}, webUrl: pr.html_url, head: { ref: pr.head.ref, sha: pr.head.sha,
      ...pr.head.repo?.full_name ? { repositorySlug: pr.head.repo.full_name } : {} }, base: { ref: '' },
  }
}
/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's
 * branch, enforcing that one PR binds to at most one open ticket and that the PR belongs to the ticket's repository binding.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const host = pullHost(ctx)
  return claimForgePull({ binding: host.binding, adapter: githubForgeAdapter, sourceId: host.sourceId, login: host.credential.login,
    tickets: ctx.tickets, threads: ctx.threads, triggers: ctx.triggers }, ticketId, forgePull(pr))
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
