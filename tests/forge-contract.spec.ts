/** The forge capability boundary's contract, exercised by a fake forge and by the recorded Gitee API v5 shapes. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RepositoryBinding } from '../src/repository.ts'
import type { ForgeAdapter, ForgeComment, ForgeIssue, ForgePage, ForgePull, ForgeReadContext, ForgeReadQuery } from '../src/forge/ports.ts'
import { giteeForgeAdapter, ForgeHttpError } from '../src/forge/gitee.ts'
import { githubForgeAdapter } from '../src/forge/github.ts'
import { ForgeRegistry } from '../src/forge/registry.ts'
import { forgeSupports, unsupportedCapabilities } from '../src/forge/capabilities.ts'

const DIR = join(import.meta.dirname, 'fixtures', 'gitee')
const recorded = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T
const at = (value: string): string => new Date(Date.parse(value)).toISOString()

const token = 'gitee-secret-token'
const giteeBinding: RepositoryBinding = { id: 'gitee:51207621', provider: 'gitee', providerRepositoryId: '51207621',
  slug: 'bourneW/dsh-superagent-gitee-canary', webUrl: 'https://gitee.com/bourneW/dsh-superagent-gitee-canary', credentialId: 'gitee:gitee',
  capabilities: giteeForgeAdapter.capabilities, enabled: true }

/** A recording HTTP stub for the recorded Gitee shapes, with the live response headers that drive pagination. */
function giteeHttp() {
  const urls: URL[] = []
  const headers: Record<string, string> = {}
  const routes: Record<string, unknown> = {
    '/user': recorded('user.json'),
    '/repos/bourneW/dsh-superagent-gitee-canary': recorded('repo.json'),
    '/repos/bourneW/dsh-superagent-gitee-canary/issues': recorded('issues.json'),
    '/repos/bourneW/dsh-superagent-gitee-canary/issues/IKS47K': recorded('issue.json'),
    '/repos/bourneW/dsh-superagent-gitee-canary/issues/IKS47K/comments': recorded('comments.json'),
    '/repos/bourneW/dsh-superagent-gitee-canary/pulls': [],
  }
  const pulls = recorded<{ headers: Record<string, string>; items: ForgePull[] }>('pulls.json')
  const page2 = recorded<{ headers: Record<string, string>; items: ForgePull[] }>('pulls-page2.json')
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    urls.push(url)
    const page = url.searchParams.get('page') ?? '1'
    const path = url.pathname.replace(/^\/api\/v5/, '')
    if (path.endsWith('/pulls') && path.startsWith('/repos/oschina/git-osc/')) {
      const source = page === '1' ? pulls : page2
      return new Response(JSON.stringify(source.items), { status: 200, headers: { total_page: source.headers.total_page ?? '7', total_count: '14' } })
    }
    if (path.endsWith('/repos/oschina/git-osc/pulls/2')) return new Response(JSON.stringify(recorded('pull.json')), { status: 200 })
    const body = routes[path]
    if (body === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: page === '1' && Array.isArray(body) ? { total_page: '1' } : {} })
  })
  return { fetch: fetchStub as unknown as typeof globalThis.fetch, urls, headers }
}

