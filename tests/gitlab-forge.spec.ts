/** The GitLab REST v4 contract at the forge boundary: documented routes, `PRIVATE-TOKEN`, paging, native IDs, and sanitized errors. */
import { describe, expect, it, vi } from 'vitest'
import type { RepositoryBinding } from '../src/repository.ts'
import { gitlabForgeAdapter } from '../src/forge/gitlab.ts'
import { ForgeHttpError } from '../src/forge/ports.ts'
import type { ForgeSetupEnvironment } from '../src/forge/ports.ts'

const token = 'gitlab-secret-token'
const binding: RepositoryBinding = { id: 'gitlab:1234', provider: 'gitlab', providerRepositoryId: '1234',
  slug: 'acme/group/widgets', webUrl: 'https://gitlab.com/acme/group/widgets', defaultBranch: 'main', credentialId: 'gitlab:gitlab-a',
  capabilities: gitlabForgeAdapter.capabilities, enabled: true }
const at = '2026-11-01T00:00:00.000Z'
const user = { id: 7, username: 'agent-bot', name: 'Agent', email: 'agent@example.com', bot: false }
const project = { id: 1234, path_with_namespace: binding.slug, web_url: binding.webUrl, default_branch: 'main',
  permissions: { project_access: { access_level: 30 }, group_access: null } }
const issue = (id: number, iid: number) => ({ id, iid, title: `Issue ${iid}`, description: '@agent-bot please', author: user,
  created_at: at, updated_at: at, web_url: `${binding.webUrl}/-/issues/${iid}`, user_notes_count: 1 })
const note = (id: number, body: string, system = false) => ({ id, body, author: system ? { ...user, username: 'gitlab-bot' } : user,
  created_at: at, updated_at: at, system })
const mergeRequest = (id: number, iid: number) => ({ id, iid, title: `MR ${iid}`, description: '@agent-bot please', state: 'opened', author: user,
  created_at: at, updated_at: at, merged_at: null, closed_at: null, web_url: `${binding.webUrl}/-/merge_requests/${iid}`,
  source_branch: `agent/fix-${iid}`, target_branch: 'main', sha: 'abc123', source_project_id: 1234, target_project_id: 1234 })

interface Call { url: URL; method: string; token: string | null; body: string; contentType: string | null }
/** A recording GitLab API stub whose routes mirror the documented endpoints this adapter uses. */
function gitlabStub(options: { project?: unknown; userStatus?: number; projectStatus?: number; errorMessage?: string } = {}) {
  const calls: Call[] = []
  const issues = [issue(9001, 7), issue(9002, 8)]
  const notes = [note(41, 'system note', true), note(42, '@agent-bot working on it')]
  const pulls = [mergeRequest(5003, 3), mergeRequest(5004, 4)]
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    calls.push({ url, method: init?.method ?? 'GET', token: headers.get('private-token'), body: String(init?.body ?? ''),
      contentType: headers.get('content-type') })
    const path = url.pathname
    const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } })
    if (path.endsWith('/user')) return options.userStatus ? json({ message: 'Unauthorized' }, options.userStatus) : json(user)
    if (path.endsWith('/projects/acme%2Fgroup%2Fwidgets')) return options.projectStatus
      ? json({ message: 'Not Found' }, options.projectStatus) : json(options.project ?? project)
    if (path.endsWith('/projects/1234/issues') && (init?.method ?? 'GET') === 'GET') {
      if (options.errorMessage) return json({ message: options.errorMessage }, 500)
      const page = url.searchParams.get('page')
      if (page === '2') return json([issues[1]], 200, { 'x-next-page': '' })
      return json([issues[0]], 200, { 'x-next-page': '2' })
    }
    if (path.endsWith('/projects/1234/issues/7') && (init?.method ?? 'GET') === 'GET') return json(issues[0])
    if (path.endsWith('/projects/1234/issues/7/notes')) {
      if (init?.method === 'POST') return json(note(43, JSON.parse(String(init.body)).body), 201)
      return json(notes, 200, { 'x-next-page': '' })
    }
    if (path.endsWith('/projects/1234/merge_requests') && (init?.method ?? 'GET') === 'GET') return json(pulls, 200, { 'x-next-page': '' })
    if (path.endsWith('/projects/1234/merge_requests') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { title: string; description: string; source_branch: string; target_branch: string }
      return json({ ...mergeRequest(5005, 5), title: body.title, description: body.description, source_branch: body.source_branch,
        target_branch: body.target_branch }, 201)
    }
    if (path.endsWith('/projects/1234/merge_requests/3') && (init?.method ?? 'GET') === 'GET') return json(pulls[0])
    if (path.endsWith('/projects/1234/merge_requests/3/notes')) {
      if (init?.method === 'POST') return json(note(44, JSON.parse(String(init.body)).body), 201)
      return json([note(45, 'system record', true), note(46, 'a discussion')], 200, { 'x-next-page': '' })
    }
    return json({ message: 'Not Found' }, 404)
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}
const environment = (stub: ReturnType<typeof gitlabStub>): ForgeSetupEnvironment => ({ probe: async () => '', executable: () => '',
  env: { GITLAB_TOKEN: token }, signal: new AbortController().signal, fetch: stub.fetch })
