/** The GitLab Source beside Gitee: documented reads, system-note exclusion, cursors, and provider isolation. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Assessor, type Candidate, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry, healthKey } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { gitlabIssueTrigger, gitlabKind, pollWhenEnabled as pollGitlab } from '../src/sources/gitlab.ts'
import { giteeIssueTrigger, giteeKind, pollWhenEnabled as pollGitee } from '../src/sources/gitee.ts'
import { gitlabForgeAdapter } from '../src/forge/gitlab.ts'
import { giteeForgeAdapter } from '../src/forge/gitee.ts'
import { claimPull, type PullHost } from '../src/forge/pulls.ts'
import type { ForgePull } from '../src/forge/ports.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { testCommands, testDeployment } from './fixtures/deployment.ts'

const giteeToken = 'gitee-source-token'
const gitlabToken = 'gitlab-source-token'
const at = '2026-11-01T00:00:00.000Z'
const G: RepositoryBinding = { id: repositoryId('gitee', 51207621), provider: 'gitee', providerRepositoryId: '51207621',
  slug: 'acme/gitee-widgets', webUrl: 'https://gitee.com/acme/gitee-widgets', credentialId: 'gitee:gitee-a',
  capabilities: giteeForgeAdapter.capabilities, enabled: true }
const L: RepositoryBinding = { id: repositoryId('gitlab', 1234), provider: 'gitlab', providerRepositoryId: '1234',
  slug: 'acme/group/widgets', webUrl: 'https://gitlab.com/acme/group/widgets', credentialId: 'gitlab:gitlab-a',
  capabilities: gitlabForgeAdapter.capabilities, enabled: true }
const authored = { id: 1, username: 'alice', login: 'alice', name: 'Alice', type: 'User' }
const giteeIssue = { id: 34904144, number: '7', title: 'Fix the login', body: '@agent-bot please fix the login', user: { id: 1, login: 'alice' },
  created_at: at, updated_at: at, html_url: `https://gitee.com/${G.slug}/issues/7`, comments: 1 }
const giteeComment = { id: 51958037, body: '@agent-bot here is the trace', user: { id: 2, login: 'bob' },
  created_at: '2026-11-01T00:01:00.000Z', updated_at: '2026-11-01T00:01:00.000Z' }
const gitlabIssue = { id: 9001, iid: 7, title: 'Fix the login', description: '@agent-bot please fix the login',
  author: { id: 1, username: 'alice', name: 'Alice' }, created_at: at, updated_at: at,
  web_url: `https://gitlab.com/${L.slug}/-/issues/7`, user_notes_count: 2 }
const gitlabNotes = [{ id: 41, body: 'changed the milestone', system: true, author: { id: 9, username: 'gitlab-bot' },
  created_at: at, updated_at: at },
{ id: 42, body: '@agent-bot here is the trace', system: false, author: { id: 1, username: 'alice', name: 'Alice' },
  created_at: '2026-11-01T00:01:00.000Z', updated_at: '2026-11-01T00:01:00.000Z' }]
const giteePull = { id: 1446764, number: 3, title: 'Fix the login', body: '@agent-bot PR', state: 'open', user: { id: 1, login: 'alice' },
  created_at: at, updated_at: at, html_url: `https://gitee.com/${G.slug}/pulls/3`, head: { ref: 'agent/fix-e2e', sha: 'a', repo: { id: 51207621,
    full_name: G.slug } }, base: { ref: 'master', repo: { id: 51207621, full_name: G.slug } } }
const gitlabPull = { id: 5003, iid: 3, title: 'Fix the login', description: '@agent-bot MR', state: 'opened',
  author: { id: 1, username: 'alice', name: 'Alice' }, created_at: at, updated_at: at, merged_at: null, closed_at: null,
  web_url: `https://gitlab.com/${L.slug}/-/merge_requests/3`, source_branch: 'agent/fix-e2e', target_branch: 'main', sha: 'b',
  source_project_id: 1234, target_project_id: 1234 }

/** A recording stub for both providers, routing by host so a collision test sees the same numbers from two APIs. */
function fakeForge(options: { gitlabIssuesStatus?: number; gitlabPullState?: string; giteePullState?: string } = {}) {
  const calls: { host: string; url: URL; method: string; authorization: string | null; privateToken: string | null }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers); const method = init?.method ?? 'GET'
    calls.push({ host: url.host, url, method, authorization: headers.get('authorization'), privateToken: headers.get('private-token') })
    const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } })
    if (url.host === 'gitee.com') {
      const path = url.pathname.replace(/^\/api\/v5/, '')
      if (path.endsWith('/user')) return json({ id: 1, login: 'agent-bot' })
      if (path.endsWith(`/repos/${G.slug}`)) return json({ id: 51207621, full_name: G.slug, html_url: G.webUrl, default_branch: 'master',
        permission: { push: true } })
      if (path.endsWith('/issues/7/comments')) return json([giteeComment])
      if (path.endsWith('/issues/7')) return json(giteeIssue)
      if (path.endsWith('/issues')) return json([giteeIssue])
      if (path.endsWith('/pulls/3/comments')) return json([])
      if (path.endsWith('/pulls/3')) return json({ ...giteePull, state: options.giteePullState ?? 'open',
        ...options.giteePullState === 'merged' ? { merged_at: new Date().toISOString() } : {},
        ...options.giteePullState === 'closed' ? { closed_at: new Date().toISOString() } : {} })
      if (path.endsWith('/pulls')) return json([giteePull])
      return json({ message: 'Not Found' }, 404)
    }
    const path = url.pathname.replace(/^\/api\/v4/, '')
    if (path.endsWith('/user')) return json({ id: 7, username: 'agent-bot', name: 'Agent' })
    if (path.endsWith(`/projects/${encodeURIComponent(L.slug)}`)) return json({ id: 1234, path_with_namespace: L.slug, web_url: L.webUrl,
      default_branch: 'main', permissions: { project_access: { access_level: 30 } } })
    if (path.endsWith('/projects/1234/issues/7/notes')) return json(gitlabNotes)
    if (path.endsWith('/projects/1234/issues/7')) return json(gitlabIssue)
    if (path.endsWith('/projects/1234/issues')) return options.gitlabIssuesStatus ? json({ message: 'boom' }, options.gitlabIssuesStatus) : json([gitlabIssue])
    if (path.endsWith('/projects/1234/merge_requests/3/notes')) return json([])
    if (path.endsWith('/projects/1234/merge_requests/3')) return json({ ...gitlabPull, state: options.gitlabPullState ?? 'opened',
      ...options.gitlabPullState === 'merged' ? { merged_at: new Date().toISOString() } : {},
      ...options.gitlabPullState === 'closed' ? { closed_at: new Date().toISOString() } : {} })
    if (path.endsWith('/projects/1234/merge_requests')) return json([gitlabPull])
    return json({ message: 'Not Found' }, 404)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

