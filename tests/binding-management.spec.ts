/** Panel-side repository binding management: add a Source instance, inspect its binding, and switch it without a restart. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { Settings, type SettingsHost } from '../src/app/settings.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import { githubCredentialId, repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { testDeployment, testRepository } from './fixtures/deployment.ts'
import type { Deployment } from '../src/deployment.ts'
import { SetupError } from '../src/setup.ts'

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

const A: RepositoryBinding = { ...testRepository, id: repositoryId('github', 101), providerRepositoryId: '101', slug: 'acme/alpha',
  webUrl: 'https://github.com/acme/alpha', credentialId: 'github:alpha' }
const B: RepositoryBinding = { ...testRepository, id: repositoryId('github', 202), providerRepositoryId: '202', slug: 'acme/beta',
  webUrl: 'https://github.com/acme/beta', credentialId: 'github:beta' }
/** A setup check result for one Source instance, with the binding setup would resolve for it. */
const candidate = (binding: RepositoryBinding, sourceId = 'github-alpha'): Deployment => {
  const credential = { cli: '/opt/bin/gh', login: 'agent-bot', noreply: '' }
  return testDeployment({ credentials: { [githubCredentialId(sourceId)]: credential },
    repositories: [{ ...binding, credentialId: githubCredentialId(sourceId) }] })
}

function harness() {
  directory = mkdtempSync(join(tmpdir(), 'binding-management-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { 'github-alpha': { kind: 'github', enabled: true,
    config: { repository: A.slug, cli: '/opt/bin/gh-alpha' } } } }))
  store.repositories.save(A)
  store.repositories.bind('github-alpha', A.id)
  const board = new HealthBoard()
  // The component under test resolves bindings from the Store, exactly as the Runtime does.
  const sources = new SourceRegistry(() => store.settings(), board, undefined, sourceId => {
    const id = store.repositories.ofSource(sourceId)
    return id ? store.repositories.get(id) : undefined
  })
  sources.register(githubKind)
  const checkAccounts = vi.fn(async (): Promise<Deployment | undefined> => undefined)
  const restart = vi.fn()
  const notify = vi.fn()
  const host: SettingsHost = {
    store, sources, engine: { policyChanged: vi.fn() },
    health: board, context: {} as unknown as Context, lifetime: new AbortController().signal,
    sessions: { notify, delivery: vi.fn(async () => 'injected' as const) },
    // Setup is already running; the test asserts that adding verifies the repository and asks for a restart.
    sourceHost: {} as never,
    setup: { configured: () => true, checkAccounts, blockCommands: vi.fn(async () => {}), restart },
    requestPass: vi.fn(),
  }
  return { store, settings: new Settings(host), checkAccounts, restart, notify }
}

