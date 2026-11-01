/** Source configuration fields each forge adapter reads during setup; they name credentials but never contain a secret. */
import { z } from 'zod'

/** The GitHub Source configuration: a repository slug and the agent's GitHub CLI. */
export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
/** The Gitee Source configuration: a repository slug and the environment variable naming its token (a credential reference). */
export const GiteeAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  /** The name of the environment variable that holds the token, never the token itself. */
  tokenEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'an environment variable name').default('GITEE_TOKEN'),
})