/** A second, in-memory provider shaped only by the boundary: it proves the ports are not Gitee-specific. */
function fakeForge(): ForgeAdapter {
  const repository = { providerRepositoryId: 'f1', slug: 'fake/one', webUrl: 'https://forge.test/fake/one', defaultBranch: 'main' }
  const author = { providerUserId: 'u1', login: 'alice' }
  const issue = (nativeId: string, displayNumber: string, created = '2026-11-01T00:00:00.000Z'): ForgeIssue => ({
    nativeId, displayNumber, threadId: nativeId, title: `Issue ${displayNumber}`, body: `@agent please look at ${displayNumber}`, author,
    createdAt: created, updatedAt: created, webUrl: `${repository.webUrl}/issues/${displayNumber}`, comments: 1 })
  const issues = [issue('1001', 'I1'), issue('1002', 'I2', '2026-11-02T00:00:00.000Z')]
  const comments: ForgeComment[] = [{ nativeId: 'c1', body: '@agent fixing', author, createdAt: '2026-11-01T01:00:00.000Z',
    updatedAt: '2026-11-01T01:00:00.000Z' }]
  const pulls: ForgePull[] = [2, 3].map(number => ({ nativeId: String(2000 + number), displayNumber: String(number), title: `PR ${number}`, body: '',
    state: 'open', author, createdAt: '2026-11-01T02:00:00.000Z', updatedAt: '2026-11-01T02:00:00.000Z',
    webUrl: `${repository.webUrl}/pulls/${number}`, head: { ref: `b${number}`, sha: 'abc' }, base: { ref: 'main' } }))
  const slice = <T>(items: T[], query: ForgeReadQuery): ForgePage<T> => {
    const start = Number(query.cursor ?? '0'), limit = query.limit ?? 100
    return { items: items.slice(start, start + limit), ...start + limit < items.length ? { next: String(start + limit) } : {} }
  }
  return {
    provider: 'fake',
    capabilities: { repository: 'read-write', identity: true, issues: { read: true, comment: true },
      pulls: { read: true, create: false, comment: false, reviews: false }, ci: false, execution: true },
    presentation: { issueUrl: (repository, number) => `${repository.webUrl}/issues/${number}`, pullUrl: (repository, number) => `${repository.webUrl}/pulls/${number}`,
      accountUrl: login => `https://forge.test/${login}` },
    async resolveRepository() {
      return { repository, identity: { providerUserId: 'u1', login: 'alice' }, push: true, capabilities: this.capabilities,
        credential: { reference: 'FAKE_TOKEN' } }
    },
    async listIssues(_binding, query) { return slice(issues, query) },
    async readIssue(_binding, displayNumber) { return issues.find(item => item.displayNumber === displayNumber)! },
    async listComments() { return { items: comments } },
    async listPulls(_binding, query) { return slice(pulls, query) },
    async readPull(_binding, displayNumber) { return pulls.find(item => item.displayNumber === displayNumber)! },
  }
}

/** The behavior every adapter must provide, independent of its provider's vocabulary. */
async function contract(adapter: ForgeAdapter, binding: RepositoryBinding, context: ForgeReadContext, expected: { issueNativeId: string;
  issueDisplay: string; commentNativeId: string; pullNativeId: string; pullDisplay: string; author: string; pullsBinding?: RepositoryBinding }) {
  // Identity is the immutable provider ID; the display value is separate metadata.
  const issues = await adapter.listIssues(binding, { limit: 100 }, context)
  expect(issues.items.length).toBeGreaterThan(0)
  const issue = issues.items.find(item => item.displayNumber === expected.issueDisplay)!
  expect(issue.nativeId).toBe(expected.issueNativeId)
  expect(issue.displayNumber).toBe(expected.issueDisplay)
  expect(issue.author.login).toBe(expected.author)
  expect(Number.isFinite(Date.parse(issue.createdAt))).toBe(true)
  expect(Number.isFinite(Date.parse(issue.updatedAt))).toBe(true)
  expect(await adapter.readIssue(binding, expected.issueDisplay, context)).toMatchObject({ nativeId: expected.issueNativeId })
  // Comment identity is the native comment ID, never a list position.
  const comments = await adapter.listComments(binding, issue, { limit: 100 }, context)
  expect(comments.items.map(item => item.nativeId)).toContain(expected.commentNativeId)
  // Pull-request identity keeps its numeric ID apart from the display number.
  const pullsBinding = expected.pullsBinding ?? binding
  const pulls = await adapter.listPulls(pullsBinding, { limit: 100 }, context)
  const pull = pulls.items.find(item => item.displayNumber === expected.pullDisplay)!
  expect(pull.nativeId).toBe(expected.pullNativeId)
  expect(pull.nativeId).not.toBe(pull.displayNumber)
  expect(pull.head.ref).toBeTruthy()
  expect(await adapter.readPull(pullsBinding, expected.pullDisplay, context)).toMatchObject({ nativeId: expected.pullNativeId })
  // Capability facts are honest, and an unsupported operation is reported as a fact rather than a read failure.
  expect(forgeSupports(adapter.capabilities, 'issues.read')).toBe(true)
  expect(forgeSupports(adapter.capabilities, 'pulls.read')).toBe(true)
  // Presentation builds the provider's canonical links from the binding and display values.
  expect(adapter.presentation.issueUrl(binding, issue.displayNumber)).toContain(`/issues/${issue.displayNumber}`)
  expect(adapter.presentation.pullUrl(binding, pull.displayNumber)).toContain(`/pulls/${pull.displayNumber}`)
  expect(adapter.presentation.accountUrl(issue.author.login)).toContain(issue.author.login)
  return { issues, comments, pulls, pull, unsupported: unsupportedCapabilities(adapter.capabilities) }
}

