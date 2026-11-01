/**
 * Opt-in live authenticated Gitee read smoke: resolves the prepared canary's account, push access, Issue, comment, and pull
 * requests over the real API, then ingests the canary into a temporary Store twice. The write path is covered by the fake
 * forge in `gitee-execution.spec.ts`; final live write evidence needs a distinct human Gitee actor. Set `GITEE_LIVE_TOKEN_FILE` to a file
 * that contains `GITEE_TOKEN=<token>` (for example the running superagent process's `/proc/<pid>/environ`); the token is
 * read from that file, never from the command line, and never printed. Skipped without it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine, key, threadKey, type Assessor } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { giteeKind, pollWhenEnabled } from '../src/sources/gitee.ts'
import { giteeForgeAdapter } from '../src/forge/gitee.ts'
import { resolveDeployment } from '../src/deployment.ts'
import type { RepositoryBinding } from '../src/repository.ts'
import { testCommands, testDeployment, testMachine } from './fixtures/deployment.ts'

const SLUG = 'bourneW/dsh-superagent-gitee-canary'
const FILE = process.env.GITEE_LIVE_TOKEN_FILE

/** The token from the file the operator points at, as `GITEE_TOKEN=…` or the bare value; it is never logged. */
function liveToken(): string {
  const lines = readFileSync(FILE!, 'utf8').split(/\0|\n/).map(line => line.trim()).filter(Boolean)
  const entry = lines.find(line => line.startsWith('GITEE_TOKEN='))
  const token = entry ? entry.slice('GITEE_TOKEN='.length) : lines[0]
  if (!token) throw new Error(`${FILE} holds no token`)
  return token
}
const at = '2026-11-01T00:00:00.000Z'

