/** Two GitHub RepositoryBindings coexisting in one process: polling, identities, workers, scheduling, disable and policy. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, threadKey, type Assessor, type Candidate, type Executor, type Policy, type SourceScope, type Ticket,
  type Trigger } from '../src/core/index.ts'
import { policyEffects, SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry, healthKey } from '../src/sources/registry.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { issueTrigger, type GithubRef } from '../src/sources/github-trigger.ts'
import { claimPull, type Pull } from '../src/sources/github-pull.ts'
import { githubKind, pollWhenEnabled } from '../src/sources/github.ts'
import { repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { Effects } from '../src/app/effects.ts'
import { writeEnvironment, workerBin } from '../src/infra/environment.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testCommands, testDeployment, testRepository } from './fixtures/deployment.ts'

const A: RepositoryBinding = { ...testRepository, id: repositoryId('github', 101), providerRepositoryId: '101', slug: 'acme/alpha',
  webUrl: 'https://github.com/acme/alpha', credentialId: 'github:alpha' }
const B: RepositoryBinding = { ...testRepository, id: repositoryId('github', 202), providerRepositoryId: '202', slug: 'acme/beta',
  webUrl: 'https://github.com/acme/beta', credentialId: 'github:beta' }
const refA: GithubRef = { sourceId: 'github-alpha', repositoryId: A.id }
const refB: GithubRef = { sourceId: 'github-beta', repositoryId: B.id }
const at = '2026-11-01T10:00:00Z'
const issue = (ref: GithubRef, number: number, slug = ref.repositoryId === A.id ? A.slug : B.slug) =>
  issueTrigger({ number, title: 'Fix the login', body: '@agent-bot please fix the login', created_at: at,
    html_url: `https://github.com/${slug}/issues/${number}`, user: { login: 'alice', type: 'User' } }, 'agent-bot', ref)
const settings = (overrides: Partial<ReturnType<typeof SettingsSchema.parse>> = {}) => SettingsSchema.parse({
  sources: {
    [refA.sourceId]: { kind: 'github', enabled: true, config: { repository: A.slug, cli: '/bin/false' } },
    [refB.sourceId]: { kind: 'github', enabled: true, config: { repository: B.slug, cli: '/bin/false' } },
  },
  policy: { sources: { [refA.sourceId]: { allowed: [{ id: 'alice' }] }, [refB.sourceId]: { allowed: [{ id: 'alice' }] } } },
  ...overrides,
})

/** Acceptance harness: the Engine accepts an Issue in each repository, with a prepare step that keeps each binding's workspace. */
function harness(settingsValue = settings()) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const starts: Ticket[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) } }
  const executor: Executor = { start: vi.fn((ticket: Ticket) => { starts.push(ticket) }), deliver: vi.fn(), stop: vi.fn() }
  const outbox = { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }
  const policy: Policy = { version: 'v1', versionFor: () => 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const scope: SourceScope = { scope: () => ({ listened: true, observed: false }),
    repositoryOf: source => source === refA.sourceId ? A.id : source === refB.sourceId ? B.id : null }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox,
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, settingsValue, '/srv/state') }) })
  const accept = (ref: GithubRef, number: number): Ticket => {
    engine.receive(issue(ref, number))
    engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', deliverable: 'change', title: 'Fix the login', scope: 'the login form',
      reason: 'asked', name: 'fix-work', evalId: candidate.evalId })
    return repo.tickets.get(decision.ticketId!)!
  }
  return { repo, engine, accept, starts }
}

