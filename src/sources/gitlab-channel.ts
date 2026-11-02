/** GitLab outbound Channel: posts acknowledgements and results as idempotent notes on the Issue or merge request. */
import type { OutboundMessage } from '../core/index.ts'
import { gitlabForgeAdapter } from '../forge/gitlab.ts'
import { ForgeHttpError } from '../forge/ports.ts'
import type { ForgeComment, ForgeReadContext } from '../forge/ports.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** A permanently gone or locked target can never receive the message; other failures let the Outbox retry. */
const gone = (error: unknown): boolean => error instanceof ForgeHttpError
  && (error.status === 410 || (error.status === 403 && /locked/i.test(error.message)))
/** Reads every page of the target's conversation so an earlier attempt's marker is found after a crash or restart. */
async function comments(host: Pick<SourceContext, 'commands'>, number: string, isPull: boolean, context: ForgeReadContext): Promise<ForgeComment[]> {
  const binding = host.commands.repository
  if (!binding) throw new Error(`GitLab Channel has no repository binding`)
  const items: ForgeComment[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const target = { displayNumber: number }
    const result = isPull ? await gitlabForgeAdapter.listPullComments(binding, target, { cursor, limit: 100 }, context)
      : await gitlabForgeAdapter.listComments(binding, target, { cursor, limit: 100 }, context)
    items.push(...result.items)
    if (!result.next || result.next === cursor) break
    cursor = result.next
  }
  return items
}
/**
 * Posts a message through the GitLab Issue note API with an embedded HTML marker, so the Outbox's retries and a restart
 * after a successful post do not create a second note. The token comes from the host process through the binding's
 * credential reference and is never logged or persisted here.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const binding = host.commands.repository
  if (!binding) throw new Error(`GitLab Channel ${message.channel.thread} has no repository binding`)
  const credential = host.commands.deployment.tokenCredentials[binding.credentialId]
  if (!credential) throw new Error(`Repository ${binding.id} has no resolved GitLab credential`)
  const token = process.env[credential.tokenEnv]
  if (!token) throw new Error(`The GitLab credential ${credential.tokenEnv} is not set in the dsh-superagent process`)
  const number = message.channel.address.number
  if (!number) throw new Error('Missing GitLab reply target')
  const isPull = message.channel.address.isPr === 'true'
  const context: ForgeReadContext = { token }
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    if ((await comments(host, number, isPull, context)).some(comment => comment.body.includes(marker))) return 'sent'
    const body = `${message.text}\n\n${marker}`
    if (isPull) await gitlabForgeAdapter.createPullComment(binding, { displayNumber: number }, body, context)
    else await gitlabForgeAdapter.createComment(binding, { displayNumber: number }, body, context)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The GitLab page a Channel address names, distinguishing a merge request from an Issue. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const pull = address.isPr === 'true'
  const url = address.url ?? (links.repository ? `https://gitlab.com/${links.repository}/-/${pull ? 'merge_requests' : 'issues'}/${number}` : '')
  return { url, label: pull ? { zh: `GitLab MR !${number}`, en: `GitLab MR !${number}` }
    : { zh: `GitLab Issue #${number}`, en: `GitLab Issue #${number}` } }
}
