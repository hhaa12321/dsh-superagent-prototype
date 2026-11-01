/**
 * Capability facts a forge adapter reports, persisted on the RepositoryBinding so setup, health, and the panel never
 * guess a provider's features from another provider's. They describe behavior only; no secret is part of them.
 */
import { z } from 'zod'

/** One provider's supported operations, named by the port they serve rather than by a provider feature grid. */
export const ForgeCapabilitiesSchema = z.object({
  /** `read-write` only after the provider confirmed push access for the bound account. */
  repository: z.enum(['read', 'read-write']),
  identity: z.boolean(),
  issues: z.object({ read: z.boolean(), comment: z.boolean() }).strict(),
  pulls: z.object({ read: z.boolean(), create: z.boolean(), comment: z.boolean(), reviews: z.boolean() }).strict(),
  ci: z.boolean(),
  /** Whether the adapter's complete write path lets a Ticket execute here. */
  execution: z.boolean(),
}).strict()
export type ForgeCapabilities = z.infer<typeof ForgeCapabilitiesSchema>

/** Capability identifiers in presentation order, with the operation each describes. */
export const FORGE_CAPABILITY_IDS = ['repository', 'identity', 'issues.read', 'issues.comment', 'pulls.read', 'pulls.create', 'pulls.comment',
  'pulls.reviews', 'ci', 'execution'] as const
export type ForgeCapabilityId = typeof FORGE_CAPABILITY_IDS[number]

/** Whether one capability identifier is supported, reading the nested flags of a capabilities record. */
export function forgeSupports(capabilities: ForgeCapabilities, id: ForgeCapabilityId): boolean {
  switch (id) {
    case 'repository': return capabilities.repository === 'read-write'
    case 'identity': return capabilities.identity
    case 'issues.read': return capabilities.issues.read
    case 'issues.comment': return capabilities.issues.comment
    case 'pulls.read': return capabilities.pulls.read
    case 'pulls.create': return capabilities.pulls.create
    case 'pulls.comment': return capabilities.pulls.comment
    case 'pulls.reviews': return capabilities.pulls.reviews
    case 'ci': return capabilities.ci
    case 'execution': return capabilities.execution
  }
}
/** The capability identifiers a binding's adapter does not support, for the panel's unsupported-feature facts. */
export const unsupportedCapabilities = (capabilities: ForgeCapabilities): ForgeCapabilityId[] =>
  FORGE_CAPABILITY_IDS.filter(id => !forgeSupports(capabilities, id))