/** The capabilities `claimPull` uses, bound to one Source instance and repository. */
function sourceContext(repo: MemoryRepositories, engine: Engine, binding: RepositoryBinding, sourceId: string): SourceContext {
  const credential = { cli: '/bin/false', login: 'agent-bot', noreply: '' }
  const deployment = testDeployment({ credentials: { [binding.credentialId]: credential }, repositories: [binding] })
  const commands = testCommands(() => deployment, {}, undefined, binding)
  return { sourceId, repository: binding, deployment, commands, ready: Promise.resolve(), configured: () => true,
    config: <C extends Record<string, unknown>>() => ({ repository: binding.slug, cli: '/bin/false' }) as unknown as C, receive: vi.fn(),
    atomic: work => repo.atomic(work), state: { get: () => undefined, set: () => {}, keys: () => [] },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {},
      patch: (key, meta) => { const thread = repo.threads.get(key); if (thread) repo.threads.save({ ...thread, meta: { ...thread.meta, ...meta } }) } },
    tickets: { get: id => repo.tickets.get(id), open: () => repo.tickets.open(), bindThread: (id, thread, own) => { engine.bindThread(id, thread, own) },
      threadClosed: () => {} },
    triggers: { get: id => repo.triggers.get(id), latest: () => undefined }, notify: vi.fn(), report: vi.fn() }
}
const pull = (binding: RepositoryBinding, number: number, branch: string): Pull => ({ number, title: 'Fix', state: 'open',
  html_url: `${binding.webUrl}/pull/${number}`, user: { login: 'agent-bot' }, body: '', created_at: at,
  head: { sha: 'abc', ref: branch, repo: { full_name: binding.slug } } })

