/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket, type Trigger } from '../../core/index.ts'
import { IM_WORDS, sameName } from '../../infra/text.ts'
import type { ForgeReadContext } from '../../forge/ports.ts'
import { claimPull, pullThreadKey, resolvePull, ticketBranch, type PullHost } from '../../forge/pulls.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

/** The binding-scoped forge view a worker tool acts through; it carries no secret beyond the per-call read context. */
export interface ForgeToolHost extends PullHost {
  readonly context: ForgeReadContext
  /** The Issue or pull-request display number the ticket started from, which receives its result comment. */
  readonly originIssue?: string | undefined
}
export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** The forge operations of a ticket's repository binding, resolved through its Source instance and adapter. */
  readonly forge: (ticket: Ticket) => ForgeToolHost
  sendReplies(): Promise<void>
}
/** The display number of the Issue or pull request a Trigger belongs to, for the ticket's own result comment. */
export function originIssueOf(trigger: Trigger | undefined): string | undefined {
  const value = trigger?.meta.issueNumber ?? trigger?.meta.number
  return value === undefined || value === null || value === '' ? undefined : String(value)
}
const marker = (ticketId: string, key: string): string => `<!-- dsh-superagent:ticket:${ticketId}:${key} -->`
const pullSummary = (pull: Awaited<ReturnType<typeof resolvePull>>) => ({ native_id: pull.nativeId, display_number: pull.displayNumber,
  state: pull.state, web_url: pull.webUrl, head: pull.head.ref, base: pull.base.ref, author: pull.author.login,
  ...pull.mergedAt ? { merged_at: pull.mergedAt } : {} })
/** Reads every page of a comment list up to a bounded number of pages. */
async function comments(host: ForgeToolHost, issue: string, context: ForgeReadContext) {
  const items = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await host.adapter.listComments(host.binding, { displayNumber: issue }, { cursor, limit: 100 }, context)
    items.push(...result.items)
    if (!result.next || result.next === cursor) break
    cursor = result.next
  }
  return items
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_pull_request',
      description: 'Create, read, or claim a pull request through the ticket binding. Push the branch before create. A claim uses the native PR ID and refuses another repository, account, or active ticket.',
      schema: z.object({
        operation: z.enum(['create', 'read', 'claim']).describe('create opens a PR; read reads one; claim binds one to this ticket.'),
        title: z.string().trim().min(1).max(300).optional().describe('create: PR title'),
        body: z.string().max(20000).optional().describe('create: PR description'),
        head: z.string().trim().min(1).optional().describe('create: pushed branch ending in DSH_SUPERAGENT_NAME'),
        base: z.string().trim().min(1).optional().describe('create: base branch; defaults to the binding default'),
        native_id: z.string().min(1).optional().describe('read/claim: immutable native PR ID'),
        display_number: z.string().min(1).optional().describe('read/claim: display number, such as 42'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended; do not resume it')
        const forge = host.forge(current)
        const context = { ...forge.context, signal }
        if (args.operation === 'create') {
          if (!forge.adapter.capabilities.pulls.create) throw new Error(`${forge.binding.provider} does not support creating pull requests`)
          if (!args.title || !args.head) throw new Error('create needs title and head')
          if (!ticketBranch(current, args.head)) throw new Error(`The head branch must end with the ticket name ${current.execution?.name ?? ''}`)
          const base = args.base ?? forge.binding.defaultBranch
          if (!base) throw new Error('create needs base: the binding has no default branch')
          const pull = await forge.adapter.createPull(forge.binding, { title: args.title, body: args.body ?? '', head: args.head, base }, context)
          const refused = host.store.atomic(() => claimPull(forge, ticketId, pull))
          if (refused) throw new Error(refused)
          return { ...pullSummary(pull), claimed: true }
        }
        const pull = await resolvePull(forge, { nativeId: args.native_id, displayNumber: args.display_number }, context)
        if (args.operation === 'read') return { ...pullSummary(pull), claimed: pull.state === 'open'
          && (current.follows ?? []).some(item => item.thread === pullThreadKey(forge, pull) && !item.closed) }
        const refused = host.store.atomic(() => claimPull(forge, ticketId, pull))
        if (refused) throw new Error(refused)
        return { ...pullSummary(pull), claimed: true }
      },
    }),
    tool({
      name: 'orchestrator_comment',
      description: 'Write one idempotent comment on the Issue this ticket started from. Repeating a key returns the existing comment.',
      schema: z.object({
        text: z.string().trim().min(1).max(20000).describe('Markdown comment'),
        key: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/, 'letters, digits, _, . and -').default('result')
          .describe('Stable key per distinct status'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended; do not resume it')
        const forge = host.forge(current)
        const context = { ...forge.context, signal }
        if (!forge.adapter.capabilities.issues.comment) throw new Error(`${forge.binding.provider} does not support Issue comments`)
        const issue = forge.originIssue
        if (!issue) throw new Error('This ticket did not start from an Issue or pull request that can receive a comment')
        const id = marker(ticketId, args.key)
        const existing = (await comments(forge, issue, context)).find(comment => comment.body.includes(id) && sameName(comment.author.login, forge.login))
        if (existing) return { comment_id: existing.nativeId, url: existing.webUrl ?? '', reused: true }
        const created = await forge.adapter.createComment(forge.binding, { displayNumber: issue }, `${args.text}\n\n${id}`, context)
        return { comment_id: created.nativeId, url: created.webUrl ?? '', reused: false }
      },
    }),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe('The ticket\'s PR display number: its source PR, or one by the agent account in the ticket\'s repository from a branch named after this ticket (DSH_SUPERAGENT_NAME).'),
        pr_native_id: z.string().min(1).optional().describe('The ticket\'s PR by immutable provider-native ID, as orchestrator_pull_request returns it.'),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // Only a reported PR needs the repository binding; a repository-less ticket can still report its work.
        const forge = args.pr_number != null || args.pr_native_id !== undefined ? host.forge(current) : undefined
        const pull = forge ? await resolvePull(forge, { nativeId: args.pr_native_id, displayNumber: args.pr_number != null ? String(args.pr_number) : undefined },
          { ...forge.context, signal }) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && forge ? claimPull(forge, ticketId, pull) : undefined
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