describe('forge adapter contract', () => {
  it('registers the built-in GitHub and Gitee adapters behind the same boundary', () => {
    const registry = new ForgeRegistry([githubForgeAdapter, giteeForgeAdapter, fakeForge()])
    expect(registry.all().map(adapter => adapter.provider)).toEqual(['fake', 'gitee', 'github'])
    expect(registry.adapter('gitee')).toBe(giteeForgeAdapter)
    expect(registry.adapter('github')).toBe(githubForgeAdapter)
    expect(() => registry.register(giteeForgeAdapter)).toThrow('already registered')
  })

  it('holds for a fake forge that shares no provider vocabulary with Gitee', async () => {
    const adapter = fakeForge()
    const binding: RepositoryBinding = { id: 'fake:f1', provider: 'fake', providerRepositoryId: 'f1', slug: 'fake/one',
      webUrl: 'https://forge.test/fake/one', credentialId: 'fake:fake', capabilities: adapter.capabilities, enabled: true }
    const result = await contract(adapter, binding, {}, { issueNativeId: '1001', issueDisplay: 'I1', commentNativeId: 'c1',
      pullNativeId: '2002', pullDisplay: '2', author: 'alice' })
    // The fake paginates by its own cursor while Gitee paginates by page number.
    const first = await adapter.listPulls(binding, { limit: 1 }, {})
    expect(first.next).toBe('1')
    expect((await adapter.listPulls(binding, { cursor: first.next, limit: 1 }, {})).items[0]!.displayNumber).toBe('3')
    expect(result.unsupported).toContain('ci')
  })

  it('holds for the recorded Gitee Issue, comment, and pull-request shapes', async () => {
    const http = giteeHttp()
    const context: ForgeReadContext = { token, fetch: http.fetch }
    // Repository resolution and identity/access use the authenticated user and the repository's push permission.
    const resolution = await giteeForgeAdapter.resolveRepository({ sourceId: 'gitee', config: { repository: giteeBinding.slug, tokenEnv: 'GITEE_TOKEN' } },
      { probe: async () => '', executable: () => '', env: { GITEE_TOKEN: token }, signal: new AbortController().signal, fetch: http.fetch })
    expect(resolution).toMatchObject({ repository: { providerRepositoryId: '51207621', slug: giteeBinding.slug,
      webUrl: 'https://gitee.com/bourneW/dsh-superagent-gitee-canary', defaultBranch: 'master' },
      identity: { providerUserId: '618074', login: 'bourneW' }, push: true, credential: { reference: 'GITEE_TOKEN' } })
    expect(resolution!.capabilities.pulls.create).toBe(false)
    expect(resolution!.capabilities.pulls.reviews).toBe(false)
    expect(resolution!.capabilities.ci).toBe(false)
    expect(resolution!.capabilities.execution).toBe(false)
    // The token travels in the Authorization header only: never in a URL, the resolution, or an error message.
    expect(http.urls.every(url => !url.href.includes(token))).toBe(true)
    expect(JSON.stringify(resolution)).not.toContain(token)
    const oschina: RepositoryBinding = { id: 'gitee:151', provider: 'gitee', providerRepositoryId: '151', slug: 'oschina/git-osc',
      webUrl: 'https://gitee.com/oschina/git-osc', credentialId: 'gitee:oschina', capabilities: giteeForgeAdapter.capabilities, enabled: true }
    const result = await contract(giteeForgeAdapter, giteeBinding, context, { issueNativeId: '34904144', issueDisplay: 'IKS47K',
      commentNativeId: '51958037', pullNativeId: '1446764', pullDisplay: '2', author: 'bourneW', pullsBinding: oschina })
    // Issues keep Gitee's string display number; pull requests keep the numeric id apart from the display number.
    expect(result.issues.items[0]!.threadId).toBe('34904144')
    expect(result.unsupported).toEqual(expect.arrayContaining(['issues.comment', 'pulls.create', 'pulls.comment', 'pulls.reviews', 'ci']))
  })

  it('pages Gitee pull requests with the provider cursors from the recorded shape', async () => {
    const http = giteeHttp()
    const oschina: RepositoryBinding = { id: 'gitee:151', provider: 'gitee', providerRepositoryId: '151', slug: 'oschina/git-osc',
      webUrl: 'https://gitee.com/oschina/git-osc', credentialId: 'gitee:oschina', capabilities: giteeForgeAdapter.capabilities, enabled: true }
    const context: ForgeReadContext = { token, fetch: http.fetch }
    const first = await giteeForgeAdapter.listPulls(oschina, { limit: 2 }, context)
    expect(first.items.map(item => item.displayNumber)).toEqual(['2', '3'])
    expect(first.next).toBe('2')
    const second = await giteeForgeAdapter.listPulls(oschina, { limit: 2, cursor: first.next }, context)
    expect(second.items.map(item => item.displayNumber)).toEqual(['4', '5'])
    expect(second.items[0]!.nativeId).not.toBe(first.items[0]!.nativeId)
    // Every request stayed on the recorded page parameter and carried no token in its query.
    expect(http.urls.filter(url => url.pathname.endsWith('/pulls')).map(url => url.searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('keeps a comment updated at exactly the cursor time, without sending Gitee a strict since filter', async () => {
    const http = giteeHttp()
    const issue = (await giteeForgeAdapter.listIssues(giteeBinding, {}, { token, fetch: http.fetch })).items[0]!
    const comments = await giteeForgeAdapter.listComments(giteeBinding, issue, { since: issue.updatedAt }, { token, fetch: http.fetch })
    expect(comments.items.map(item => item.nativeId)).toContain('51958037')
    const requests = http.urls.filter(url => url.pathname.endsWith('/comments'))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.searchParams.has('since')).toBe(false)
  })

  it('normalizes Gitee HTTP failures without echoing the token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: `bad token ${token}` }), { status: 401 }))
    await expect(giteeForgeAdapter.resolveRepository({ sourceId: 'gitee', config: { repository: giteeBinding.slug, tokenEnv: 'GITEE_TOKEN' } },
      { probe: async () => '', executable: () => '', env: { GITEE_TOKEN: token }, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'giteeTokenRejected', values: { output: expect.not.stringContaining(token) } })
    await expect(giteeForgeAdapter.listIssues(giteeBinding, {}, { token, fetch }))
      .rejects.toEqual(expect.objectContaining({ message: expect.not.stringContaining(token) }))
    await expect(giteeForgeAdapter.listIssues(giteeBinding, {}, { token, fetch: vi.fn(async () => new Response('{', { status: 200 })) }))
      .rejects.toBeInstanceOf(ForgeHttpError)
  })
})

describe('Gitee setup validation', () => {
  const environment = (env: Record<string, string | undefined>) => ({ probe: async () => '', executable: () => '',
    env, signal: new AbortController().signal })
  it('requires the credential reference to name a set environment variable, never a literal token', async () => {
    await expect(giteeForgeAdapter.resolveRepository({ sourceId: 'gitee', config: { repository: giteeBinding.slug, tokenEnv: 'MISSING_TOKEN' } },
      environment({}))).rejects.toMatchObject({ code: 'giteeTokenUnset', values: { variable: 'MISSING_TOKEN' } })
  })
  it('refuses a repository whose push permission the account lacks', async () => {
    const repo = { ...recorded<Record<string, unknown>>('repo.json'), permission: { pull: true, push: false, admin: false } }
    const fetch = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).pathname === '/api/v5/user'
      ? new Response(JSON.stringify(recorded('user.json')), { status: 200 })
      : new Response(JSON.stringify(repo), { status: 200 }))
    await expect(giteeForgeAdapter.resolveRepository({ sourceId: 'gitee', config: { repository: giteeBinding.slug, tokenEnv: 'GITEE_TOKEN' } },
      { ...environment({ GITEE_TOKEN: token }), fetch })).rejects.toMatchObject({ code: 'giteeRepositoryReadOnly', values: { repository: giteeBinding.slug } })
    // Reads stay available without a write capability: no create, comment, review, or CI operation is promised.
    expect(giteeForgeAdapter.capabilities.pulls.create).toBe(false)
  })
})
