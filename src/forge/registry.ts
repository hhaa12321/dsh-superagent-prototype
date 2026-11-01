/** Registry of built-in forge adapters, one implementation per provider, serving every binding of that provider. */
import type { ForgeAdapter } from './ports.ts'

/** Built-in adapters by provider ID; registering a second adapter for one provider is a programming error, not a fallback. */
export class ForgeRegistry {
  private readonly adapters = new Map<string, ForgeAdapter>()
  constructor(adapters: readonly ForgeAdapter[]) { for (const adapter of adapters) this.register(adapter) }
  register(adapter: ForgeAdapter): void {
    if (this.adapters.has(adapter.provider)) throw new Error(`Forge adapter already registered: ${adapter.provider}`)
    this.adapters.set(adapter.provider, adapter)
  }
  /** The adapter of `provider`, or undefined when no built-in implementation serves it. */
  adapter(provider: string): ForgeAdapter | undefined { return this.adapters.get(provider) }
  /** Every registered adapter in provider order. */
  all(): ForgeAdapter[] { return [...this.adapters.values()].sort((left, right) => left.provider.localeCompare(right.provider)) }
}
