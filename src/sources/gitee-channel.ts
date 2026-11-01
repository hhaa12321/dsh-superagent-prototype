/** Gitee outbound Channel: posts acknowledgements and results as idempotent comments on the Issue or pull request. */
import type { OutboundMessage } from '../core/index.ts'
import { giteeForgeAdapter, ForgeHttpError } from '../forge/gitee.ts'
import type { ForgeComment, ForgeReadContext } from '../forge/ports.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'

/** A permanently gone or locked target can never receive the message; other failures let the Outbox retry. */
const gone = (error: unknown): boolean => error instanceof ForgeHttpError
  && (error.status === 410 || (error.status === 403 && /locked/i.test(error.message)))
/** Reads every page of the target's conversation so an earlier attempt's marker is found after a crash or restart. */
async function comments(host: Pick<SourceContext, 'commands'>, number: string, context: ForgeReadContext): Promise<ForgeComment[]> {
  const binding = host.commands.repository
  if (!binding) throw new Error(`Gitee Channel has no repository binding`)
  const items: ForgeComment[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await giteeForgeAdapter.listComments(binding, { displayNumber: number }, { cursor, limit: 100 }, context)
    items.push(...result.items)
    if (!result.next || result.next === cursor) break
    cursor = result.next
  }
  return items
}
/**
 * Posts a message through the Gitee Issue or PR comment API with an embedded HTML marker, so the Outbox's retries and a
 * restart after a successful post do not create a second comment. The token comes from the host process through the
 * binding's credential reference and is never logged or persisted here.
 */
export async function sendGitee(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const binding = host.commands.repository
  if (!binding) throw new Error(`Gitee Channel ${message.channel.thread} has no repository binding`)
  const credential = host.commands.deployment.giteeCredentials[binding.credentialId]
  if (!credential) throw new Error(`Repository ${binding.id} has no resolved Gitee credential`)
  const token = process.env[credential.tokenEnv]
  if (!token) throw new Error(`The Gitee credential ${credential.tokenEnv} is not set in the dsh-superagent process`)
  const number = message.channel.address.number
  if (!number) throw new Error('Missing Gitee reply target')
  const context: ForgeReadContext = { token }
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    if ((await comments(host, number, context)).some(comment => comment.body.includes(marker))) return 'sent'
    await giteeForgeAdapter.createComment(binding, { displayNumber: number }, `${message.text}\n\n${marker}`, context)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The Gitee page a Channel address names, distinguishing a pull request from an Issue. */
export function giteeLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const pull = address.isPr === 'true'
  const url = address.url ?? (links.repository ? `https://gitee.com/${links.repository}/${pull ? 'pulls' : 'issues'}/${number}` : '')
  return { url, label: pull ? { zh: `Gitee PR #${number}`, en: `Gitee PR #${number}` }
    : { zh: `Gitee Issue #${number}`, en: `Gitee Issue #${number}` } }
}
