/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, repositoryView, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kindOf(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  const owners = new Map(store.repositories.sources().map(item => [item.repositoryId, item.sourceId]))
  /** The binding's display facts plus the Source instance that owns it and the account its provider credential resolves to. */
  const repository = (repositoryId: string | null | undefined) => {
    const view = repositoryView(store, repositoryId)
    if (!view) return undefined
    const resolved = setup.deployment?.repositories.find(binding => binding.id === view.id)
    const deployment = setup.deployment
    const account = !resolved || !deployment ? undefined
      : (resolved.provider === 'github' ? deployment.credentials[resolved.credentialId]?.login
        : deployment.tokenCredentials[resolved.credentialId]?.login)
    return { ...view, sourceId: owners.get(view.id) ?? '', ...account ? { account } : {} }
  }
  return {
    policyVersion: policyVersion(settings),
    repositories: store.repositories.list().flatMap(binding => repository(binding.id) ?? []),
    // A new instance's form starts with the fields setup reads (account and repository); other knobs stay on its card.
    kinds: sources.installedKinds().map(kind => ({ kind: kind.kind, title: kind.title, description: kind.description,
      repositoryBound: kind.repositoryBound === true,
      createFields: (SETUP_FIELDS[kind.kind]?.flatMap(key => kind.fields.filter(field => field.key === key)) ?? kind.fields.filter(field => !field.advanced)) })),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      const repositoryViewOfInstance = repository(instance.repositoryId)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.kind] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        ...repositoryViewOfInstance ? { repository: repositoryViewOfInstance } : {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