interface Harness {
  directory: string
  store: Store
  board: HealthBoard
  sources: SourceRegistry
  deployment: ReturnType<typeof testDeployment>
  engine: Engine
  candidates: Candidate[]
  starts: string[]
  ctx: (sourceId: string) => SourceContext
  close(): void
}
function harness(bindings: RepositoryBinding[] = [G, L]): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-source-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const sourcesSetting = Object.fromEntries(bindings.map((binding, index) => [binding.provider === 'gitee' ? `gitee-${index}` : `gitlab-${index}`,
    { kind: binding.provider, enabled: true, config: { repository: binding.slug, tokenEnv: binding.provider === 'gitee' ? 'GITEE_TOKEN' : 'GITLAB_TOKEN',
      observeIssues: true, observeComments: true, observePulls: true } }]))
  const settings = SettingsSchema.parse({ sources: sourcesSetting, eval: { mode: 'off' },
    policy: { sources: Object.fromEntries(Object.keys(sourcesSetting).map(id => [id, { allowed: [{ id: 'alice' }] }])) } })
  store.saveSettings(settings)
  store.atomic(() => store.repositories.reconcile(bindings, Object.entries(sourcesSetting).map(([sourceId, source]) => {
    const binding = bindings.find(item => item.provider === source.kind && source.config.repository === item.slug)!
    return { sourceId, repositoryId: binding.id }
  })))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board, undefined, sourceId => {
    const source = store.settings().sources[sourceId]
    return bindings.find(item => item.provider === source?.kind && item.slug === source.config.repository)
  })
  sources.register(giteeKind); sources.register(gitlabKind)
  const tokenCredentials = Object.fromEntries(bindings.map(binding => [binding.credentialId, { tokenEnv: binding.provider === 'gitee' ? 'GITEE_TOKEN' : 'GITLAB_TOKEN',
    login: 'agent-bot', userId: binding.provider === 'gitee' ? '1' : '7', commitEmail: `agent-bot@users.noreply.${binding.provider}.com` }]))
  const deployment = testDeployment({ stateDir: directory, github: undefined, credentials: {}, repositories: bindings, tokenCredentials })
  const candidates: Candidate[] = [], starts: string[] = []
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: candidate => { candidates.push(candidate) } } satisfies Assessor,
    executor: { start: ticket => { starts.push(ticket.id) }, deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() }, threadRepository: ref => sources.bindingOf(ref.source)?.id ?? ref.repositoryId ?? null,
    repositoryExists: id => !!store.repositories.get(id),
    executionAllowed: id => id === null ? true : store.repositories.get(id)?.capabilities.execution === true,
    emit: () => {}, prepareTicket: ticket => ({ ...ticket, execution: { name: 'fix-e2e', directory: `${directory}/work/${ticket.repositoryId}/fix-e2e`,
      assignment: '' } }) })
  const deps: SourceContextDeps = { store, engine, outbox: { send: vi.fn() }, commands: testCommands(() => deployment, {}, undefined, null),
    sources, deployment, ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }
  return { directory, store, board, sources, deployment, engine, candidates, starts,
    ctx: sourceId => sourceContextOf(deps, store.settings().sources[sourceId]!.kind === 'gitee' ? giteeKind : gitlabKind, sourceId),
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const accept = (h: Harness, trigger: Trigger, title = 'Fix the login') => {
  if (!h.store.triggers.get(trigger.id)) h.engine.receive(trigger)
  h.engine.evaluateDue()
  const candidate = h.engine.candidate(trigger.id)
  expect(candidate, `the Eval holding ${trigger.id}`).toBeDefined()
  const decision = h.engine.decide(trigger.id, { kind: 'accept', title, scope: 'the login form', reason: 'asked', name: 'fix-e2e',
    evalId: candidate!.evalId })
  return h.store.tickets.get(decision.ticketId!)!
}
const triggers = (store: Store, thread: string) => store.read.threadTriggers(thread, 100)
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GITEE_TOKEN; delete process.env.GITLAB_TOKEN })