const read = { token, fetch: undefined as unknown as typeof globalThis.fetch }
const context = (stub: ReturnType<typeof gitlabStub>) => ({ ...read, fetch: stub.fetch })

describe('GitLab forge adapter', () => {
  it('resolves a nested project by its slug, keeps the numeric ID, and sends PRIVATE-TOKEN', async () => {
    const stub = gitlabStub()
    const resolution = await gitlabForgeAdapter.resolveRepository({ sourceId: 'gitlab', config: { repository: binding.slug } }, environment(stub))
    expect(resolution).toMatchObject({ repository: { providerRepositoryId: '1234', slug: 'acme/group/widgets', webUrl: binding.webUrl,
      defaultBranch: 'main' }, identity: { providerUserId: '7', login: 'agent-bot' }, push: true, credential: { reference: 'GITLAB_TOKEN',
      commitEmail: 'agent@example.com' } })
    expect(stub.calls.map(call => [call.method, call.url.pathname])).toEqual([
      ['GET', '/api/v4/user'], ['GET', '/api/v4/projects/acme%2Fgroup%2Fwidgets']])
    for (const call of stub.calls) expect(call.token).toBe(token)
    expect(JSON.stringify(resolution)).not.toContain(token)
    // The adapter reports honest capabilities and provider-controlled links.
    expect(gitlabForgeAdapter.capabilities).toMatchObject({ pulls: { read: true, create: true, comment: true, reviews: false }, ci: false,
      execution: true })
    expect(gitlabForgeAdapter.presentation.issueUrl(binding, '7')).toBe('https://gitlab.com/acme/group/widgets/-/issues/7')
    expect(gitlabForgeAdapter.presentation.pullUrl(binding, '3')).toBe('https://gitlab.com/acme/group/widgets/-/merge_requests/3')
    expect(gitlabForgeAdapter.pullThreadId({ nativeId: '5003' } as never)).toBe('pull:5003')
  })

  it('requires push access, and names a rejected token, an unreadable project, and a read-only project', async () => {
    const readOnly = gitlabStub({ project: { ...project, permissions: { project_access: { access_level: 20 } } } })
    await expect(gitlabForgeAdapter.resolveRepository({ sourceId: 'gitlab', config: { repository: binding.slug } }, environment(readOnly)))
      .rejects.toMatchObject({ code: 'tokenRepositoryReadOnly', place: 'gitlab', values: { provider: 'GitLab', account: 'agent-bot' } })
    await expect(gitlabForgeAdapter.resolveRepository({ sourceId: 'gitlab', config: { repository: binding.slug } },
      environment(gitlabStub({ userStatus: 401 })))).rejects.toMatchObject({ code: 'tokenCredentialRejected', place: 'gitlab' })
    await expect(gitlabForgeAdapter.resolveRepository({ sourceId: 'gitlab', config: { repository: binding.slug } },
      environment(gitlabStub({ projectStatus: 404 })))).rejects.toMatchObject({ code: 'tokenRepositoryUnreadable', place: 'gitlab',
      values: { repository: binding.slug, account: 'agent-bot', provider: 'GitLab' } })
    // No token is in a problem's text.
    const problem = await gitlabForgeAdapter.resolveRepository({ sourceId: 'gitlab', config: { repository: binding.slug } },
      environment(gitlabStub({ userStatus: 401 }))).then(() => undefined, (error: Error) => error)
    expect(problem).toBeDefined()
    expect(problem!.message).not.toContain(token)
  })

  it('reads Issues by project ID with updated_after, pages by X-Next-Page, and keeps global IDs apart from IIDs', async () => {
    const stub = gitlabStub()
    const first = await gitlabForgeAdapter.listIssues(binding, { since: at, limit: 1 }, context(stub))
    expect(first.items).toEqual([expect.objectContaining({ nativeId: '9001', displayNumber: '7', threadId: '9001', title: 'Issue 7',
      author: { providerUserId: '7', login: 'agent-bot', bot: false } })])
    expect(first.next).toBe('2')
    const query = stub.calls.at(-1)!.url
    expect(query.pathname).toBe('/api/v4/projects/1234/issues')
    expect(query.searchParams.get('updated_after')).toBe(at)
    expect(query.searchParams.get('order_by')).toBe('updated_at')
    expect(query.searchParams.get('sort')).toBe('asc')
    const second = await gitlabForgeAdapter.listIssues(binding, { since: at, cursor: first.next }, context(stub))
    expect(second.items.map(item => item.nativeId)).toEqual(['9002'])
    expect(second.next).toBeUndefined()
    expect(await gitlabForgeAdapter.readIssue(binding, '7', context(stub))).toMatchObject({ nativeId: '9001', displayNumber: '7' })
    expect(stub.calls.at(-1)!.url.pathname).toBe('/api/v4/projects/1234/issues/7')
  })

  it('excludes system notes from issue and merge-request reads, and writes notes with a JSON body', async () => {
    const stub = gitlabStub()
    const comments = await gitlabForgeAdapter.listComments(binding, { displayNumber: '7' }, {}, context(stub))
    expect(comments.items.map(comment => comment.nativeId)).toEqual(['42'])
    expect(stub.calls.at(-1)!.url.searchParams.get('activity_filter')).toBe('only_comments')
    const written = await gitlabForgeAdapter.createComment(binding, { displayNumber: '7' }, 'hello', context(stub))
    expect(written).toMatchObject({ nativeId: '43', body: 'hello' })
    expect(stub.calls.at(-1)!).toMatchObject({ method: 'POST', contentType: 'application/json', body: JSON.stringify({ body: 'hello' }) })
    const pullComments = await gitlabForgeAdapter.listPullComments(binding, { displayNumber: '3' }, {}, context(stub))
    expect(pullComments.items.map(comment => comment.nativeId)).toEqual(['46'])
  })

  it('lists, reads, creates, and comments on merge requests with source/target project identity', async () => {
    const stub = gitlabStub()
    const pulls = await gitlabForgeAdapter.listPulls(binding, { since: at }, context(stub))
    expect(pulls.items[0]).toMatchObject({ nativeId: '5003', displayNumber: '3', state: 'open', title: 'MR 3',
      head: { ref: 'agent/fix-3', sha: 'abc123', repositoryId: '1234' }, base: { ref: 'main', repositoryId: '1234' } })
    expect(stub.calls.at(-1)!.url.searchParams.get('updated_after')).toBe(at)
    expect(await gitlabForgeAdapter.readPull(binding, '3', context(stub))).toMatchObject({ nativeId: '5003', displayNumber: '3' })
    const created = await gitlabForgeAdapter.createPull(binding, { title: 'Fix', body: 'Body', head: 'agent/fix', base: 'main' }, context(stub))
    expect(created).toMatchObject({ nativeId: '5005', displayNumber: '5', head: { ref: 'agent/fix' }, base: { ref: 'main' } })
    expect(JSON.parse(stub.calls.at(-1)!.body)).toEqual({ title: 'Fix', description: 'Body', source_branch: 'agent/fix', target_branch: 'main' })
    const comment = await gitlabForgeAdapter.createPullComment(binding, { displayNumber: '3' }, 'done', context(stub))
    expect(comment).toMatchObject({ body: 'done' })
    expect(stub.calls.at(-1)!.url.pathname).toBe('/api/v4/projects/1234/merge_requests/3/notes')
  })

  it('normalizes GitLab states and sanitizes a provider error that echoes the token', async () => {
    const stub = gitlabStub({ errorMessage: `bad token ${token}` })
    await expect(gitlabForgeAdapter.listIssues(binding, {}, context(stub))).rejects.toMatchObject({ provider: 'gitlab', status: 500 })
    const error = await gitlabForgeAdapter.listIssues(binding, {}, context(stub)).then(() => undefined, (error: unknown) => error as ForgeHttpError)
    expect(error).toBeDefined()
    expect(error!.message).not.toContain(token)
    expect(error!.message).toContain('***')
    const states = [mergeRequest(1, 1), mergeRequest(2, 2), mergeRequest(3, 3), mergeRequest(4, 4)]
    // The adapter maps the four documented states; read each one through the same detail route by stubbing a stateful list.
    for (const [index, state] of (['opened', 'closed', 'merged', 'locked'] as const).entries()) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ ...states[index], state }]),
        { status: 200, headers: { 'content-type': 'application/json' } })))
      expect((await gitlabForgeAdapter.listPulls(binding, {}, { token, fetch: globalThis.fetch })).items[0]?.state)
        .toBe(state === 'merged' ? 'merged' : state === 'opened' ? 'open' : 'closed')
    }
    vi.unstubAllGlobals()
  })
})