describe('adding a repository binding from the panel', () => {
  it('derives a free Source instance ID, verifies the repository, persists the instance and restarts to bind it', async () => {
    const h = harness()
    const created = await h.settings.create({ kind: 'github', enabled: true, config: { repository: B.slug, cli: '/opt/bin/gh-beta' } }, 'panel')
    expect(created).toEqual({ id: 'github-acme-beta', revision: 1, restarting: true })
    expect(h.settings.current().sources['github-acme-beta']).toMatchObject({ kind: 'github', enabled: true,
      config: { repository: B.slug, cli: '/opt/bin/gh-beta' } })
    expect(h.checkAccounts).toHaveBeenCalledWith('source:github-acme-beta', expect.objectContaining({ sources: expect.objectContaining({
      'github-acme-beta': expect.anything() }) }))
    expect(h.restart).toHaveBeenCalledOnce()
    h.store.close()
  })

  it('accepts an explicit ID and refuses a duplicate, an unknown kind and a kind change', async () => {
    const h = harness()
    expect(await h.settings.create({ id: 'github-other', kind: 'github', enabled: true,
      config: { repository: 'acme/other', cli: '/opt/bin/gh-other' } }, 'panel')).toMatchObject({ id: 'github-other' })
    await expect(h.settings.create({ id: 'github-other', kind: 'github', config: { repository: 'acme/third', cli: '/opt/bin/gh' } }, 'panel'))
      .rejects.toEqual(new UserError('sourceExists', { source: 'github-other' }))
    await expect(h.settings.create({ kind: 'gitee', config: {} }, 'panel')).rejects.toEqual(new UserError('sourceNotInstalled', { source: 'gitee' }))
    const current = h.settings.block('source:github-other').value as { enabled: boolean; config: Record<string, unknown> }
    await expect(h.settings.save('source:github-other', { ...current, kind: 'feishu' }, h.store.blockRevision('source:github-other'), 'panel'))
      .rejects.toEqual(new UserError('sourceKindFixed', { source: 'github-other' }))
    h.store.close()
  })

  it('persists nothing when the repository check refuses the new binding', async () => {
    const h = harness()
    h.checkAccounts.mockRejectedValueOnce(new SetupError('repositoryDuplicate', { repository: B.slug,
      sources: 'github-alpha, github-acme-beta' }))
    await expect(h.settings.create({ kind: 'github', enabled: true, config: { repository: B.slug, cli: '/opt/bin/gh-beta' } }, 'panel'))
      .rejects.toMatchObject({ code: 'repositoryDuplicate' })
    expect(h.settings.current().sources['github-acme-beta']).toBeUndefined()
    expect(h.restart).not.toHaveBeenCalled()
    h.store.close()
  })

  it('refuses to rebind an existing Source to a different repository ID, while allowing a rename that resolves the same ID', async () => {
    const h = harness()
    const value = h.settings.block('source:github-alpha').value as { enabled: boolean; config: Record<string, unknown> }
    const revision = h.store.blockRevision('source:github-alpha')
    // The same stable sourceId now resolves to GitHub repository 202 instead of 101.
    h.checkAccounts.mockResolvedValueOnce(candidate(B))
    await expect(h.settings.save('source:github-alpha', { enabled: true, config: { ...value.config, repository: B.slug } }, revision, 'panel'))
      .rejects.toEqual(new UserError('sourceBindingFixed', { source: 'github-alpha', from: A.id, to: B.id }))
    expect(h.settings.current().sources['github-alpha']!.config.repository).toBe(A.slug)
    expect(h.store.repositories.ofSource('github-alpha')).toBe(A.id)
    expect(h.restart).not.toHaveBeenCalled()
    // A repository rename stays the same immutable provider ID, so it may be saved.
    h.checkAccounts.mockResolvedValueOnce(candidate({ ...A, slug: 'acme/alpha-renamed',
      webUrl: 'https://github.com/acme/alpha-renamed' }))
    expect(await h.settings.save('source:github-alpha', { enabled: true,
      config: { ...value.config, repository: 'acme/alpha-renamed' } }, revision, 'panel')).toMatchObject({ restarting: true })
    expect(h.settings.current().sources['github-alpha']!.config.repository).toBe('acme/alpha-renamed')
    expect(h.store.repositories.ofSource('github-alpha')).toBe(A.id)
    h.store.close()
  })

  it('refuses a reconcile or direct bind that would remap an existing Source to another repository ID', () => {
    const h = harness()
    expect(() => h.store.repositories.reconcile([A, B], [{ sourceId: 'github-alpha', repositoryId: B.id }]))
      .toThrow(new SetupError('sourceBindingFixed', { source: 'github-alpha', from: A.id, to: B.id }))
    expect(h.store.repositories.ofSource('github-alpha')).toBe(A.id)
    expect(h.store.repositories.get(B.id)).toBeUndefined()
    expect(() => h.store.repositories.bind('github-alpha', B.id))
      .toThrow(new SetupError('sourceBindingFixed', { source: 'github-alpha', from: A.id, to: B.id }))
    // The same immutable ID with a renamed slug is not a remap.
    h.store.repositories.reconcile([{ ...A, slug: 'acme/alpha-renamed', webUrl: 'https://github.com/acme/alpha-renamed' }],
      [{ sourceId: 'github-alpha', repositoryId: A.id }])
    expect(h.store.repositories.get(A.id)!.slug).toBe('acme/alpha-renamed')
    expect(h.store.repositories.ofSource('github-alpha')).toBe(A.id)
    h.store.close()
  })

  it('switches the persisted binding with its Source instance and does not restart', async () => {
    const h = harness()
    h.restart.mockClear()
    const value = h.settings.block('source:github-alpha').value as { enabled: boolean; config: Record<string, unknown> }
    const saved = await h.settings.save('source:github-alpha', { enabled: false, config: value.config },
      h.store.blockRevision('source:github-alpha'), 'panel')
    expect(saved).toMatchObject({ restarting: false })
    expect(h.store.repositories.get(A.id)!.enabled).toBe(false)
    expect(h.restart).not.toHaveBeenCalled()
    // Switching it on again leaves the same binding in place.
    await h.settings.save('source:github-alpha', { enabled: true, config: value.config }, saved.revision, 'panel')
    expect(h.store.repositories.get(A.id)!.enabled).toBe(true)
    h.store.close()
  })
})
