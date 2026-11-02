/** Built-in forge adapters: one implementation per provider, shared by every RepositoryBinding of that provider. */
import { ForgeRegistry } from './registry.ts'
import { githubForgeAdapter } from './github.ts'
import { giteeForgeAdapter } from './gitee.ts'
import { gitlabForgeAdapter } from './gitlab.ts'

/** Registry registration of the built-in adapters; this is not a dynamic plugin loader. */
export const FORGE_ADAPTERS = new ForgeRegistry([githubForgeAdapter, giteeForgeAdapter, gitlabForgeAdapter])
/** The Git host of a provider that authenticates Git through the protected token-credential broker. */
export const tokenCredentialHost = (provider: string): string | undefined => {
  const adapter = FORGE_ADAPTERS.adapter(provider)
  return adapter?.credentialKind === 'token' ? adapter.gitHost : undefined
}
