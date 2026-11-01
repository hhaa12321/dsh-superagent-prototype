/** Provider-neutral pull-request resolution and claim rules shared by worker tools and forge Sources. */
import type { Ticket, ThreadRef, Trigger } from '../core/index.ts'
import type { RepositoryBinding } from '../repository.ts'
import { sameName } from '../infra/text.ts'
import type { ForgeAdapter, ForgePull, ForgeReadContext } from './ports.ts'

/** The binding, Source instance, and resolved account a pull-request operation runs under. */
export interface PullHost {
  readonly binding: RepositoryBinding
  readonly adapter: ForgeAdapter
  readonly sourceId: string
  /** The binding credential's provider login, which distinguishes an agent-authored pull request from another's. */
  readonly login: string
  readonly tickets: {
    get(id: string): Ticket | undefined
    open(): Ticket[]
    bindThread(id: string, thread: ThreadRef, own: boolean): void
  }
  readonly threads: { patch(key: string, meta: Record<string, unknown>): void }
  readonly triggers: { get(id: string): Trigger | undefined }
}
/** How a caller names the pull request it means: its display number, its immutable native ID, or both. */
export interface PullTarget { nativeId?: string | undefined; displayNumber?: string | undefined }
/** Whether a branch belongs to a ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/** The Thread key a pull request is followed by under its binding's Source instance. */
export const pullThreadKey = (host: Pick<PullHost, 'adapter' | 'sourceId'>, pull: ForgePull): string =>
  `${host.sourceId}:${host.adapter.pullThreadId(pull)}`
/** The immutable native pull-request ID a followed Thread names, for a provider whose Thread part is `pull:<native ID>`. */
export const nativePullId = (thread: string): string | undefined => /(?:^|:)pull:([^:]+)$/.exec(thread)?.[1]
/**
 * Reads the pull request a target names. A display number is read directly; a native ID alone pages the binding's pull
 * requests, which is the only lookup a provider whose detail endpoint takes the display number offers.
 */
export async function resolvePull(host: Pick<PullHost, 'binding' | 'adapter'>, target: PullTarget, context: ForgeReadContext): Promise<ForgePull> {
  if (target.displayNumber) {
    const pull = await host.adapter.readPull(host.binding, target.displayNumber, context)
    if (target.nativeId !== undefined && pull.nativeId !== target.nativeId) {
      throw new Error(`Pull request #${target.displayNumber} in ${host.binding.slug} is ${pull.nativeId}, not the claimed ${target.nativeId}`)
    }
    return pull
  }
  const nativeId = target.nativeId
  if (!nativeId) throw new Error('Name the pull request by its native ID or display number')
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await host.adapter.listPulls(host.binding, { cursor, limit: 100 }, context)
    const found = result.items.find(item => item.nativeId === nativeId)
    if (found) return found
    if (!result.next || result.next === cursor) break
    cursor = result.next
  }
  throw new Error(`No pull request ${nativeId} exists in ${host.binding.slug}`)
}
/**
 * Validates and binds an open pull request to a ticket. A claim uses the binding and the pull request's immutable native
 * ID: it refuses a ticket of another binding, a pull request whose repository facts name another repository, a pull
 * request by an account other than the binding's unless it is the verified source pull request, and a pull request that
 * another open ticket already follows.
 * @returns a refusal for a person to read, or undefined when the pull request is bound or is not open (which is no error).
 */
export function claimPull(host: PullHost, ticketId: string, pull: ForgePull): string | undefined {
  const ticket = host.tickets.get(ticketId)
  if (!ticket) return 'Ticket ended because its PR was closed'
  if (ticket.ended) return 'Ticket ended because its PR was closed'
  if ((ticket.repositoryId ?? null) !== host.binding.id) {
    return `PR belongs to repository ${host.binding.id}, but this ticket belongs to ${ticket.repositoryId ?? 'no repository'}; a PR cannot be claimed across repository bindings`
  }
  // The base repository is the binding's own; a source PR may legitimately come from a fork, which the author and branch
  // checks reject for an agent-opened PR below.
  const other = pull.base.repositoryId !== undefined && pull.base.repositoryId !== host.binding.providerRepositoryId
    || pull.base.repositorySlug !== undefined && !sameName(pull.base.repositorySlug, host.binding.slug)
  if (other) return 'PR does not belong to this ticket: its repository is not the ticket\'s repository binding'
  const source = host.triggers.get(ticket.origin.triggerId)
  const started = source?.source === host.sourceId && (source.repositoryId ?? null) === host.binding.id && source.meta.isPr === true
    && (String(source.meta.nativeId ?? '') === pull.nativeId || String(source.meta.number ?? '') === pull.displayNumber)
  const opened = sameName(pull.author.login, host.login) && ticketBranch(ticket, pull.head.ref)
    && (!pull.head.repositorySlug || sameName(pull.head.repositorySlug, host.binding.slug))
  if (!started && !opened) {
    return `PR does not belong to this ticket: use the source PR or a PR by ${host.login} in ${host.binding.slug} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const thread = pullThreadKey(host, pull)
  const owner = host.tickets.open().filter(item => (item.repositoryId ?? null) === host.binding.id)
    .find(item => item.follows?.some(follow => follow.thread === thread && !follow.closed) === true)
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === thread)
  if (pull.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) {
    host.tickets.bindThread(ticketId, { source: host.sourceId, id: host.adapter.pullThreadId(pull), repositoryId: host.binding.id }, opened)
  }
  // The Thread keeps the native identity and the display facts a later poll needs without guessing from a number.
  host.threads.patch(thread, { number: pull.displayNumber, nativeId: pull.nativeId, isPr: true, url: pull.webUrl, prAuthor: pull.author.login })
  return undefined
}