describe.skipIf(!FILE)('live Gitee read smoke', () => {
  it('validates the canary account, repository access, Issue, comment, and pull reads without exposing the token', async () => {
    const token = liveToken()
    const resolution = await giteeForgeAdapter.resolveRepository({ sourceId: 'gitee', config: { repository: SLUG, tokenEnv: 'GITEE_TOKEN' } },
      { probe: async () => { throw new Error('no CLI probe for Gitee') }, executable: () => '', env: { GITEE_TOKEN: token },
        signal: AbortSignal.timeout(60_000) })
    expect(resolution).toMatchObject({ repository: { providerRepositoryId: '51207621', slug: SLUG, defaultBranch: 'master' },
      identity: { login: 'bourneW', providerUserId: '618074' }, push: true })
    const binding: RepositoryBinding = { id: 'gitee:51207621', provider: 'gitee', providerRepositoryId: '51207621', slug: SLUG,
      webUrl: resolution!.repository.webUrl, credentialId: 'gitee:gitee-live', capabilities: resolution!.capabilities, enabled: true }
    const context = { token, signal: AbortSignal.timeout(60_000) }
    const issues = await giteeForgeAdapter.listIssues(binding, { since: at }, context)
    const issue = issues.items.find(item => item.displayNumber === 'IKS47K')!
    expect(issue.nativeId).toBe('34904144')
    const comments = await giteeForgeAdapter.listComments(binding, issue, {}, context)
    expect(comments.items.map(item => item.nativeId)).toContain('51958037')
    // Live pull-request reads use a public repository; the canary has none. Detail reads by display number and keeps the id.
    const publicRepository: RepositoryBinding = { ...binding, id: 'gitee:151', providerRepositoryId: '151', slug: 'oschina/git-osc',
      webUrl: 'https://gitee.com/oschina/git-osc', credentialId: binding.credentialId }
    const pulls = await giteeForgeAdapter.listPulls(publicRepository, { limit: 1 }, context)
    expect(pulls.items[0]?.nativeId).toBeTruthy()
    expect(pulls.items[0]!.nativeId).not.toBe(pulls.items[0]!.displayNumber)
    await expect(giteeForgeAdapter.readPull(publicRepository, pulls.items[0]!.displayNumber, context))
      .resolves.toMatchObject({ nativeId: pulls.items[0]!.nativeId })
    // The adapter read the canary with the token in a header; the token is in no printed fact or binding.
    expect(JSON.stringify({ resolution, binding })).not.toContain(token)

    // Ingest the canary twice into a fresh Store, as a Source bound to it would, and prove native-ID dedupe.
    const directory = mkdtempSync(join(tmpdir(), 'gitee-live-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    try {
      const settings = SettingsSchema.parse({ sources: { 'gitee-live': { kind: 'gitee', enabled: true,
        config: { repository: SLUG, tokenEnv: 'GITEE_TOKEN', observeIssues: true, observeComments: true } } }, eval: { mode: 'off' },
        policy: { sources: { 'gitee-live': { allowed: [] } } } })
      store.saveSettings(settings)
      store.atomic(() => { store.repositories.reconcile([binding], [{ sourceId: 'gitee-live', repositoryId: binding.id }]) })
      const board = new HealthBoard()
      const sources = new SourceRegistry(() => store.settings(), board, undefined, sourceId => sourceId === 'gitee-live' ? binding : undefined)
      sources.register(giteeKind)
      const deployment = testDeployment({ github: undefined, credentials: {}, repositories: [binding],
        giteeCredentials: { [binding.credentialId]: { tokenEnv: 'GITEE_TOKEN', login: 'bourneW', userId: '618074' } } })
      const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
        assessor: { request: () => {} } satisfies Assessor, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
        outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, threadRepository: ref => ref.repositoryId ?? null,
        repositoryExists: id => !!store.repositories.get(id), emit: () => {}, prepareTicket: ticket => ticket })
      const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands: testCommands(() => deployment, {}, undefined, null),
        sources, deployment, ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }
      // Start before the Issue's creation so the canary is inside the first window; later windows only read new activity.
      store.set(KV.gitee.stream('gitee-live', binding.id, 'issues'), { since: at })
      process.env.GITEE_TOKEN = token
      try {
        await pollWhenEnabled(sourceContextOf(deps, giteeKind, 'gitee-live'))
        const thread = `${'gitee-live'}:34904144`
        const first = store.read.threadTriggers(thread, 100).map(trigger => trigger.id)
        expect(first).toEqual([key('gitee-issue', 'gitee-live', binding.id, '34904144'),
          key('gitee-comment', 'gitee-live', binding.id, '51958037')])
        expect(threadKey(store.threads.get(thread)!.ref)).toBe(thread)
        await pollWhenEnabled(sourceContextOf(deps, giteeKind, 'gitee-live'))
        expect(store.read.threadTriggers(thread, 100).map(trigger => trigger.id)).toEqual(first)
        // The persisted state holds no token and the binding keeps its immutable numeric repository ID.
        const values = store.keys('').map(name => JSON.stringify(store.get(name))).join('')
        expect(values).not.toContain(token)
        expect(store.repositories.get(binding.id)!.providerRepositoryId).toBe('51207621')
        console.log(JSON.stringify({ provider: 'gitee', repository: binding.id, account: resolution!.identity.login,
          issue: { nativeId: issue.nativeId, number: issue.displayNumber }, comment: comments.items[0]?.nativeId,
          triggers: first }))
      } finally { delete process.env.GITEE_TOKEN }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('resolves a Gitee-only deployment from the live token', async () => {
    const token = liveToken()
    const deployment = await resolveDeployment(testMachine({ stateDir: '/tmp/gitee-live-state' }),
      [{ sourceId: 'gitee-live', kind: 'gitee', enabled: true, config: { repository: SLUG, tokenEnv: 'GITEE_TOKEN' } }],
      async () => { throw new Error('no GitHub probe for a Gitee-only deployment') }, '/usr/bin:/bin', { GITEE_TOKEN: token })
    expect(deployment.github).toBeUndefined()
    expect(deployment.repositories[0]).toMatchObject({ id: 'gitee:51207621', provider: 'gitee', slug: SLUG })
    expect(deployment.giteeCredentials['gitee:gitee-live']).toMatchObject({ login: 'bourneW', userId: '618074' })
    expect(JSON.stringify(deployment)).not.toContain(token)
  })
})
