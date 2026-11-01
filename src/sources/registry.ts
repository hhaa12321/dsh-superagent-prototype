/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { RepositoryBinding } from '../repository.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/** Health entry name of one Source instance; namespacing keeps two instances of one kind from colliding. */
export const healthKey = (sourceId: string, entry: string): string => `${entry}:${sourceId}`

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Instances are stored and referenced by their stable `sourceId`; their `kind` selects the installed implementation, and a
 * repository-bound instance resolves exactly one persisted RepositoryBinding.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  /** Health entries claimed lazily per Source instance: `${sourceId}\0${entry}`, with the kind that owns them. */
  private readonly health = new Map<string, { entry: HealthEntry; kind: string }>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {},
    /** Resolves the persisted binding of a Source instance; a repository-bound instance has exactly one. */
    private readonly binding: (sourceId: string) => RepositoryBinding | undefined = () => undefined) {}

  /** Registers a SourceKind and returns an unregister disposer that releases its instances' health entries. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => {
      this.kinds.delete(kind.kind)
      for (const [key, owned] of this.health) if (owned.kind === kind.kind) { owned.entry.release(); this.health.delete(key) }
      unregistered()
    }
  }
  /**
   * Returns the health entries of one Source instance for `names`, claiming them on first use. A Source context writes
   * through the entries it received, so reports sent after that kind registration ended do nothing even if it registers again.
   */
  healthEntries(sourceId: string, names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => {
      const key = `${sourceId}\0${name}`
      let owned = this.health.get(key)
      if (!owned) {
        try { owned = { entry: this.board.claim(healthKey(sourceId, name), { state: 'starting', detail: '' }), kind: this.kindOf(sourceId)?.kind ?? sourceId } }
        catch { return [] }
        this.health.set(key, owned)
      }
      return [[name, owned.entry] as const]
    }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** The installed kind of the Source instance stored under `id`, or of `id` itself when it is a kind name. */
  kindOf(sourceId: string, settings = this.settings()): SourceKind | undefined {
    const stored = settings.sources[sourceId]
    return this.kinds.get(stored?.kind ?? sourceId)
  }
  /** Every configured instance ordered by `sourceId`, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const result: (SourceInstance & { installed: boolean })[] = []
    for (const kind of [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind))) {
      const stored = Object.entries(settings.sources).filter(([id, value]) => (value.kind ?? id) === kind.kind)
      const entries: [string, (Settings['sources'][string] | undefined)][] = stored.length ? stored : [[kind.kind, undefined]]
      for (const [id, value] of entries) result.push({ ...this.resolve(id, kind, value), installed: true })
    }
    for (const [id, stored] of Object.entries(settings.sources)) {
      if (this.kinds.has(stored.kind ?? id)) continue
      result.push({ id, kind: stored.kind ?? id, enabled: stored.enabled, config: stored.config, repositoryId: this.binding(id)?.id ?? null, installed: false })
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kindOf(id, settings)
    return kind ? this.resolve(id, kind, settings.sources[id]) as SourceInstance<C> : undefined
  }
  /** Instances of one kind in `sourceId` order; the canonical instance `kind` exists even when none is stored. */
  instancesOfKind(kindId: string, settings = this.settings()): SourceInstance[] {
    return this.instances(settings).filter(instance => instance.kind === kindId && instance.installed)
  }
  /** The binding of a Source instance, if it is repository-bound. */
  bindingOf(sourceId: string): RepositoryBinding | undefined { return this.binding(sourceId) }
  /** The binding with `id`, from the instance that owns it; a channel may outlive a rebinding of its Source. */
  bindingById(id: string): RepositoryBinding | undefined {
    for (const instance of this.instances()) {
      const binding = this.binding(instance.id)
      if (binding?.id === id) return binding
    }
    return undefined
  }
  /** Commands scoped to a Source instance's repository; a repository-less instance keeps the unscoped commands. */
  commandsFor(sourceId: string, commands: Commands): Commands {
    const binding = this.binding(sourceId)
    return binding ? commands.withRepository(binding) : commands
  }
  validate(id: string, value: { enabled: boolean; config: unknown } & { kind?: string }): { kind: string; enabled: boolean; config: Record<string, unknown> } {
    const kindId = value.kind ?? this.settings().sources[id]?.kind ?? id
    const kind = this.kinds.get(kindId)
    if (!kind) throw new Error(`Source kind not installed: ${kindId}`)
    return { kind: kind.kind, enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source instance's part of a submitted Policy against its kind; parts for uninstalled kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindOf(id)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindOf(id, settings)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const instance = this.instance(channel.source, settings)
    const kind = this.kindOf(channel.source, settings)
    if (!kind) return false
    return !!instance?.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  /** Enabled repository-bound Source instances with their environment declarations and resolved bindings. */
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      return kind?.environment && instance.enabled ? [{ sourceId: instance.id, kind, environment: kind.environment, config: instance.config,
        binding: this.binding(instance.id) }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind, scoped to the Source instance's repository; returns
   * `'waiting'` while the kind is not installed, or `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kindOf(message.channel.source)
    if (!kind) return 'waiting'
    const binding = message.channel.repositoryId ? this.bindingById(message.channel.repositoryId) : undefined
    return kind.channel ? kind.channel.send({ commands: binding ? commands.withRepository(binding) : this.commandsFor(message.channel.source, commands) }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const kind = this.kindOf(channel.source)
    const binding = channel.repositoryId ? this.bindingById(channel.repositoryId) ?? this.binding(channel.source) : this.binding(channel.source)
    const link = kind?.channel?.link(channel.address, { ...links, ...binding ? { repository: binding.slug } : {} })
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.instances(this.settings()).filter(instance => instance.enabled && instance.installed).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      if (!kind?.find) return []
      const result = kind.find(query)
      // A kind names its native Threads under its canonical ID; the registry maps them onto the instance that found them.
      const prefix = `${kind.kind}:`
      const threads = result.threads.map(thread => thread.startsWith(prefix) ? `${instance.id}:${thread.slice(prefix.length)}` : `${instance.id}:${thread}`)
      return [{ ...result, threads }]
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindOf(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindOf(trigger.source, settings)
    const context = kind?.threadContext
    const instance = this.instance(trigger.source, settings)
    if (!kind || !context || !instance) return undefined
    const binding = trigger.repositoryId ? this.bindingById(trigger.repositoryId) : undefined
    const scoped = (commands: Commands) => binding ? commands.withRepository(binding) : this.commandsFor(trigger.source, commands)
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(scoped(commands), trigger, part, cursor, instance.config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, scoped(commands), trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kindOf(input.source, settings)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.instance(input.source, settings)
    if (!instance?.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(id: string, kind: SourceKind, stored: { kind?: string; enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: stored?.kind ?? kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}),
      repositoryId: this.binding(id)?.id ?? null }
  }
}
