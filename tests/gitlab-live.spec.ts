/**
 * Opt-in live authenticated GitLab read smoke: resolves a disposable project's account and push access, reads its Issues and
 * merge requests, and proves the token is neither persisted nor printed. Set `GITLAB_LIVE_TOKEN_FILE` to a file containing
 * `GITLAB_TOKEN=<token>` (for example the running superagent process's `/proc/<pid>/environ`), and `GITLAB_LIVE_PROJECT` to a
 * project path the account can push to, such as `agent-group/dsh-superagent-gitlab-canary`. Both are required; the test is
 * skipped otherwise and never runs in normal CI.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gitlabForgeAdapter } from '../src/forge/gitlab.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'

const FILE = process.env.GITLAB_LIVE_TOKEN_FILE
const PROJECT = process.env.GITLAB_LIVE_PROJECT
/** The token from the file the operator points at, as `GITLAB_TOKEN=…` or the bare value; it is never logged. */
function liveToken(): string {
  const lines = readFileSync(FILE!, 'utf8').split(/\0|\n/).map(line => line.trim()).filter(Boolean)
  const entry = lines.find(line => line.startsWith('GITLAB_TOKEN='))
  const token = entry ? entry.slice('GITLAB_TOKEN='.length) : lines[0]
  if (!token) throw new Error(`${FILE} holds no token`)
  return token
}
const since = '2026-01-01T00:00:00.000Z'

describe.skipIf(!FILE || !PROJECT)('live GitLab read smoke', () => {
  it('validates project access, Issue and merge-request reads, and a token-free deployment', async () => {
    const token = liveToken()
    const resolution = await gitlabForgeAdapter.resolveRepository({ sourceId: 'gitlab-live', config: { repository: PROJECT, tokenEnv: 'GITLAB_TOKEN' } },
      { probe: async () => { throw new Error('no CLI probe for GitLab') }, executable: () => '', env: { GITLAB_TOKEN: token },
        signal: AbortSignal.timeout(60_000) })
    expect(resolution).toMatchObject({ repository: { slug: PROJECT }, identity: { login: expect.any(String) }, push: true,
      credential: { reference: 'GITLAB_TOKEN' } })
    expect(resolution!.repository.providerRepositoryId).toMatch(/^[0-9]+$/)
    const binding = { id: `gitlab:${resolution!.repository.providerRepositoryId}`, provider: 'gitlab',
      providerRepositoryId: resolution!.repository.providerRepositoryId, slug: resolution!.repository.slug, webUrl: resolution!.repository.webUrl,
      credentialId: 'gitlab:gitlab-live', capabilities: resolution!.capabilities, enabled: true }
    const context = { token, signal: AbortSignal.timeout(60_000) }
    const issues = await gitlabForgeAdapter.listIssues(binding, { since, limit: 1 }, context)
    expect(issues.items.every(item => item.nativeId !== item.displayNumber || item.threadId === item.nativeId)).toBe(true)
    if (issues.items[0]) {
      const detail = await gitlabForgeAdapter.readIssue(binding, issues.items[0].displayNumber, context)
      expect(detail.nativeId).toBe(issues.items[0].nativeId)
      const notes = await gitlabForgeAdapter.listComments(binding, detail, { limit: 100 }, context)
      expect(notes.items.every(note => !note.body.startsWith('changed'))).toBe(true)
    }
    const pulls = await gitlabForgeAdapter.listPulls(binding, { since, limit: 1 }, context)
    if (pulls.items[0]) {
      expect(await gitlabForgeAdapter.readPull(binding, pulls.items[0].displayNumber, context))
        .toMatchObject({ nativeId: pulls.items[0].nativeId })
    }
    expect(JSON.stringify({ resolution, binding })).not.toContain(token)
    const deployment = await resolveDeployment(testMachine({ stateDir: '/tmp/gitlab-live-state' }),
      [{ sourceId: 'gitlab-live', kind: 'gitlab', enabled: true, config: { repository: PROJECT, tokenEnv: 'GITLAB_TOKEN' } }],
      async () => { throw new Error('no GitHub probe for a GitLab-only deployment') }, '/usr/bin:/bin', { GITLAB_TOKEN: token })
    expect(deployment.github).toBeUndefined()
    expect(deployment.repositories[0]).toMatchObject({ id: binding.id, provider: 'gitlab', slug: PROJECT })
    expect(JSON.stringify(deployment)).not.toContain(token)
  })
})
