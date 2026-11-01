/** Repository identity: one explicit binding per remote repository, independent of any mutable slug. */
import { z } from 'zod'

const ProviderSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a registered forge adapter ID such as github')
/**
 * Stable key of a repository binding: `<provider>:<providerRepositoryId>`.
 * The provider's immutable repository ID never changes, so neither does this key when the repository is renamed or transferred.
 */
export const repositoryId = (provider: string, providerRepositoryId: string | number): string => `${provider}:${String(providerRepositoryId)}`

/** A persisted RepositoryBinding: the configuration and ownership boundary for one remote repository. */
export const RepositoryBindingSchema = z.object({
  /** `<provider>:<providerRepositoryId>`, the stable identity used by every domain record. */
  id: z.string().regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+$/, 'provider:providerRepositoryId'),
  provider: ProviderSchema,
  /** The provider's immutable repository ID, as returned by the forge. */
  providerRepositoryId: z.string().min(1),
  /** Mutable human-readable `owner/name`, used for display and resolution, never as identity. */
  slug: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name'),
  /** Canonical provider page. */
  webUrl: z.string().url(),
  /** Reference to a protected credential source; the secret itself is never part of domain state. */
  credentialId: z.string().min(1),
  enabled: z.boolean(),
}).strict()
export type RepositoryBinding = z.infer<typeof RepositoryBindingSchema>

/** Stable credential ID for the GitHub CLI an instance uses; the secret stays outside domain state. */
export const githubCredentialId = (sourceId: string): string => `github:${sourceId}`

/** Namespace of a ticket's workspace: a repository-bound ticket lives under its repository ID. */
export const NO_REPOSITORY = '_no-repository'
export const repositoryNamespace = (repositoryIdValue: string | null | undefined): string => repositoryIdValue ?? NO_REPOSITORY
