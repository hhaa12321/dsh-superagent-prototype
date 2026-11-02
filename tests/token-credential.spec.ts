/** The protected token-credential boundary shared by Gitee and GitLab: exact binding, provider, host, and repository. */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TokenCredentialBroker, tokenCredentialHelperFiles, tokenCredentialHelperPath } from '../src/forge/token-credential.ts'
import { tokenCredentialHost } from '../src/forge/adapters.ts'
import { writeEnvironment, workerGitConfig } from '../src/infra/environment.ts'
import { giteeForgeAdapter } from '../src/forge/gitee.ts'
import { gitlabForgeAdapter } from '../src/forge/gitlab.ts'
import { repositoryId, type RepositoryBinding } from '../src/repository.ts'
import { testDeployment } from './fixtures/deployment.ts'

const giteeToken = 'gitee-secret-token'
const gitlabToken = 'gitlab-secret-token'
const G: RepositoryBinding = { id: repositoryId('gitee', 51207621), provider: 'gitee', providerRepositoryId: '51207621', slug: 'acme/gitee-widgets',
  webUrl: 'https://gitee.com/acme/gitee-widgets', credentialId: 'gitee:gitee-a', capabilities: giteeForgeAdapter.capabilities, enabled: true }
const L: RepositoryBinding = { id: repositoryId('gitlab', 1234), provider: 'gitlab', providerRepositoryId: '1234', slug: 'acme/group/widgets',
  webUrl: 'https://gitlab.com/acme/group/widgets', credentialId: 'gitlab:gitlab-a', capabilities: gitlabForgeAdapter.capabilities, enabled: true }
const directories: string[] = []
const directory = (): string => { const value = mkdtempSync(join(tmpdir(), 'token-credential-')); directories.push(value); return value }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('protected token credentials', () => {
  it('answers only for the exact binding, provider, host, and repository of the helper', async () => {
    const stateDir = directory()
    const broker = new TokenCredentialBroker({ stateDir, host: tokenCredentialHost, lookup: id => id === G.id
      ? { binding: G, login: 'gitee-agent', token: giteeToken } : id === L.id ? { binding: L, login: 'gitlab-agent', token: gitlabToken } : undefined })
    await broker.start()
    try {
      for (const file of tokenCredentialHelperFiles(stateDir)) writeFileSync(file.path, file.body, { mode: file.mode })
      const helper = tokenCredentialHelperPath(stateDir)
      const ask = (provider: string, repository: string, host: string, path: string, binding = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        const env = { PATH: process.env.PATH, HOME: stateDir, DSH_SUPERAGENT_REPOSITORY_ID: binding || (provider === 'gitee' ? G.id : L.id),
          DSH_SUPERAGENT_REPOSITORY_PROVIDER: provider, DSH_SUPERAGENT_REPOSITORY: repository }
        const child = spawn(helper, ['get'], { env })
        let stdout = '', stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('close', code => resolve({ code, stdout, stderr }))
        child.stdin.end(`protocol=https\nhost=${host}\npath=${path}.git\n\n`)
      })
      const gitlab = await ask('gitlab', L.slug, 'gitlab.com', L.slug)
      expect(gitlab.code).toBe(0)
      expect(gitlab.stdout).toContain('username=gitlab-agent')
      expect(gitlab.stdout).toContain(`password=${gitlabToken}`)
      const gitee = await ask('gitee', G.slug, 'gitee.com', G.slug)
      expect(gitee.code).toBe(0)
      expect(gitee.stdout).toContain('username=gitee-agent')
      expect(gitee.stdout).toContain(`password=${giteeToken}`)
      // A Gitee-bound helper cannot ask for gitlab.com, and either provider cannot ask for another repository.
      expect(await ask('gitee', G.slug, 'gitlab.com', G.slug, G.id)).toMatchObject({ code: 1, stdout: '',
        stderr: expect.stringContaining('another Git host') })
      expect(await ask('gitee', L.slug, 'gitee.com', L.slug, G.id)).toMatchObject({ code: 1, stdout: '',
        stderr: expect.stringMatching(/outside this (ticket|binding)/) })
      expect(await ask('gitlab', G.slug, 'gitlab.com', G.slug, L.id)).toMatchObject({ code: 1, stdout: '',
        stderr: expect.stringMatching(/outside this (ticket|binding)/) })
      // A provider mismatch between the helper's environment and the binding fails closed.
      expect(await ask('gitee', L.slug, 'gitee.com', L.slug, L.id)).toMatchObject({ code: 1, stdout: '' })
      // The helper's files, the environment it reads, and the broker's answers contain no token except in the answer Git consumes.
      for (const name of ['worker-token-credential-helper', 'worker-token-credential-helper.cjs']) {
        expect(readFileSync(join(stateDir, name), 'utf8')).not.toContain(giteeToken)
        expect(readFileSync(join(stateDir, name), 'utf8')).not.toContain(gitlabToken)
      }
      expect(JSON.stringify({ provider: 'gitlab', repository: L.slug })).not.toContain(gitlabToken)
    } finally { await broker.stop() }
  })

  it('writes one provider-neutral helper and a host-scoped git configuration for both token providers', async () => {
    const stateDir = directory()
    const deployment = testDeployment({ stateDir, github: undefined, credentials: {}, repositories: [G, L],
      tokenCredentials: { [G.credentialId]: { tokenEnv: 'GITEE_TOKEN', login: 'gitee-agent', userId: '1' },
        [L.credentialId]: { tokenEnv: 'GITLAB_TOKEN', login: 'gitlab-agent', userId: '7' } } })
    await writeEnvironment(deployment, [])
    const config = readFileSync(workerGitConfig(stateDir), 'utf8')
    expect(config).toContain('[credential "https://gitee.com"]')
    expect(config).toContain('[credential "https://gitlab.com"]')
    expect(config).toContain('[url "https://gitlab.com/"]')
    expect(config).not.toContain(giteeToken)
    expect(config).not.toContain(gitlabToken)
    for (const file of tokenCredentialHelperFiles(stateDir)) expect(readFileSync(file.path, 'utf8')).not.toContain(gitlabToken)
    expect(JSON.stringify(deployment)).not.toContain(gitlabToken)
  })
})
