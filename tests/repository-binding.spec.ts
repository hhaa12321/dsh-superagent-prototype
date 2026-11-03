import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, threadKey, type Assessor, type Candidate, type Executor, type Policy, type SourceScope, type Ticket }
  from '../src/core/index.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { SourceRegistry, healthKey } from '../src/sources/registry.ts'
import { issueTrigger, type GithubRef } from '../src/sources/github-trigger.ts'
import { claimPull, type Pull } from '../src/sources/github-pull.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { Commands } from '../src/infra/commands.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import { repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { githubKind } from '../src/sources/github.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testCommands, testDeployment, testRepository } from './fixtures/deployment.ts'

const A: RepositoryBinding = { ...testRepository, id: repositoryId('github', 101), providerRepositoryId: '101', slug: 'acme/alpha', webUrl: 'https://github.com/acme/alpha', credentialId: 'github:alpha' }
const B: RepositoryBinding = { ...testRepository, id: repositoryId('github', 202), providerRepositoryId: '202', slug: 'acme/beta', webUrl: 'https://github.com/acme/beta', credentialId: 'github:beta' }
const refA: GithubRef = { sourceId: 'github-alpha', repositoryId: A.id }
const refB: GithubRef = { sourceId: 'github-beta', repositoryId: B.id }
const at = '2026-11-01T10:00:00Z'
const issue = (ref: GithubRef, number: number) => issueTrigger({ number, title: 'Fix the login', body: '@agent-bot please fix the login',
  created_at: at, html_url: `https://github.com/${ref.repositoryId === A.id ? A.slug : B.slug}/issues/${number}`, user: { login: 'alice', type: 'User' } }, 'agent-bot', ref)

function harness(settings: Settings) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) } }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const policy: Policy = { version: 'v1', versionFor: () => 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const scope: SourceScope = { scope: () => ({ listened: true, observed: false }) }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox,
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, settings, '/srv/state') }) })
  /** Receive one Issue and accept it through its Eval, as the main Session would. */
  const accept = (ref: GithubRef, number: number): Ticket => {
    engine.receive(issue(ref, number))
    engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', deliverable: 'change', title: 'Fix the login', scope: 'the login form', reason: 'asked',
      name: 'fix-login', evalId: candidate.evalId })
    return repo.tickets.get(decision.ticketId!)!
  }
  return { repo, engine, accept }
}
const settings = (overrides: Partial<ReturnType<typeof SettingsSchema.parse>> = {}) => SettingsSchema.parse({ ...overrides })

/** The application capabilities `claimPull` uses, bound to one Source instance and repository. */
function sourceContext(repo: MemoryRepositories, engine: Engine, binding: RepositoryBinding, sourceId: string): SourceContext {
  const credential = { cli: '/bin/false', login: 'agent-bot', noreply: '' }
  const deployment = testDeployment({ github: credential, credentials: { [binding.credentialId]: credential }, repositories: [binding] })
  const commands = testCommands(() => deployment, {}, undefined, binding)
  return { sourceId, repository: binding, deployment, commands, ready: Promise.resolve(), configured: () => true,
    config: <C extends Record<string, unknown>>() => ({ repository: binding.slug, cli: '/bin/false' }) as unknown as C, receive: vi.fn(), atomic: work => repo.atomic(work),
    state: { get: () => undefined, set: () => {}, keys: () => [] },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {},
      patch: (key, meta) => { const thread = repo.threads.get(key); if (thread) repo.threads.save({ ...thread, meta: { ...thread.meta, ...meta } }) } },
    tickets: { get: id => repo.tickets.get(id), open: () => repo.tickets.open(), bindThread: (id, thread, own) => { engine.bindThread(id, thread, own) },
      threadClosed: () => {} },
    triggers: { get: id => repo.triggers.get(id), latest: () => undefined }, notify: vi.fn(), report: vi.fn() }
}
const pull = (binding: RepositoryBinding, number: number, branch: string): Pull => ({ number, title: 'Fix', state: 'open',
  html_url: `${binding.webUrl}/pull/${number}`, user: { login: 'agent-bot' }, body: '', created_at: at,
  head: { sha: 'abc', ref: branch, repo: { full_name: binding.slug } } })

