/** The Gitee read path: authenticated setup, repository-scoped ingestion, restart-safe cursors, and binding-scoped facts. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Assessor, type Candidate } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry, healthKey } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { giteeIssueTrigger, giteeKind, pollWhenEnabled } from '../src/sources/gitee.ts'
import { giteeForgeAdapter } from '../src/forge/gitee.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { problemOf, sourcesStatus } from '../src/app/views/sources.ts'
import { settingsView } from '../src/app/views/settings.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'
import { testCommands, testDeployment, testMachine } from './fixtures/deployment.ts'

const DIR = join(import.meta.dirname, 'fixtures', 'gitee')
const recorded = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T
const token = 'gitee-test-token'
const at = '2026-11-01T00:00:00.000Z'
const A: RepositoryBinding = { id: repositoryId('gitee', 51207621), provider: 'gitee', providerRepositoryId: '51207621',
  slug: 'bourneW/dsh-superagent-gitee-canary', webUrl: 'https://gitee.com/bourneW/dsh-superagent-gitee-canary',
  credentialId: 'gitee:gitee-a', capabilities: giteeForgeAdapter.capabilities, enabled: true }
const B: RepositoryBinding = { ...A, id: repositoryId('gitee', 51207622), providerRepositoryId: '51207622', credentialId: 'gitee:gitee-b' }
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200,
  headers: { 'content-type': 'application/json', ...headers } })
/** A Gitee HTTP stub serving the recorded canary and public pull-request shapes. */
function stubGitee(overrides: { issues?: unknown; comments?: unknown } = {}) {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const path = url.pathname
    if (path.endsWith('/user')) return json(recorded('user.json'))
    if (path.endsWith(`/repos/${A.slug}`)) return json(recorded('repo.json'))
    if (path.endsWith('/issues')) return json(overrides.issues ?? recorded('issues.json'))
    if (path.endsWith('/issues/IKS47K/comments')) return json(overrides.comments ?? recorded('comments.json'))
    if (path.endsWith('/issues/IKS47K')) return json(recorded('issue.json'))
    if (path.endsWith('/pulls')) return json([])
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

interface Harness {
  directory: string
  database: string
  store: Store
  board: HealthBoard
  sources: SourceRegistry
  deployment: ReturnType<typeof testDeployment>
  engine: Engine
  candidates: Candidate[]
  starts: string[]
  ctx: (id: string) => SourceContext
  close(): void
}
/** Settings with one or two Gitee Source instances, their bindings, and a credential reference per instance. */
function harness(options: { accounts?: Record<string, string>; observePulls?: boolean;
  bindings?: { sourceId: string; binding: RepositoryBinding }[] } = {}): Harness {
  const bindings = options.bindings ?? [{ sourceId: 'gitee-a', binding: A }]
  const accounts = options.accounts ?? Object.fromEntries(bindings.map(item => [item.sourceId, 'bourneW']))
  const sourcesSetting = Object.fromEntries(bindings.map(({ sourceId, binding }) => [sourceId, { kind: 'gitee', enabled: true,
    config: { repository: binding.slug, tokenEnv: 'GITEE_TOKEN', observeIssues: true, observeComments: true,
      ...options.observePulls ? { observePulls: true } : {} } }]))
  const settings = SettingsSchema.parse({ sources: sourcesSetting, eval: { mode: 'off' },
    policy: { sources: Object.fromEntries(bindings.map(({ sourceId }) => [sourceId, { allowed: [{ id: 'alice' }] }])) } })
  const directory = mkdtempSync(join(tmpdir(), 'gitee-source-'))
  const database = join(directory, 'orchestrator.sqlite')
  const store = new Store(database)
  store.saveSettings(settings)
  store.atomic(() => {
    store.repositories.reconcile(bindings.map(item => item.binding), bindings.map(item => ({ sourceId: item.sourceId, repositoryId: item.binding.id })))
  })
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board, undefined,
    sourceId => bindings.find(item => item.sourceId === sourceId)?.binding)
  sources.register(giteeKind)
  const deployment = testDeployment({ github: undefined, credentials: {}, repositories: bindings.map(item => item.binding),
    giteeCredentials: Object.fromEntries(bindings.map(item => [item.binding.credentialId, { tokenEnv: 'GITEE_TOKEN',
      login: accounts[item.sourceId]!, userId: item.sourceId === 'gitee-a' ? '618074' : '700001' }])) })
  const candidates: Candidate[] = []
  const starts: string[] = []
  const assessor: Assessor = { request: candidate => { candidates.push(candidate) } }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor,
    executor: { start: ticket => { starts.push(ticket.id) }, deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    threadRepository: ref => sources.bindingOf(ref.source)?.id ?? ref.repositoryId ?? null, repositoryExists: id => !!store.repositories.get(id),
    // The Runtime wires the same provider-neutral capability check; a Gitee binding reports execution false in Phase 3.
    executionAllowed: id => id === null ? true : store.repositories.get(id)?.capabilities.execution === true,
    emit: () => {}, prepareTicket: ticket => ticket })
  const deps: SourceContextDeps = { store, engine, outbox: { send: vi.fn() }, commands: testCommands(() => deployment, {}, undefined, null),
    sources, deployment, ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }
  return { directory, database, store, board, sources, deployment, engine, candidates, starts, ctx: id => sourceContextOf(deps, giteeKind, id),
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const seed = (store: Store, binding: RepositoryBinding, sourceId = 'gitee-a') =>
  store.set(KV.gitee.stream(sourceId, binding.id, 'issues'), { since: at })
/** Every Trigger stored for a binding's Issue Thread, in insertion order. */
const triggersOf = (store: Store, sourceId: string, _binding: RepositoryBinding): Trigger[] =>
  store.read.threadTriggers(`${sourceId}:34904144`, 100)

afterEach(() => { vi.unstubAllGlobals(); delete process.env.GITEE_TOKEN })

describe('Gitee read path', () => {
  it('ingests the prepared canary Issue and comment into repository-scoped Triggers and Threads once', async () => {
    process.env.GITEE_TOKEN = token
    const h = harness()
    const stub = stubGitee()
    try {
      seed(h.store, A)
      expect(await pollWhenEnabled(h.ctx('gitee-a'))).toBeGreaterThanOrEqual(60)
      const triggers = triggersOf(h.store, 'gitee-a', A)
      expect(triggers.map(trigger => trigger.id)).toEqual([
        key('gitee-issue', 'gitee-a', A.id, '34904144'), key('gitee-comment', 'gitee-a', A.id, '51958037')])
      for (const trigger of triggers) {
        expect(trigger.source).toBe('gitee-a')
        expect(trigger.repositoryId).toBe(A.id)
        expect(trigger.threads[0]).toMatchObject({ source: 'gitee-a', id: '34904144', repositoryId: A.id })
        // The canary is authored by the credential's own account: a non-human fact that can never authorize work.
        expect(trigger.human).toBe(false)
        expect(trigger.meta).toMatchObject({ provider: 'gitee', number: 'IKS47K', nativeId: '34904144', self: true })
      }
      const thread = h.store.threads.get('gitee-a:34904144')!
      expect(thread).toMatchObject({ repositoryId: A.id, meta: { title: 'Phase 3 read-path canary', number: 'IKS47K', nativeId: '34904144',
        provider: 'gitee' } })
      expect(thread.ref).toEqual({ source: 'gitee-a', id: '34904144', repositoryId: A.id })
      // The gate refuses a self-authored event before an Eval can hold it.
      const policy = settingsPolicy(h.store.settings(), h.sources)
      expect(policy.gate(triggers[0]!, thread, [])).toEqual({ admissible: false, reason: 'not_human' })
      // The health entry is the instance's own and states what the round ingested.
      expect(h.board.all[healthKey('gitee-a', 'gitee')]).toMatchObject({ state: 'ready' })
      expect(h.board.all[healthKey('gitee-a', 'gitee')]?.detail).toContain('1 new Issues, 1 comments')
      // A second poll from the advanced cursors creates no duplicate Trigger.
      expect(await pollWhenEnabled(h.ctx('gitee-a'))).toBeGreaterThanOrEqual(60)
      expect(triggersOf(h.store, 'gitee-a', A).map(trigger => trigger.id)).toHaveLength(2)
      // No request put the token in a URL or in a persisted record.
      for (const [input] of stub.mock.calls) expect(String(input)).not.toContain(token)
      expect(JSON.stringify([...h.store.keys('')].map(key => h.store.get(key)))).not.toContain(token)
    } finally { h.close() }
  })

  it('reads pull requests without creating, claiming, or observing one', async () => {
    process.env.GITEE_TOKEN = token
    const h = harness({ observePulls: true })
    const pull = { ...recorded<Record<string, unknown>>('pulls.json') }
    const item = (pull.items as Record<string, unknown>[])[0]!
    const recent = { ...item, created_at: '2026-11-01T10:00:00+08:00', updated_at: '2026-11-01T10:00:00+08:00' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/issues')) return json([])
      if (path.endsWith('/pulls')) return json([recent])
      return json([])
    }))
    try {
      seed(h.store, A)
      await pollWhenEnabled(h.ctx('gitee-a'))
      const pulls = h.store.read.threadTriggers('gitee-a:pull:1446764', 100).filter(trigger => trigger.meta.kind === 'pull')
      // The pull request's Thread identity is native and distinct from its display number; no Ticket or follow was created.
      expect(pulls.map(trigger => trigger.meta)).toEqual([expect.objectContaining({ nativeId: '1446764', number: '2', threadId: 'pull:1446764',
        isPr: true, provider: 'gitee' })])
      expect(threadKey(pulls[0]!.threads[0]!)).toBe('gitee-a:pull:1446764')
      expect(h.store.tickets.open()).toEqual([])
      expect(h.deployment.repositories[0]!.capabilities.pulls).toMatchObject({ create: false, comment: false, reviews: false })
    } finally { h.close() }
  })

  it('does not accept a Gitee Trigger whose binding has no execution capability, so no Assignment is runnable', () => {
    const h = harness()
    try {
      // Phase 3's Gitee adapter reports execution unsupported; a GitHub adapter reports it supported.
      expect(A.capabilities.execution).toBe(false)
      expect(giteeForgeAdapter.capabilities.execution).toBe(false)
      const issue = { nativeId: '9001', displayNumber: 'IKS9001', threadId: '9001', title: 'Fix the login',
        body: '@agent-bot please fix the login', author: { providerUserId: 'u-alice', login: 'alice' }, createdAt: at, updatedAt: at,
        webUrl: `${A.webUrl}/issues/IKS9001`, comments: 0 }
      const trigger = giteeIssueTrigger(issue, 'agent-bot', { sourceId: 'gitee-a', repositoryId: A.id })
      h.engine.receive(trigger)
      h.engine.evaluateDue()
      const candidate = h.candidates.at(-1)!
      const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix the login', scope: 'the login form', reason: 'asked',
        evalId: candidate.evalId })
      expect(decision).toMatchObject({ kind: 'ignore', reason: [{ code: 'executionUnsupported' }] })
      expect(decision.ticketId).toBeUndefined()
      expect(h.store.tickets.list()).toEqual([])
      expect(h.starts).toEqual([])
    } finally { h.close() }
  })

  it('keeps two bindings with identical native and display numbers distinct by Source instance and repository', async () => {
    process.env.GITEE_TOKEN = token
    const h = harness({ bindings: [{ sourceId: 'gitee-a', binding: A }, { sourceId: 'gitee-b', binding: B }],
      accounts: { 'gitee-a': 'bourneW', 'gitee-b': 'other-agent' } })
    stubGitee()
    try {
      seed(h.store, A, 'gitee-a'); seed(h.store, B, 'gitee-b')
      await Promise.all([pollWhenEnabled(h.ctx('gitee-a')), pollWhenEnabled(h.ctx('gitee-b'))])
      const a = triggersOf(h.store, 'gitee-a', A), b = triggersOf(h.store, 'gitee-b', B)
      expect(a.map(trigger => trigger.id)).toHaveLength(2)
      expect(b.map(trigger => trigger.id)).toHaveLength(2)
      expect(a.map(trigger => trigger.meta.number)).toEqual(['IKS47K', 'IKS47K'])
      expect(b.map(trigger => trigger.meta.number)).toEqual(['IKS47K', 'IKS47K'])
      expect(new Set([...a, ...b].map(trigger => trigger.id)).size).toBe(4)
      expect(threadKey(a[0]!.threads[0]!)).toBe('gitee-a:34904144')
      expect(threadKey(b[0]!.threads[0]!)).toBe('gitee-b:34904144')
      expect(h.store.repositories.get(A.id)!.id).not.toBe(h.store.repositories.get(B.id)!.id)
      // The other binding's self-authored event is human only for the unrelated account: it still cannot be admitted.
      expect(b[0]!.human).toBe(true)
      expect(b[0]!.meta.self).toBeUndefined()
    } finally { h.close() }
  })

  it('resumes from persisted cursors after a restart without duplicating Triggers', async () => {
    process.env.GITEE_TOKEN = token
    stubGitee()
    const first = harness()
    seed(first.store, A)
    await pollWhenEnabled(first.ctx('gitee-a'))
    expect(triggersOf(first.store, 'gitee-a', A)).toHaveLength(2)
    const directory = first.directory, database = first.database
    first.store.close()
    try {
      // Reopen the same database as a new process would, rebuild the Source contexts, and poll again.
      const store = new Store(database)
      const board = new HealthBoard()
      const sources = new SourceRegistry(() => store.settings(), board, undefined, sourceId => sourceId === 'gitee-a' ? A : undefined)
      sources.register(giteeKind)
      const deployment = testDeployment({ github: undefined, credentials: {}, repositories: [A],
        giteeCredentials: { [A.credentialId]: { tokenEnv: 'GITEE_TOKEN', login: 'bourneW', userId: '618074' } } })
      const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
        assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
        outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, threadRepository: ref => ref.repositoryId ?? null,
        repositoryExists: id => !!store.repositories.get(id), emit: () => {}, prepareTicket: ticket => ticket })
      const deps: SourceContextDeps = { store, engine, outbox: { send: vi.fn() }, commands: testCommands(() => deployment, {}, undefined, null),
        sources, deployment, ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }
      await pollWhenEnabled(sourceContextOf(deps, giteeKind, 'gitee-a'))
      expect(triggersOf(store, 'gitee-a', A)).toHaveLength(2)
      expect(store.get(KV.gitee.stream('gitee-a', A.id, 'issues'))?.since).toBeDefined()
      store.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('scopes health, accounts, and capability facts to each binding instead of a global Gitee account', () => {
    const h = harness({ bindings: [{ sourceId: 'gitee-a', binding: A }, { sourceId: 'gitee-b', binding: B }],
      accounts: { 'gitee-a': 'bourneW', 'gitee-b': 'other-agent' } })
    try {
      h.ctx('gitee-a').report('gitee', { state: 'ready', detail: 'a ready' })
      h.ctx('gitee-b').report('gitee', { state: 'error', detail: 'b failed' })
      const host = { store: h.store, sources: h.sources, links: () => ({ url: '', label: { zh: '', en: '' } }) }
      const status = sourcesStatus(host, h.board.all, { deployment: h.deployment })
      const a = status.find(row => row.id === 'gitee-a')!, b = status.find(row => row.id === 'gitee-b')!
      expect(a.state).toBe('ready'); expect(b.state).toBe('error')
      expect(a.repository).toMatchObject({ id: A.id, provider: 'gitee', capabilities: { ci: false } })
      expect(b.repository).toMatchObject({ id: B.id, provider: 'gitee' })
      expect(a.repository?.id).not.toBe(b.repository?.id)
      // Each Source card resolves its own binding's account; neither reads the other's.
      const settings = settingsView(h.store, h.sources, h.board.all, { deployment: h.deployment }, '/srv/state')
      const cardA = settings.sources.find(source => source.id === 'gitee-a')!
      const cardB = settings.sources.find(source => source.id === 'gitee-b')!
      expect(cardA.repository).toMatchObject({ account: 'bourneW', provider: 'gitee', providerRepositoryId: '51207621' })
      expect(cardB.repository).toMatchObject({ account: 'other-agent', provider: 'gitee', providerRepositoryId: '51207622' })
      expect(cardA.repository!.account).not.toBe(cardB.repository!.account)
      expect(settings.repositories.map(item => [item.id, item.account])).toEqual([[A.id, 'bourneW'], [B.id, 'other-agent']])
      expect(cardA.repository!.capabilities.pulls).toMatchObject({ create: false, reviews: false })
    } finally { h.close() }
  })

  it('refuses to remap an existing Source to another provider repository ID', () => {
    const h = harness()
    try {
      h.store.repositories.bind('gitee-a', A.id)
      expect(() => h.store.repositories.reconcile([B], [{ sourceId: 'gitee-a', repositoryId: B.id }]))
        .toThrow('A Source instance cannot be rebound to another repository')
    } finally { h.close() }
  })

  it('keeps one Gitee binding running when another Source fails setup, with the failure on its own card', async () => {
    stubGitee()
    const machine = testMachine({ stateDir: '/tmp/gitee-partial-state' })
    const deployment = await resolveDeployment(machine, [
      { sourceId: 'gitee-a', kind: 'gitee', enabled: true, config: { repository: A.slug, tokenEnv: 'GITEE_TOKEN' } },
      { sourceId: 'gitee-b', kind: 'gitee', enabled: true, config: { repository: 'bourneW/missing', tokenEnv: 'GITEE_TOKEN' } },
    ], async () => { throw new Error('no GitHub probe') }, '/usr/bin:/bin', { GITEE_TOKEN: token })
    // A healthy binding survives an unreadable repository in the other Source instance.
    expect(deployment.repositories).toEqual([expect.objectContaining({ id: A.id, provider: 'gitee', slug: A.slug })])
    expect(deployment.sourceProblems?.['gitee-b']).toMatchObject({ code: 'giteeRepositoryUnreadable', source: 'gitee-b', place: 'gitee',
      values: { repository: 'bourneW/missing', account: 'bourneW' } })
    expect(deployment.sourceProblems?.['gitee-a']).toBeUndefined()
    expect(problemOf('gitee-b', { deployment })).toMatchObject({ code: 'giteeRepositoryUnreadable' })
    expect(problemOf('gitee-a', { deployment })).toBeUndefined()
  })

  it('resolves a Gitee-only control plane without inventing a GitHub source or storing the token', async () => {
    stubGitee()
    const machine = testMachine({ stateDir: '/tmp/gitee-only-state' })
    const deployment = await resolveDeployment(machine, [{ sourceId: 'gitee', kind: 'gitee', enabled: true,
      config: { repository: A.slug, tokenEnv: 'GITEE_TOKEN' } }],
      async () => { throw new Error('no GitHub probe may run for a Gitee-only deployment') }, '/usr/bin:/bin', { GITEE_TOKEN: token })
    expect(deployment.github).toBeUndefined()
    expect(deployment.credentials).toEqual({})
    expect(deployment.repositories).toEqual([expect.objectContaining({ id: A.id, provider: 'gitee', providerRepositoryId: '51207621',
      slug: A.slug, credentialId: 'gitee:gitee', capabilities: expect.objectContaining({ ci: false }) })])
    expect(deployment.giteeCredentials['gitee:gitee']).toEqual({ tokenEnv: 'GITEE_TOKEN', login: 'bourneW', userId: '618074' })
    expect(JSON.stringify(deployment)).not.toContain(token)
    expect(deployment.repositories[0]!.capabilities.pulls.create).toBe(false)
    expect(deployment.repositories[0]!.capabilities.pulls.reviews).toBe(false)
  })
})