describe('GitLab read path', () => {
  it('ingests Issues and human notes, excludes system notes, keeps native IDs apart from IIDs, and resumes without duplicates', async () => {
    process.env.GITEE_TOKEN = giteeToken; process.env.GITLAB_TOKEN = gitlabToken
    const h = harness(); const forge = fakeForge(); vi.stubGlobal('fetch', forge.fetch)
    try {
      h.store.set(KV.gitlab.stream('gitlab-1', L.id, 'issues'), { since: at })
      await pollGitlab(h.ctx('gitlab-1'))
      const list = triggers(h.store, 'gitlab-1:9001')
      expect(list.map(trigger => trigger.id)).toEqual([key('gitlab-issue', 'gitlab-1', L.id, '9001'),
        key('gitlab-comment', 'gitlab-1', L.id, '42')])
      // The system note is not a Trigger; the human note keeps its native comment ID.
      expect(list.map(trigger => trigger.meta.kind)).toEqual(['issue', 'comment'])
      expect(list[0]!.meta).toMatchObject({ provider: 'gitlab', number: '7', nativeId: '9001', threadId: '9001' })
      expect(list[0]!.human).toBe(true)
      expect(threadKey(list[0]!.threads[0]!)).toBe('gitlab-1:9001')
      expect(h.store.threads.get('gitlab-1:9001')).toMatchObject({ repositoryId: L.id, meta: { number: '7', nativeId: '9001', provider: 'gitlab' } })
      expect(h.board.all[healthKey('gitlab-1', 'gitlab')]).toMatchObject({ state: 'ready' })
      // Every request used PRIVATE-TOKEN and none put the token in a URL.
      for (const call of forge.calls.filter(call => call.host === 'gitlab.com')) {
        expect(call.privateToken).toBe(gitlabToken)
        expect(call.url.href).not.toContain(gitlabToken)
      }
      const before = triggers(h.store, 'gitlab-1:9001').map(trigger => trigger.id)
      await pollGitlab(h.ctx('gitlab-1'))
      expect(triggers(h.store, 'gitlab-1:9001').map(trigger => trigger.id)).toEqual(before)
      expect(JSON.stringify([...h.store.keys('')].map(name => h.store.get(name)))).not.toContain(gitlabToken)
    } finally { h.close() }
  })

  it('keeps Gitee and GitLab bindings distinct when Issue, MR, branch, and actor collide', async () => {
    process.env.GITEE_TOKEN = giteeToken; process.env.GITLAB_TOKEN = gitlabToken
    const h = harness(); const forge = fakeForge(); vi.stubGlobal('fetch', forge.fetch)
    try {
      h.store.set(KV.gitee.stream('gitee-0', G.id, 'issues'), { since: at })
      h.store.set(KV.gitlab.stream('gitlab-1', L.id, 'issues'), { since: at })
      await Promise.all([pollGitee(h.ctx('gitee-0')), pollGitlab(h.ctx('gitlab-1'))])
      const gitee = triggers(h.store, 'gitee-0:34904144'), gitlab = triggers(h.store, 'gitlab-1:9001')
      expect(gitee).toHaveLength(2); expect(gitlab).toHaveLength(2)
      expect(gitee.map(trigger => trigger.meta.number)).toEqual(['7', '7'])
      expect(gitlab.map(trigger => trigger.meta.number)).toEqual(['7', '7'])
      expect(new Set([...gitee, ...gitlab].map(trigger => trigger.id)).size).toBe(4)
      expect(gitee[0]!.threads[0]).toMatchObject({ source: 'gitee-0', id: '34904144', repositoryId: G.id })
      expect(gitlab[0]!.threads[0]).toMatchObject({ source: 'gitlab-1', id: '9001', repositoryId: L.id })
      // Presentation links stay on the provider and repository that produced the Trigger.
      expect(gitee[0]!.url).toContain('https://gitee.com/')
      expect(gitlab[0]!.url).toContain('https://gitlab.com/')
      expect(gitee[0]!.channel?.address.url).toContain('gitee.com')
      expect(gitlab[0]!.channel?.address.url).toContain('gitlab.com')
      // The same merge request/PR number and branch live under separate native IDs and cursor namespaces.
      const giteePullThread = 'gitee-0:pull:1446764', gitlabPullThread = 'gitlab-1:pull:5003'
      expect(triggers(h.store, giteePullThread).map(trigger => trigger.meta)).toEqual([expect.objectContaining({ number: '3', nativeId: '1446764',
        provider: 'gitee', kind: 'pull' })])
      expect(triggers(h.store, gitlabPullThread).map(trigger => trigger.meta)).toEqual([expect.objectContaining({ number: '3', nativeId: '5003',
        provider: 'gitlab', kind: 'pull' })])
      expect(h.store.get(KV.gitlab.stream('gitlab-1', L.id, 'issues'))?.since).toBeDefined()
      expect(h.store.get(KV.gitee.stream('gitee-0', G.id, 'issues'))?.since).toBeDefined()
      // Tickets accepted from each provider's Trigger keep their own binding even with the same display number.
      const giteeTicket = accept(h, giteeIssueTrigger({ nativeId: '34904144', displayNumber: '7', threadId: '34904144', title: 'Fix the login',
        body: '@agent-bot fix', author: { providerUserId: '1', login: 'alice' }, createdAt: at, updatedAt: at, webUrl: giteeIssue.html_url,
        comments: 0 }, 'agent-bot', { sourceId: 'gitee-0', repositoryId: G.id }))
      const gitlabTicket = accept(h, gitlabIssueTrigger({ nativeId: '9001', displayNumber: '7', threadId: '9001', title: 'Fix the login',
        body: '@agent-bot fix', author: { providerUserId: '1', login: 'alice' }, createdAt: at, updatedAt: at, webUrl: gitlabIssue.web_url,
        comments: 0 }, 'agent-bot', { sourceId: 'gitlab-1', repositoryId: L.id }))
      expect(giteeTicket.repositoryId).toBe(G.id)
      expect(gitlabTicket.repositoryId).toBe(L.id)
      expect(giteeTicket.id).not.toBe(gitlabTicket.id)
    } finally { h.close() }
  })

  it('records a failed GitLab poll on GitLab only and leaves Gitee polling and health alone', async () => {
    process.env.GITEE_TOKEN = giteeToken; process.env.GITLAB_TOKEN = gitlabToken
    const h = harness(); const forge = fakeForge({ gitlabIssuesStatus: 500 }); vi.stubGlobal('fetch', forge.fetch)
    try {
      h.store.set(KV.gitee.stream('gitee-0', G.id, 'issues'), { since: at })
      h.store.set(KV.gitlab.stream('gitlab-1', L.id, 'issues'), { since: at })
      await pollGitee(h.ctx('gitee-0'))
      await expect(pollGitlab(h.ctx('gitlab-1'))).rejects.toThrow('GitLab API 500')
      expect(h.board.all[healthKey('gitee-0', 'gitee')]).toMatchObject({ state: 'ready' })
      expect(triggers(h.store, 'gitee-0:34904144')).toHaveLength(2)
      expect(triggers(h.store, 'gitlab-1:9001')).toHaveLength(0)
      // Gitee's cursor advanced; GitLab's stayed where it was for the next round.
      expect(h.store.get(KV.gitee.stream('gitee-0', G.id, 'issues'))?.since).not.toBe(at)
      expect(h.store.get(KV.gitlab.stream('gitlab-1', L.id, 'issues'))?.since).toBe(at)
    } finally { h.close() }
  })

  it('ends only the owning Ticket when a claimed GitLab merge request merges and a Gitee pull request closes', async () => {
    process.env.GITEE_TOKEN = giteeToken; process.env.GITLAB_TOKEN = gitlabToken
    const h = harness()
    try {
      const giteeTicket = accept(h, giteeIssueTrigger({ nativeId: '34904144', displayNumber: '7', threadId: '34904144', title: 'Fix the login',
        body: '@agent-bot fix', author: { providerUserId: '1', login: 'alice' }, createdAt: at, updatedAt: at, webUrl: giteeIssue.html_url,
        comments: 0 }, 'agent-bot', { sourceId: 'gitee-0', repositoryId: G.id }))
      const gitlabTicket = accept(h, gitlabIssueTrigger({ nativeId: '9001', displayNumber: '7', threadId: '9001', title: 'Fix the login',
        body: '@agent-bot fix', author: { providerUserId: '1', login: 'alice' }, createdAt: at, updatedAt: at, webUrl: gitlabIssue.web_url,
        comments: 0 }, 'agent-bot', { sourceId: 'gitlab-1', repositoryId: L.id }))
      const host = (binding: RepositoryBinding, adapter: typeof gitlabForgeAdapter, sourceId: string): PullHost => ({ binding, adapter, sourceId,
        login: 'agent-bot', tickets: h.ctx(sourceId).tickets, threads: h.ctx(sourceId).threads, triggers: h.ctx(sourceId).triggers })
      const giteePullModel: ForgePull = { nativeId: '1446764', displayNumber: '3', title: 'Fix the login', body: '', state: 'open',
        author: { providerUserId: '1', login: 'agent-bot' }, createdAt: at, updatedAt: at, webUrl: giteePull.html_url,
        head: { ref: 'agent/fix-e2e', sha: 'a', repositoryId: G.providerRepositoryId, repositorySlug: G.slug },
        base: { ref: 'master', repositoryId: G.providerRepositoryId, repositorySlug: G.slug } }
      const gitlabPullModel: ForgePull = { nativeId: '5003', displayNumber: '3', title: 'Fix the login', body: '', state: 'open',
        author: { providerUserId: '1', login: 'agent-bot' }, createdAt: at, updatedAt: at, webUrl: gitlabPull.web_url,
        head: { ref: 'agent/fix-e2e', sha: 'b', repositoryId: L.providerRepositoryId }, base: { ref: 'main', repositoryId: L.providerRepositoryId } }
      expect(claimPull(host(G, giteeForgeAdapter, 'gitee-0'), giteeTicket.id, giteePullModel)).toBeUndefined()
      expect(claimPull(host(L, gitlabForgeAdapter, 'gitlab-1'), gitlabTicket.id, gitlabPullModel)).toBeUndefined()
      // A merge request claimed by one binding cannot be claimed by the other binding's ticket.
      expect(claimPull(host(L, gitlabForgeAdapter, 'gitlab-1'), giteeTicket.id, gitlabPullModel)).toContain('PR belongs to repository')
      const forge = fakeForge({ gitlabPullState: 'merged', giteePullState: 'closed' }); vi.stubGlobal('fetch', forge.fetch)
      await pollGitee(h.ctx('gitee-0'))
      await pollGitlab(h.ctx('gitlab-1'))
      expect(h.store.tickets.get(giteeTicket.id)!.ended).toMatchObject({ outcome: 'closed' })
      expect(h.store.tickets.get(gitlabTicket.id)!.ended).toMatchObject({ outcome: 'merged' })
    } finally { h.close() }
  })
})
