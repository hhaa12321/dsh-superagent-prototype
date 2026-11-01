/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'
import type { RepositoryBinding } from '../../src/repository.ts'
import { Commands } from '../../src/infra/commands.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testRepository: RepositoryBinding = { id: 'github:101', provider: 'github', providerRepositoryId: '101', slug: 'acme/widgets',
  webUrl: 'https://github.com/acme/widgets', credentialId: 'github:github', enabled: true }
export const githubRef = { sourceId: 'github', repositoryId: testRepository.id }
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => {
  const github = { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }
  return {
    ...testMachine(), github, credentials: { 'github:github': github }, repositories: [testRepository],
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...overrides,
  }
}
/** Commands scoped to the fixture repository (or to none), for tests that address GitHub. */
export const testCommands = (resolved: () => Deployment = testDeployment, environment: Record<string, string | undefined> = {},
  signal = new AbortController().signal, binding: RepositoryBinding | null = testRepository): Commands =>
  new Commands(resolved, environment, signal, binding ?? undefined)
