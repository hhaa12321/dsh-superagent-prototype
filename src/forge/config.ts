/** Source configuration fields each forge adapter reads during setup; they name credentials but never contain a secret. */
import { z } from 'zod'

/** A repository slug: `owner/name`, or a nested group path such as `group/subgroup/project`. */
export const REPOSITORY_SLUG = '[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*'
const repositoryPattern = new RegExp(`^(${REPOSITORY_SLUG})?$`)
const SlugSchema = z.string().trim().regex(repositoryPattern, 'owner/name or group/subgroup/project').default('')
/** The GitHub Source configuration: a repository slug and the agent's GitHub CLI. */
export const GithubAccountsSchema = z.object({
  repository: SlugSchema,
  cli: z.string().trim().default(''),
})
/** One token-authenticated forge's configuration: a repository slug and the environment variable naming its token (a credential reference). */
export const tokenAccountsSchema = (defaultTokenEnv: string) => z.object({
  repository: SlugSchema,
  /** The name of the environment variable that holds the token, never the token itself. */
  tokenEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'an environment variable name').default(defaultTokenEnv),
})
/** The Gitee Source configuration. */
export const GiteeAccountsSchema = tokenAccountsSchema('GITEE_TOKEN')
/** The GitLab Source configuration; the repository may be a nested group path. */
export const GitlabAccountsSchema = tokenAccountsSchema('GITLAB_TOKEN')