describe('two GitHub repository bindings in one process', () => {
  it('polls both bindings with separate Source IDs, health entries and cursor sets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    const settingsValue = settings()
    store.saveSettings(settingsValue)
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board, undefined,
      sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
    sources.register(githubKind)
    const credential = { cli: '/bin/false', login: 'agent-bot', noreply: '' }
    const deployment = testDeployment({ credentials: { [A.credentialId]: credential, [B.credentialId]: credential }, repositories: [A, B] })
    const received: Trigger[] = []
    const deps: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() },
      outbox: { send: vi.fn() }, commands: testCommands(() => deployment, {}, undefined, null), sources, deployment,
      ready: Promise.resolve(), configured: () => true, receive: trigger => { received.push(trigger); return { accepted: true } as never } }
    const ctxA = sourceContextOf(deps, githubKind, refA.sourceId)
    const ctxB = sourceContextOf(deps, githubKind, refB.sourceId)
    const seen: Record<string, string[]> = {}
    vi.spyOn(Commands.prototype, 'run').mockImplementation(async function (this: Commands, _program: string, args: string[]) {
      const slug = this.repository!.slug
      const path = String(args[1]).replace(new RegExp(`^repos/${slug}/`), '')
      ;(seen[slug] ??= []).push(path.split('?')[0]!)
      if (path.startsWith('notifications?')) return `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify([{ id: `n-${slug}`, updated_at: at, reason: 'mention',
        repository: { full_name: slug }, subject: { url: `https://api.github.com/repos/${slug}/issues/12`, type: 'Issue', title: 'Fix' } }])}`
      if (path === 'issues/12') return JSON.stringify({ id: 12, number: 12, title: 'Fix the login', body: '@agent-bot please fix', state: 'open',
        created_at: at, html_url: `https://github.com/${slug}/issues/12`, user: { login: 'alice', type: 'User' } })
      return JSON.stringify([])
    })
    const cursorAt = '2026-11-01T09:00:00Z'
    store.set(KV.github.since(refA.sourceId, A.id), cursorAt)
    store.set(KV.github.since(refB.sourceId, B.id), cursorAt)
    try {
      const rounds = await Promise.all([pollWhenEnabled(ctxA), pollWhenEnabled(ctxB)])
      expect(rounds.every(interval => interval !== undefined && interval >= 60)).toBe(true)
      // Each loop read only its own repository.
      expect(Object.keys(seen).sort()).toEqual([A.slug, B.slug].sort())
      expect(seen[A.slug]!.every(path => !path.includes(B.slug))).toBe(true)
      // The same native Issue number became two distinct Triggers on two distinct Threads.
      expect(received.map(trigger => trigger.id)).toHaveLength(2)
      expect(received[0]!.id).not.toBe(received[1]!.id)
      expect(received.map(trigger => threadKey(trigger.threads[0]!)).sort()).toEqual([`${refA.sourceId}:12`, `${refB.sourceId}:12`])
      // Health and cursors are namespaced by Source instance and binding.
      expect(board.all[healthKey(refA.sourceId, 'github')]).toMatchObject({ state: 'ready' })
      expect(board.all[healthKey(refB.sourceId, 'github')]).toMatchObject({ state: 'ready' })
      const cursorA = store.get(KV.github.since(refA.sourceId, A.id))
      const cursorB = store.get(KV.github.since(refB.sourceId, B.id))
      expect(cursorA).toBeDefined(); expect(cursorB).toBeDefined()
      expect(KV.github.since(refA.sourceId, A.id)).not.toBe(KV.github.since(refB.sourceId, B.id))
    } finally {
      vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts one Issue per binding, starts one worker each, and keeps colliding PR numbers and branch names in their repositories', () => {
    const h = harness()
    const ticketA = h.accept(refA, 12), ticketB = h.accept(refB, 12)
    // One started worker per Ticket, each carrying its own binding and workspace namespace.
    expect(h.starts.map(ticket => ticket.repositoryId)).toEqual([A.id, B.id])
    expect(ticketA.execution!.directory).toBe(`/srv/state/work/${A.id}/fix-work-${ticketA.id.slice(0, 12)}`)
    expect(ticketB.execution!.directory).toBe(`/srv/state/work/${B.id}/fix-work-${ticketB.id.slice(0, 12)}`)
    expect(ticketA.execution!.directory).not.toContain(B.id)
    expect(ticketA.execution!.name).not.toBe(ticketB.execution!.name)
    // Identical branch suffixes and PR numbers are still per-binding: give both tickets one branch name.
    const branch = 'agent/shared-fix'
    for (const [id, name] of [[ticketA.id, 'shared-fix'], [ticketB.id, 'shared-fix']] as const) {
      const ticket = h.repo.tickets.get(id)!
      h.repo.tickets.save({ ...ticket, execution: { ...ticket.execution!, name } })
    }
    const ctxA = sourceContext(h.repo, h.engine, A, refA.sourceId)
    const ctxB = sourceContext(h.repo, h.engine, B, refB.sourceId)
    expect(claimPull(ctxA, ticketA.id, pull(A, 7, branch))).toBeUndefined()
    expect(claimPull(ctxB, ticketB.id, pull(B, 7, branch))).toBeUndefined()
    expect(h.repo.tickets.get(ticketA.id)!.follows).toEqual([{ thread: `${refA.sourceId}:7`, own: true, repositoryId: A.id }])
    expect(h.repo.tickets.get(ticketB.id)!.follows).toEqual([{ thread: `${refB.sourceId}:7`, own: true, repositoryId: B.id }])
    // A PR object from the other repository cannot be claimed, with matching number and branch or not.
    expect(claimPull(ctxA, ticketA.id, pull(B, 7, branch))).toContain('PR does not belong to this ticket')
    expect(claimPull(ctxB, ticketB.id, pull(A, 7, branch))).toContain('PR does not belong to this ticket')
    // Nor can a Thread of the other repository be attached to this ticket.
    h.engine.receive(issue(refB, 21))
    expect(() => h.engine.attach(ticketA.id, issue(refB, 21).id)).toThrow('belongs to repository')
  })

  it('stops only the disabled binding\'s intake, while the other polls and accepted Tickets keep their work', async () => {
    const h = harness()
    const ticketA = h.accept(refA, 12), ticketB = h.accept(refB, 12)
    const directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    try {
      const store = new Store(join(directory, 'orchestrator.sqlite'))
      const enabled = settings({ sources: { ...settings().sources, [refA.sourceId]: { ...settings().sources[refA.sourceId]!, enabled: false } } })
      store.saveSettings(enabled)
      const sources = new SourceRegistry(() => store.settings(), new HealthBoard(), undefined,
        sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
      sources.register(githubKind)
      const credential = { cli: '/bin/false', login: 'agent-bot', noreply: '' }
      const deployment = testDeployment({ credentials: { [A.credentialId]: credential, [B.credentialId]: credential }, repositories: [A, B] })
      const deps: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() },
        outbox: { send: vi.fn() }, commands: testCommands(() => deployment, {}, undefined, null), sources, deployment,
        ready: Promise.resolve(), configured: () => true, receive: vi.fn() }
      const ctxA = sourceContextOf(deps, githubKind, refA.sourceId)
      const ctxB = sourceContextOf(deps, githubKind, refB.sourceId)
      const run = vi.spyOn(Commands.prototype, 'run').mockResolvedValue('HTTP/2.0 200 OK\r\n\r\n[]')
      expect(ctxA.config()).toBeUndefined(); expect(ctxB.config()).toBeDefined()
      // The disabled binding reads nothing new: no notification or repository stream.
      expect(await pollWhenEnabled(ctxA)).toBe(60)
      expect(run.mock.calls.some(([, args]) => String(args[1]).includes('notifications'))).toBe(false)
      expect(await pollWhenEnabled(ctxB)).toBeGreaterThanOrEqual(60)
      expect(run).toHaveBeenCalled()
      // The disabled binding's accepted Ticket still owns its running Assignment and workspace.
      const stored = h.repo.tickets.get(ticketA.id)!
      expect(stored.repositoryId).toBe(A.id)
      expect(h.repo.tickets.get(ticketB.id)!.repositoryId).toBe(B.id)
      // The accepted Ticket still finishes after its binding stopped taking new work.
      expect(h.engine.report(ticketA.id, { state: 'ready', summary: 'finished after the binding was disabled' })).toMatchObject({
        ended: { outcome: 'completed' } })
      run.mockRestore(); store.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps observing a disabled binding\'s open Tickets so they can finish', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    const settingsValue = settings({ sources: { ...settings().sources, [refA.sourceId]: { ...settings().sources[refA.sourceId]!, enabled: false } } })
    store.saveSettings(settingsValue)
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board, undefined,
      sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
    sources.register(githubKind)
    const credential = { cli: '/bin/false', login: 'agent-bot', noreply: '' }
    const deployment = testDeployment({ credentials: { [A.credentialId]: credential, [B.credentialId]: credential }, repositories: [A, B] })
    const deps: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: vi.fn() },
      commands: testCommands(() => deployment, {}, undefined, null), sources, deployment, ready: Promise.resolve(), configured: () => true,
      receive: vi.fn() }
    const ctx = sourceContextOf(deps, githubKind, refA.sourceId)
    // The Ticket follows PR 7 in the disabled repository; its worker is still running.
    store.tickets.save({ id: 't-a', title: 'running', decisionId: 'd', repositoryId: A.id,
      mandate: { strength: 'explicit', deliverable: 'change', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: refA.sourceId, id: 'alice' }, scope: '' },
      channels: [], assignments: [{ id: 'a', state: 'running', createdAt: at }], inputs: [], undelivered: [], createdAt: at, updatedAt: at,
      execution: { name: 'shared-fix', directory: `/w/${A.id}/shared-fix`, assignment: '' }, follows: [{ thread: `${refA.sourceId}:7`, own: true,
        repositoryId: A.id }], budget: { used: 0, lastSeq: -1, epoch: 1, status: 'ok' }, origin: { triggerId: 'x', triggerIds: [] } })
    store.threads.save({ key: `${refA.sourceId}:7`, ref: { source: refA.sourceId, id: '7', repositoryId: A.id }, repositoryId: A.id, createdAt: at,
      subscriptions: ['t-a'], correlated: [], pending: [], meta: { isPr: true, title: 'Fix', number: 7 } })
    const seen: string[] = []
    vi.spyOn(Commands.prototype, 'run').mockImplementation(async function (this: Commands, _program: string, args: string[]) {
      const path = String(args[1]).replace(/^repos\/acme\/alpha\//, '').split('?')[0]!
      seen.push(path)
      if (path === 'pulls/7') return JSON.stringify({ number: 7, title: 'Fix', state: 'open', html_url: `${A.webUrl}/pull/7`,
        user: { login: 'agent-bot' }, body: '', created_at: at, head: { sha: 'abc', ref: 'agent/shared-fix', repo: { full_name: A.slug } } })
      if (path === 'commits/abc/check-runs') return JSON.stringify([{ check_runs: [] }])
      return JSON.stringify([[]])
    })
    try {
      expect(await pollWhenEnabled(ctx)).toBe(60)
      // Only the open Ticket's PR and Thread were read; new Issues and notifications were not.
      expect(seen).toContain('pulls/7')
      expect(seen.some(path => path.startsWith('notifications'))).toBe(false)
      expect(seen).not.toContain('issues')
    } finally { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps each binding\'s authorization lane independent of the other repository\'s Policy', () => {
    const old = settings()
    const sources = new SourceRegistry(() => old, new HealthBoard(), undefined,
      sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
    sources.register(githubKind)
    const revoked = SettingsSchema.parse({ ...old, policy: { ...old.policy, sources: { ...old.policy.sources,
      [refA.sourceId]: { allowed: [] }, [refB.sourceId]: { allowed: [{ id: 'alice' }] } } } })
    const before = settingsPolicy(old, sources), after = settingsPolicy(revoked, sources)
    // The lane of B is unchanged by A's allowed list; A's lane changed.
    expect(before.versionFor(A.id)).not.toBe(after.versionFor(A.id))
    expect(before.versionFor(B.id)).toBe(after.versionFor(B.id))
    // A's allowed actor cannot authorize a Trigger of B, and vice versa.
    const triggerA = issue(refA, 12, A.slug), triggerB = issue(refB, 12, B.slug)
    const threadA = { key: `${refA.sourceId}:12`, ref: triggerA.threads[0]!, repositoryId: A.id, createdAt: at, subscriptions: [],
      correlated: [], pending: [], meta: {} }
    const threadB = { key: `${refB.sourceId}:12`, ref: triggerB.threads[0]!, repositoryId: B.id, createdAt: at, subscriptions: [],
      correlated: [], pending: [], meta: {} }
    expect(before.gate(triggerA, threadA, []).admissible).toBe(true)
    expect(before.gate(triggerB, threadB, []).admissible).toBe(true)
    const onlyAAllowed = SettingsSchema.parse({ ...old, policy: { ...old.policy, sources: {
      [refA.sourceId]: { allowed: [{ id: 'alice' }] }, [refB.sourceId]: { allowed: [] } } } })
    const scoped = settingsPolicy(onlyAAllowed, sources)
    expect(scoped.gate(triggerA, threadA, []).admissible).toBe(true)
    expect(scoped.gate(triggerB, threadB, [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })

  it('tells only the Tickets whose binding lane changed, leaving the other repository\'s Mandates valid', () => {
    const old = settings()
    const revoked = SettingsSchema.parse({ ...old, policy: { ...old.policy, sources: { ...old.policy.sources,
      [refA.sourceId]: { allowed: [] } } } })
    const sourcesFor = (value: typeof old) => new SourceRegistry(() => value, new HealthBoard(), undefined,
      sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
    const scope = (value: typeof old) => { const sources = sourcesFor(value); sources.register(githubKind); return sources }
    const ticket = (id: string, repositoryId: string, source: string): Ticket => ({ id, title: id, decisionId: 'd', repositoryId,
      mandate: { strength: 'explicit', deliverable: 'change', policyVersion: '', basis: { via: 'listed' }, actor: { source, id: 'alice' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, budget: { used: 0, lastSeq: -1, epoch: 1, status: 'ok' }, origin: { triggerId: 'x', triggerIds: [] } })
    const effects = policyEffects([ticket('t-a', A.id, refA.sourceId), ticket('t-b', B.id, refB.sourceId)], old, revoked, scope)
    expect([...effects.keys()]).toEqual(['t-a'])
    expect(effects.get('t-a')).toMatchObject({ requesterAllowed: false })
  })

  it('interleaves queued launches by binding so one repository cannot starve the other', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    const effects = new Effects(store, new HealthBoard())
    effects.start()
    const order: string[] = []
    // Each launch stays pending until the test releases it, as a full worker pool would hold them.
    const holds = new Map<string, () => void>()
    effects.handle('launch', (payload: { ticketId: string }) => new Promise<void>(resolve => { order.push(payload.ticketId); holds.set(payload.ticketId, resolve) }),
      { limit: () => 1, lane: payload => payload.ticketId.startsWith('a') ? A.id : B.id })
    // Tickets a1, a2 belong to A and b1, b2 to B, queued in that order.
    for (const [ticketId, repositoryId] of [['a1', A.id], ['a2', A.id], ['b1', B.id], ['b2', B.id]] as const) {
      store.tickets.save({ id: ticketId, title: ticketId, decisionId: 'd', repositoryId,
        mandate: { strength: 'explicit', deliverable: 'change', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: refA.sourceId, id: 'alice' }, scope: '' },
        channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, budget: { used: 0, lastSeq: -1, epoch: 1, status: 'ok' }, origin: { triggerId: 'x', triggerIds: [] } })
      effects.enqueue('launch', `${ticketId}:assignment`, { ticketId, assignmentId: `${ticketId}:assignment` })
    }
    try {
      const release = async (ticketId: string) => {
        await vi.waitFor(() => expect(holds.get(ticketId)).toBeDefined())
        holds.get(ticketId)!(); await Promise.resolve(); await Promise.resolve()
      }
      await release('a1'); await release('b1'); await release('a2'); await release('b2')
      await effects.idle()
      // Round robin from the first lane: A, B, A, B — not A, A, B, B.
      expect(order).toEqual(['a1', 'b1', 'a2', 'b2'])
      expect(order.slice(0, 2)).toEqual(['a1', 'b1'])
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps both bindings, mappings, cursors, active assignments and PR ownership across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    const h = harness()
    const ticketA = h.accept(refA, 12), ticketB = h.accept(refB, 12)
    const branch = 'agent/shared-fix'
    for (const id of [ticketA.id, ticketB.id]) {
      const ticket = h.repo.tickets.get(id)!
      h.repo.tickets.save({ ...ticket, execution: { ...ticket.execution!, name: branch.split('/').at(-1)! } })
    }
    const ctxA = sourceContext(h.repo, h.engine, A, refA.sourceId), ctxB = sourceContext(h.repo, h.engine, B, refB.sourceId)
    claimPull(ctxA, ticketA.id, pull(A, 7, branch)); claimPull(ctxB, ticketB.id, pull(B, 7, branch))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    try {
      store.atomic(() => {
        store.repositories.save(A); store.repositories.save(B)
        store.repositories.bind(refA.sourceId, A.id); store.repositories.bind(refB.sourceId, B.id)
        store.set(KV.github.since(refA.sourceId, A.id), at)
        store.set(KV.github.since(refB.sourceId, B.id), at)
        // A running Assignment survives the restart with its Ticket binding.
        const running = h.repo.tickets.get(ticketA.id)!
        h.repo.tickets.save({ ...running, assignments: running.assignments.map(assignment => ({ ...assignment, state: 'running',
          startedAt: assignment.startedAt ?? at })) })
        for (const id of [ticketA.id, ticketB.id]) store.tickets.save(h.repo.tickets.get(id)!)
      })
      store.close()
      const reopened = new Store(join(directory, 'orchestrator.sqlite'))
      expect(reopened.repositories.list().map(binding => binding.id)).toEqual([A.id, B.id])
      expect(reopened.repositories.sources()).toEqual([{ sourceId: refA.sourceId, repositoryId: A.id }, { sourceId: refB.sourceId, repositoryId: B.id }])
      expect(reopened.get(KV.github.since(refA.sourceId, A.id))).toBe(at)
      expect(reopened.get(KV.github.since(refB.sourceId, B.id))).toBe(at)
      const restoredA = reopened.tickets.get(ticketA.id)!, restoredB = reopened.tickets.get(ticketB.id)!
      expect([restoredA.repositoryId, restoredB.repositoryId]).toEqual([A.id, B.id])
      expect(restoredA.execution!.directory.startsWith(join('/srv/state', 'work', A.id))).toBe(true)
      expect(restoredB.execution!.directory.startsWith(join('/srv/state', 'work', B.id))).toBe(true)
      expect(restoredA.assignments[0]).toMatchObject({ state: 'running', startedAt: at })
      expect(restoredA.follows).toEqual([{ thread: `${refA.sourceId}:7`, own: true, repositoryId: A.id }])
      expect(restoredB.follows).toEqual([{ thread: `${refB.sourceId}:7`, own: true, repositoryId: B.id }])
      reopened.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('gives each Ticket only its own binding in the execution environment', () => {
    const h = harness()
    const ticketA = h.accept(refA, 12), ticketB = h.accept(refB, 12)
    const credentialA = { cli: '/opt/bin/gh-alpha', login: 'agent-alpha', noreply: '1+agent-alpha@users.noreply.github.com' }
    const credentialB = { cli: '/opt/bin/gh-beta', login: 'agent-beta', noreply: '2+agent-beta@users.noreply.github.com' }
    const sources = new SourceRegistry(() => settings(), new HealthBoard(), undefined,
      sourceId => sourceId === refA.sourceId ? A : sourceId === refB.sourceId ? B : undefined)
    sources.register(githubKind)
    const deployment = testDeployment({ github: credentialA, credentials: { [A.credentialId]: credentialA, [B.credentialId]: credentialB },
      repositories: [A, B] })
    const values = (ticket: Ticket) => Object.fromEntries(environmentOf({ deployment, sources, settings: settings(),
      ticket: { id: ticket.id, name: ticket.execution!.name, directory: ticket.execution!.directory }, repositoryId: ticket.repositoryId! })
      .map(variable => [variable.key, variable.value]))
    const a = values(ticketA), b = values(ticketB)
    expect(a).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: A.slug, DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-alpha' })
    expect(b).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: B.slug, DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-beta' })
    expect(a.DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL).toBe(credentialA.noreply)
    expect(b.DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL).toBe(credentialB.noreply)
    expect(Object.values(a)).not.toContain(B.slug)
    expect(Object.values(b)).not.toContain(A.slug)
  })

  it('gives each worker shell its own binding\'s CLI for gh and git credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    const log = join(directory, 'calls')
    const cli = (name: string) => {
      const path = join(directory, name)
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name} '"$*" >> ${log}\nif [ "$1 $2" = 'auth git-credential' ]; then cat; fi\n`, { mode: 0o755 })
      return path
    }
    const cliA = cli('gh-alpha'), cliB = cli('gh-beta')
    const credentialA = { cli: cliA, login: 'agent-alpha', noreply: '' }, credentialB = { cli: cliB, login: 'agent-beta', noreply: '' }
    const deployment = testDeployment({ credentials: { [A.credentialId]: credentialA, [B.credentialId]: credentialB }, repositories: [A, B] })
    await writeEnvironment({ ...deployment, stateDir: directory }, [])
    const bin = workerBin(directory)
    const run = promisify(execFile)
    const worker = (repository: string, cli: string) => ({ PATH: [bin, directory, '/usr/bin', '/bin'].join(':'), HOME: directory,
      DSH_SUPERAGENT_GITHUB_REPOSITORY: repository, DSH_SUPERAGENT_GITHUB_CLI: cli })
    try {
      await run('gh', ['api', `repos/${A.slug}/issues`], { env: worker(A.slug, cliA) })
      await run('gh', ['api', `repos/${B.slug}/issues`], { env: worker(B.slug, cliB) })
      const calls = readFileSync(log, 'utf8')
      expect(calls).toContain('gh-alpha api repos/acme/alpha/issues')
      expect(calls).toContain('gh-beta api repos/acme/beta/issues')
      expect(calls).not.toContain('gh-beta api repos/acme/alpha')
      expect(calls).not.toContain('gh-alpha api repos/acme/beta')
      // The git credential helper selects the same binding's CLI from the repository path.
      const ask = (repository: string, path: string) => new Promise<string>(resolve => {
        const child = spawn(join(directory, 'worker-credential-helper'), ['get'], { env: worker(repository, cliA) })
        let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.on('close', () => resolve(stdout))
        child.stdin.end(`protocol=https\nhost=github.com\npath=${path}.git\n\n`)
      })
      await ask(B.slug, B.slug)
      expect(readFileSync(log, 'utf8')).toContain(`gh-beta auth git-credential get`)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('two-repository persistence helpers', () => {
  let directory: string | undefined
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })
  it('keeps a disabled binding persisted as disabled while the other stays enabled', () => {
    directory = mkdtempSync(join(tmpdir(), 'multi-repository-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    store.repositories.save(A); store.repositories.save(B)
    store.repositories.bind(refA.sourceId, A.id); store.repositories.bind(refB.sourceId, B.id)
    store.repositories.setEnabled(A.id, false)
    expect(store.repositories.get(A.id)!.enabled).toBe(false)
    expect(store.repositories.get(B.id)!.enabled).toBe(true)
    store.close()
  })
})
