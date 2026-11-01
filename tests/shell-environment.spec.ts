import { describe, expect, it } from 'vitest'
import { registerShellEnvironment, type ShellAgent } from '../src/app/shell-environment.ts'
import type { Ticket } from '../src/core/index.ts'
import { testRepository } from './fixtures/deployment.ts'

type Execution = { agent?: ShellAgent | undefined }
type Contributor = { name: string; variables: Record<string, { description: string }>; resolve(execution: Execution): Record<string, string> }
function harness() {
  let contributor!: Contributor
  const agents = new Map<string, ShellAgent>()
  const ctx = { get: (name: string) => name === 'shellEnv' ? { register: (value: Contributor) => { contributor = value; return () => {} } } : undefined,
    agents: { get: (id: string) => agents.get(id) } }
  const ticket: Ticket = { id: 'ticket-a', title: 'Fix', decisionId: 'd', repositoryId: testRepository.id,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '1', updatedAt: '1', origin: { triggerId: 'issue-12', triggerIds: ['issue-12'] },
    execution: { name: 'fix', directory: '/work/github:101/fix', assignment: '' } }
  const host = { ctx, ticketOfSession: (id: string) => id === 'worker-ticket-a' ? ticket : undefined,
    repositoryOf: () => testRepository, credentialOf: () => ({ login: 'agent-bot', commitEmail: '7+agent-bot@users.noreply.github.com' }),
    triggerOf: () => ({ repositoryId: testRepository.id, meta: { number: 12, isPr: false } }) }
  const dispose = registerShellEnvironment(host)
  const worker: ShellAgent = { session: { header: { id: 'worker-ticket-a' } } }
  const child: ShellAgent = { session: { header: { id: 'child-1', parentSession: 'worker-ticket-a' } } }
  agents.set('worker-ticket-a', worker); agents.set('child-1', child)
  return { contributor, worker, child, dispose }
}

describe('worker shell environment', () => {
  it('gives a worker and its subagent the Ticket binding per shell command, and leaves the main Session unconstrained', () => {
    const h = harness()
    expect(h.contributor.name).toBe('dsh-superagent')
    const worker = h.contributor.resolve({ agent: h.worker })
    expect(worker).toMatchObject({ DSH_SUPERAGENT_TICKET: 'ticket-a', DSH_SUPERAGENT_DIR: '/work/github:101/fix',
      DSH_SUPERAGENT_REPOSITORY_ID: testRepository.id, DSH_SUPERAGENT_REPOSITORY_PROVIDER: 'github',
      DSH_SUPERAGENT_REPOSITORY: testRepository.slug, DSH_SUPERAGENT_REPOSITORY_ACCOUNT: 'agent-bot',
      DSH_SUPERAGENT_REPOSITORY_COMMIT_EMAIL: '7+agent-bot@users.noreply.github.com',
      DSH_SUPERAGENT_GITHUB_REPOSITORY: testRepository.slug, DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot',
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '7+agent-bot@users.noreply.github.com', DSH_SUPERAGENT_GITHUB_NUMBER: '12',
      DSH_SUPERAGENT_GITHUB_PR_HEAD: '' })
    // A subagent has no ticket itself, so it follows its worker parent to the same binding.
    expect(h.contributor.resolve({ agent: h.child })).toEqual(worker)
    // The main Session has no ticket marker; the shim therefore does not constrain it.
    expect(h.contributor.resolve({ agent: { session: { header: { id: 'master' } } } })).toEqual({})
    expect(h.contributor.resolve({})).toEqual({})
    h.dispose()
  })

  it('marks a worker whose ticket cannot be read, so its shim denies GitHub instead of inheriting another binding', () => {
    const h = harness()
    const orphan = h.contributor.resolve({ agent: { session: { header: { id: 'worker-missing' } } } })
    expect(orphan).toMatchObject({ DSH_SUPERAGENT_TICKET: 'missing', DSH_SUPERAGENT_GITHUB_REPOSITORY: '' })
  })
})
