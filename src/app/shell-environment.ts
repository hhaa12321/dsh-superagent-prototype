/** Ticket-scoped shell variables: the DSH shell tools receive the calling worker's repository binding per command. */
import type { Ticket } from '../core/index.ts'
import type { RepositoryBinding } from '../repository.ts'

/** The part of DSH's shell-env registry this plugin uses. */
interface ShellEnvRegistry {
  register(contributor: {
    name: string
    variables: Record<string, { description: string }>
    resolve(execution: { agent?: ShellAgent | undefined }): Record<string, string>
  }): () => void
}
/** The part of a DSH agent a shell execution exposes: its Session id and parent, for a subagent under a worker. */
export interface ShellAgent { session: { header: { id: string; parentSession?: string | undefined } } }
export interface ShellEnvironmentHost {
  readonly ctx: { get(name: string): unknown; agents: { get(id: string): ShellAgent | undefined } }
  /** The Ticket of a `worker-<ticketId>` Session, or undefined for the main Session and its subagents. */
  ticketOfSession(sessionId: string): Ticket | undefined
  /** The repository binding a Ticket owns, if any. */
  repositoryOf(ticket: Ticket): RepositoryBinding | undefined
  /** The account credential of a binding, when setup has resolved it. */
  credentialOf(binding: RepositoryBinding): { login: string; commitEmail: string } | undefined
  /** The Trigger a Ticket was accepted from, for its native number and whether it was a PR. */
  triggerOf(ticket: Ticket): { repositoryId?: string | null; meta: Record<string, unknown> } | undefined
}

/**
 * Registers a shell-env contributor that resolves a worker Session (or a subagent below it) to its Ticket and injects
 * `DSH_SUPERAGENT_GITHUB_REPOSITORY` and the related execution facts for that one shell command. The generated `gh` shim
 * and git credential helper read these values, so a worker bound to repository A cannot address repository B even though
 * every worker shares the same CLI account. A repository-less worker gets an empty repository value and the shim denies it.
 */
export function registerShellEnvironment(host: ShellEnvironmentHost): () => void {
  const registry = host.ctx.get('shellEnv') as ShellEnvRegistry | undefined
  if (!registry || typeof registry.register !== 'function') return () => {}
  const declare = (description: string) => ({ description })
  return registry.register({
    name: 'dsh-superagent',
    variables: {
      DSH_SUPERAGENT_TICKET: declare('The ticket id of this worker Session; empty in the main Session.'),
      DSH_SUPERAGENT_DIR: declare('The ticket directory.'),
      DSH_SUPERAGENT_NAME: declare('The ticket short name.'),
      DSH_SUPERAGENT_REPOSITORY_ID: declare('The ticket\'s RepositoryBinding; empty without one.'),
      DSH_SUPERAGENT_REPOSITORY_PROVIDER: declare('The ticket binding\'s forge, such as github or gitee.'),
      DSH_SUPERAGENT_REPOSITORY: declare('The repository binding of this ticket, owner/name.'),
      DSH_SUPERAGENT_REPOSITORY_ACCOUNT: declare('The account of this ticket binding.'),
      DSH_SUPERAGENT_REPOSITORY_COMMIT_EMAIL: declare('The commit email of this ticket binding account.'),
      DSH_SUPERAGENT_GITHUB_REPOSITORY: declare('The repository binding of this ticket, owner/name.'),
      DSH_SUPERAGENT_GITHUB_ACCOUNT: declare('The GitHub account of this ticket binding.'),
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: declare('The commit email of this ticket binding account.'),
      DSH_SUPERAGENT_GITHUB_NUMBER: declare('The Issue or PR number this ticket started from; empty otherwise.'),
      DSH_SUPERAGENT_GITHUB_PR_HEAD: declare('The head ref of this ticket\'s starting PR; empty otherwise.'),
    },
    resolve(execution): Record<string, string> {
      // The main Session is not bound to a ticket and stays unconstrained; subagents inherit their worker's binding.
      let agent = execution.agent
      for (let depth = 0; agent && depth < 20; depth++) {
        const sessionId = agent.session.header.id
        const ticket = host.ticketOfSession(sessionId)
        if (ticket) {
          const binding = host.repositoryOf(ticket)
          const credential = binding ? host.credentialOf(binding) : undefined
          const trigger = host.triggerOf(ticket)
          const own = !!binding && (trigger?.repositoryId ?? null) === binding.id
          const number = own ? Number(trigger?.meta.number) || 0 : 0
          return {
            DSH_SUPERAGENT_TICKET: ticket.id,
            DSH_SUPERAGENT_DIR: ticket.execution?.directory ?? '',
            DSH_SUPERAGENT_NAME: ticket.execution?.name ?? '',
            DSH_SUPERAGENT_REPOSITORY_ID: binding?.id ?? '',
            DSH_SUPERAGENT_REPOSITORY_PROVIDER: binding?.provider ?? '',
            DSH_SUPERAGENT_REPOSITORY: binding?.slug ?? '',
            DSH_SUPERAGENT_REPOSITORY_ACCOUNT: credential?.login ?? '',
            DSH_SUPERAGENT_REPOSITORY_COMMIT_EMAIL: credential?.commitEmail ?? '',
            DSH_SUPERAGENT_GITHUB_REPOSITORY: binding?.slug ?? '',
            DSH_SUPERAGENT_GITHUB_ACCOUNT: credential?.login ?? '',
            DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: credential?.commitEmail ?? '',
            DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
            DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '',
          }
        }
        // A worker Session whose Ticket cannot be read still gets the shell marker, so its shim denies repository access.
        if (sessionId.startsWith('worker-')) {
          return { DSH_SUPERAGENT_TICKET: sessionId.slice('worker-'.length), DSH_SUPERAGENT_DIR: '', DSH_SUPERAGENT_NAME: '',
            DSH_SUPERAGENT_REPOSITORY_ID: '', DSH_SUPERAGENT_REPOSITORY_PROVIDER: '', DSH_SUPERAGENT_REPOSITORY: '',
            DSH_SUPERAGENT_REPOSITORY_ACCOUNT: '', DSH_SUPERAGENT_REPOSITORY_COMMIT_EMAIL: '',
            DSH_SUPERAGENT_GITHUB_REPOSITORY: '', DSH_SUPERAGENT_GITHUB_ACCOUNT: '', DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '',
            DSH_SUPERAGENT_GITHUB_NUMBER: '', DSH_SUPERAGENT_GITHUB_PR_HEAD: '' }
        }
        const parent = agent.session.header.parentSession
        agent = parent ? host.ctx.agents.get(parent) : undefined
      }
      return {} as Record<string, string>
    },
  })
}