describe('repository binding identity', () => {
  it('keeps two repositories with the same native Issue and PR numbers distinct along the whole path', () => {
    const h = harness(settings())
    const triggerA = issue(refA, 12), triggerB = issue(refB, 12)
    // Native numbers match; the Source instance and repository keep the domain identities apart.
    expect([triggerA.meta.number, triggerB.meta.number]).toEqual([12, 12])
    expect(triggerA.id).not.toBe(triggerB.id)
    expect(threadKey(triggerA.threads[0]!)).toBe('github-alpha:12')
    expect(threadKey(triggerB.threads[0]!)).toBe('github-beta:12')
    const ticketA = h.accept(refA, 12), ticketB = h.accept(refB, 12)
    expect(ticketA.id).not.toBe(ticketB.id)
    expect([ticketA.repositoryId, ticketB.repositoryId]).toEqual([A.id, B.id])
    expect(ticketA.execution!.directory).toBe(`/srv/state/work/${A.id}/${ticketA.execution!.name}`)
    expect(ticketB.execution!.directory).toBe(`/srv/state/work/${B.id}/${ticketB.execution!.name}`)
    expect(ticketA.execution!.directory).not.toContain(B.id)
    // Cursors and health entries are namespaced too, though both native numbers are 12.
    const cursorA = KV.github.cursor(refA.sourceId, A.id, 12), cursorB = KV.github.cursor(refB.sourceId, B.id, 12)
    expect(cursorA).not.toBe(cursorB)
    expect(healthKey(refA.sourceId, 'github')).not.toBe(healthKey(refB.sourceId, 'github'))
    // PR ownership is per binding: a PR number can belong to each repository at once.
    const ctxA = sourceContext(h.repo, h.engine, A, refA.sourceId)
    const ctxB = sourceContext(h.repo, h.engine, B, refB.sourceId)
    expect(claimPull(ctxA, ticketA.id, pull(A, 7, `agent/${ticketA.execution!.name}`))).toBeUndefined()
    expect(claimPull(ctxB, ticketB.id, pull(B, 7, `agent/${ticketB.execution!.name}`))).toBeUndefined()
    expect(h.repo.tickets.get(ticketA.id)!.follows).toEqual([{ thread: 'github-alpha:7', own: true, repositoryId: A.id }])
    expect(h.repo.tickets.get(ticketB.id)!.follows).toEqual([{ thread: 'github-beta:7', own: true, repositoryId: B.id }])
  })

  it('refuses to claim a PR from another repository, even with a matching number and branch name', () => {
    const h = harness(settings())
    const ticket = h.accept(refA, 12)
    const ctxA = sourceContext(h.repo, h.engine, A, refA.sourceId)
    // A PR object naming repository B cannot be claimed for a ticket of repository A.
    expect(claimPull(ctxA, ticket.id, pull(B, 12, `agent/${ticket.execution!.name}`)))
      .toContain('PR does not belong to this ticket')
    // Nor can repository B's Source context claim a ticket bound to A.
    const ctxB = sourceContext(h.repo, h.engine, B, refB.sourceId)
    expect(claimPull(ctxB, ticket.id, pull(B, 12, `agent/${ticket.execution!.name}`)))
      .toContain('PR belongs to repository github:202, but this ticket belongs to github:101')
    expect(h.repo.tickets.get(ticket.id)!.follows ?? []).toEqual([])
    // Nor can the ticket follow or accept work from the other repository's Thread.
    h.engine.receive(issue(refB, 21))
    expect(() => h.engine.followForContext(ticket.id, { source: refB.sourceId, id: '21' })).toThrow('belongs to repository')
    expect(() => h.engine.attach(ticket.id, issue(refB, 21).id)).toThrow('belongs to repository')
  })

  it('cannot select another repository through a global command, environment, or workspace accessor', async () => {
    const deployment = testDeployment({ repositories: [A, B],
      credentials: { [A.credentialId]: { cli: '/bin/false', login: 'agent-bot', noreply: '' }, [B.credentialId]: { cli: '/bin/false', login: 'agent-bot', noreply: '' } } })
    const unbound = new Commands(() => deployment, {}, new AbortController().signal)
    await expect(unbound.api('issues/1')).rejects.toThrow('No repository is selected for this GitHub call; use the ticket\'s RepositoryBinding')
    const bound = unbound.withRepository(A)
    const run = vi.spyOn(bound, 'run').mockResolvedValue('{}')
    await bound.api('issues/1')
    expect(run).toHaveBeenCalledWith('/bin/false', ['api', `repos/${A.slug}/issues/1`])
    // Environment values for a ticket of A name A only, whatever other bindings the deployment holds.
    const sources = new SourceRegistry(() => settings({ sources: {
      [refA.sourceId]: { kind: 'github', enabled: true, config: { repository: A.slug, cli: '/bin/false' } },
      [refB.sourceId]: { kind: 'github', enabled: true, config: { repository: B.slug, cli: '/bin/false' } } } }), new HealthBoard(), undefined,
    sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
    sources.register(githubKind)
    const ticket: Ticket = { id: 't-a', title: 'Fix', decisionId: 'd', repositoryId: A.id,
      mandate: { strength: 'explicit', deliverable: 'change', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: refA.sourceId, id: 'alice' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: 'x', triggerIds: [] },
      execution: { name: 'fix', directory: `/srv/state/work/${A.id}/fix`, assignment: '' } }
    const values = Object.fromEntries(environmentOf({ deployment, sources, settings: settings({
      sources: { [refA.sourceId]: { kind: 'github', enabled: true, config: { repository: A.slug, cli: '/bin/false' } },
        [refB.sourceId]: { kind: 'github', enabled: true, config: { repository: B.slug, cli: '/bin/false' } } } }),
      ticket: { id: ticket.id, name: 'fix', directory: ticket.execution!.directory }, repositoryId: A.id }).map(variable => [variable.key, variable.value]))
    expect(values.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe(A.slug)
    expect(Object.values(values)).not.toContain(B.slug)
  })
})

it('keeps two Source instances of one kind apart and resolves exactly one persisted binding for each', () => {
  const settingsValue = settings({ sources: {
    [refA.sourceId]: { kind: 'github', enabled: true, config: { repository: A.slug, cli: '/bin/false' } },
    [refB.sourceId]: { kind: 'github', enabled: true, config: { repository: B.slug, cli: '/bin/false' } } } })
  const sources = new SourceRegistry(() => settingsValue, new HealthBoard(), undefined,
    sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
  sources.register(githubKind)
  const instances = sources.instances().filter(instance => instance.kind === 'github')
  // The instance IDs are stable and independent of the kind, and each carries its own repository binding.
  expect(instances.map(instance => instance.id)).toEqual([refA.sourceId, refB.sourceId])
  expect(instances.map(instance => instance.repositoryId)).toEqual([A.id, B.id])
  expect(sources.kindOf(refA.sourceId)?.kind).toBe('github')
  expect(sources.bindingById(A.id)).toEqual(A)
  expect(sources.bindingById(B.id)).toEqual(B)
  expect(sources.scope({ source: refA.sourceId, meta: { kind: 'issue' } })).toEqual({ listened: true, observed: false, row: 'issues' })
})

describe('binding lifecycle and schema', () => {
  let directory: string | undefined
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

  it('atomically prunes removed Source mappings and disables a binding no Source owns', () => {
    directory = mkdtempSync(join(tmpdir(), 'repository-binding-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    store.repositories.save(A); store.repositories.save(B)
    store.repositories.bind('github-alpha', A.id); store.repositories.bind('github-beta', B.id)
    store.repositories.reconcile([{ ...A, slug: 'acme/renamed' }], [{ sourceId: 'github-alpha', repositoryId: A.id }])
    expect(store.repositories.get(A.id)).toMatchObject({ slug: 'acme/renamed', enabled: true })
    expect(store.repositories.get(B.id)).toMatchObject({ enabled: false })
    expect(store.repositories.sources()).toEqual([{ sourceId: 'github-alpha', repositoryId: A.id }])
    store.close()
  })

  it('rejects an unversioned database that already holds tables or records, and keeps its contents unchanged', () => {
    directory = mkdtempSync(join(tmpdir(), 'repository-binding-'))
    const path = join(directory, 'orchestrator.sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO ticket VALUES (?,?)').run('t1', '{}')
    db.close()
    expect(() => new Store(path)).toThrow('has no schema version but already holds tables or records; start with a new state directory')
    const after = new DatabaseSync(path)
    expect(after.prepare('SELECT COUNT(*) AS n FROM ticket').get()).toEqual({ n: 1 })
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name='repository'").get()).toBeUndefined()
    after.close()
  })

  it('stores the repository id in Trigger, Thread, and Ticket columns with indexes for repository-scoped reads', () => {
    directory = mkdtempSync(join(tmpdir(), 'repository-binding-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    const trigger = issue(refA, 12)
    store.triggers.save(trigger)
    store.threads.save({ key: threadKey(trigger.threads[0]!), ref: trigger.threads[0]!, repositoryId: A.id, createdAt: at, subscriptions: [],
      correlated: [], pending: [], meta: {} })
    store.tickets.save({ id: 't-a', title: 'Fix', decisionId: 'd', repositoryId: A.id,
      mandate: { strength: 'explicit', deliverable: 'change', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: refA.sourceId, id: 'alice' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: trigger.id, triggerIds: [trigger.id] } })
    expect(store.db.prepare('SELECT repository_id FROM trigger WHERE id=?').get(trigger.id)).toEqual({ repository_id: A.id })
    expect(store.db.prepare('SELECT repository_id FROM thread WHERE key=?').get(threadKey(trigger.threads[0]!))).toEqual({ repository_id: A.id })
    expect(store.db.prepare('SELECT repository_id FROM ticket WHERE id=?').get('t-a')).toEqual({ repository_id: A.id })
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => String(row.name))
    expect(indexes).toEqual(expect.arrayContaining(['trigger_repository', 'thread_repository', 'ticket_repository']))
    store.close()
  })
})

describe('fresh state and resume', () => {
  let resumeDirectory: string | undefined
  afterEach(() => { if (resumeDirectory) rmSync(resumeDirectory, { recursive: true, force: true }); resumeDirectory = undefined })

  it('refuses a schema 11 state directory with an instruction to start fresh, without changing it', () => {
    resumeDirectory = mkdtempSync(join(tmpdir(), 'repository-binding-'))
    const path = join(resumeDirectory, 'orchestrator.sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', '11')
    db.close()
    expect(() => new Store(path)).toThrow(new RegExp(`schema 11 is older than schema ${SCHEMA_VERSION}.*start with a new state directory`))
    const after = new DatabaseSync(path)
    expect(after.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '11' })
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name='ticket'").get()).toBeUndefined()
    after.close()
  })

  it('loads a Ticket created under a binding after a restart, with its workspace and repository context', async () => {
    resumeDirectory = mkdtempSync(join(tmpdir(), 'repository-binding-'))
    const path = join(resumeDirectory, 'orchestrator.sqlite')
    const h = harness(settings())
    const ticket = h.accept(refA, 12)
    const store = new Store(path)
    store.atomic(() => {
      store.repositories.save(A)
      store.repositories.bind(refA.sourceId, A.id)
      store.triggers.save(h.repo.triggers.get(ticket.origin.triggerId)!)
      store.tickets.save(ticket)
    })
    store.close()

    const reopened = new Store(path)
    expect(reopened.repositories.get(A.id)).toEqual(A)
    expect(reopened.repositories.ofSource(refA.sourceId)).toBe(A.id)
    const resumed = reopened.tickets.get(ticket.id)!
    expect(resumed.repositoryId).toBe(A.id)
    expect(resumed.execution!.directory).toBe(ticket.execution!.directory)
    expect(resumed.execution!.directory.startsWith(join('/srv/state', 'work', A.id))).toBe(true)
    // Tool and environment context resolve through the persisted binding, not a process-global repository.
    const sources = new SourceRegistry(() => settings({ sources: { [refA.sourceId]: { kind: 'github', enabled: true,
      config: { repository: A.slug, cli: '/bin/false' } } } }), new HealthBoard(), undefined, sourceId => sourceId === refA.sourceId ? A : undefined)
    sources.register(githubKind)
    const deployment = testDeployment({ repositories: [A], credentials: { [A.credentialId]: { cli: '/bin/false', login: 'agent-bot', noreply: '' } } })
    const values = Object.fromEntries(environmentOf({ deployment, sources, settings: settings({ sources: { [refA.sourceId]: { kind: 'github',
      enabled: true, config: { repository: A.slug, cli: '/bin/false' } } } }), ticket: { id: resumed.id, name: resumed.execution!.name,
      directory: resumed.execution!.directory }, repositoryId: resumed.repositoryId! }).map(variable => [variable.key, variable.value]))
    expect(values.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe(A.slug)
    expect(values.DSH_SUPERAGENT_GITHUB_ACCOUNT).toBe('agent-bot')
    // Tool commands also resolve the persisted binding rather than a process-global repository.
    const binding = sources.bindingById(resumed.repositoryId!)
    expect(binding).toEqual(A)
    const commands = new Commands(() => deployment, {}, new AbortController().signal).withRepository(binding)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{}')
    await commands.api('issues/12')
    expect(run).toHaveBeenCalledWith('/bin/false', ['api', `repos/${A.slug}/issues/12`])
    reopened.close()
  })
})
