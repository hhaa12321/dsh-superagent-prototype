/**
 * The durable worker step budget: the fixed limits each deliverable sets, counting a `step/start` once by Session sequence
 * number, the one soft checkpoint, the hard stop's blocked report, the fresh epoch an explicit retry starts, and the
 * projections a person reads.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, tokenCredentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { DEFAULT_STEP_LIMITS, blockedReport, budgetState, budgetStopNotice, checkpointPrompt, countStep, freshBudget, key, retryBudget } from '../src/core/index.ts'
import { ticketCard } from '../src/app/cards.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { ticketSummary } from '../src/app/views/records.ts'
import { testMachine } from './fixtures/deployment.ts'

const MEMBER = 'ou_alice', CHAT = 'oc_team'

describe('the budget rules', () => {
  it('keeps the built-in defaults by deliverable and counts the soft checkpoint once from the snapshot', () => {
    expect(DEFAULT_STEP_LIMITS).toEqual({ analysis: { soft: 30, hard: 50 }, change: { soft: 120, hard: 180 } })
    let budget = freshBudget(DEFAULT_STEP_LIMITS.analysis)
    expect(budget).toEqual({ used: 0, lastSeq: -1, epoch: 1, status: 'ok', soft: 30, hard: 50 })
    const seen: number[] = []
    for (let seq = 1; seq <= 30; seq++) { const step = countStep(budget, seq); budget = step.budget; if (step.checkpoint) seen.push(seq) }
    expect(seen).toEqual([30])
    expect(budget).toMatchObject({ used: 30, lastSeq: 30, epoch: 1, status: 'checkpoint' })
    // Later steps count on but checkpoint no more.
    for (let seq = 31; seq <= 40; seq++) { const step = countStep(budget, seq); budget = step.budget; expect(step.checkpoint).toBe(false) }
    expect(budget.used).toBe(40)
  })
  it('counts against the limits the epoch was snapshotted with, not the defaults its deliverable has now', () => {
    let budget = freshBudget({ soft: 2, hard: 3 })
    const first = countStep(budget, 1), second = countStep(first.budget, 2)
    expect(second.checkpoint).toBe(true)
    expect(countStep(second.budget, 3)).toMatchObject({ blocked: true, budget: { used: 3, status: 'blocked' } })
    // A different deliverable's limits never apply to a budget whose epoch already holds its own.
    budget = { ...freshBudget({ soft: 10, hard: 20 }), status: 'ok' }
    expect(countStep(budget, 1).budget).toMatchObject({ soft: 10, hard: 20 })
  })
  it('counts a replayed or duplicate sequence number once and keeps the epoch', () => {
    const first = countStep(freshBudget(DEFAULT_STEP_LIMITS.change), 7)
    expect(first).toMatchObject({ counted: true, budget: { used: 1, lastSeq: 7 } })
    for (const seq of [7, 7, 6, 0, -1]) expect(countStep(first.budget, seq)).toMatchObject({ counted: false, changed: false, budget: first.budget })
    expect(countStep(first.budget, 8).budget).toMatchObject({ used: 2, lastSeq: 8, epoch: 1 })
  })
  it('reaches the hard limit at the last allowed step, and counts no further step of that epoch', () => {
    let budget = { ...freshBudget(DEFAULT_STEP_LIMITS.change), used: DEFAULT_STEP_LIMITS.change.hard - 1, lastSeq: 179 }
    const last = countStep(budget, 180)
    expect(last).toMatchObject({ counted: true, blocked: true, budget: { used: 180, status: 'blocked' } })
    budget = last.budget
    // A step that arrives before the stop takes effect only advances the watermark; the count stays at the limit.
    expect(countStep(budget, 181)).toMatchObject({ counted: false, blocked: false, changed: true, budget: { used: 180, lastSeq: 181 } })
  })
  it('starts a fresh epoch only for a retry, with the settings current then, so old steps never count again', () => {
    const spent = { ...freshBudget({ soft: 120, hard: 180 }), used: 180, lastSeq: 500, status: 'blocked' as const }
    const retried = retryBudget(spent, { soft: 5, hard: 8 })
    expect(retried).toEqual({ used: 0, lastSeq: 500, epoch: 2, status: 'ok', soft: 5, hard: 8 })
    expect(countStep(retried, 400)).toMatchObject({ counted: false })
    expect(countStep(retried, 501)).toMatchObject({ counted: true, budget: { used: 1, epoch: 2 } })
  })
  it('words the checkpoint for each deliverable and the blocked report and status notice around the shared facts', () => {
    for (const deliverable of ['analysis', 'change'] as const) {
      const text = checkpointPrompt(deliverable, { used: DEFAULT_STEP_LIMITS[deliverable].soft, hard: DEFAULT_STEP_LIMITS[deliverable].hard })
      expect(text).toContain('Stop expanding scope')
      expect(text).toMatch(/do not start another investigation/)
      expect(text).toContain('UNKNOWN')
      expect(text).toContain('orchestrator_report now')
      expect(text).toMatch(/only orchestrator_report may run/)
    }
    expect(checkpointPrompt('analysis', { used: 30, hard: 50 })).toMatch(/new work/)
    expect(checkpointPrompt('change', { used: 120, hard: 180 })).toMatch(/verified change/)
    expect(blockedReport({ deliverable: 'analysis', used: 50, hard: 50 })).toContain('analysis, 50 of 50 steps used')
    const notice = budgetStopNotice({ deliverable: 'analysis', used: 50, hard: 50 })
    expect(notice).toContain('step budget was exhausted')
    expect(notice).toContain('analysis, 50 of 50 steps used')
    expect(notice).toContain('explicit retry starts a fresh budget')
    expect(notice).toMatch(/not a ready result/)
  })
})

/** The fake DSH host the runtime tests use, with a worker Session whose steps the test emits. */
async function startRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-budget-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' }
    : { id: 101, default_branch: 'master', permissions: { push: true } })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const answers: Record<string, string> = {
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {id, name: .full_name, url: .html_url, push: .permissions.push}`]: '{"id":101,"name":"acme/widgets","url":"https://github.com/acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(directory)}\0`,
    ['git config -z --show-origin --get-all credential.https://gitee.com.helper']: `file:${workerGitConfig(directory)}\0${tokenCredentialHelper(directory)}\0`,
    ['git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$']:
      `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(directory)}\0`,
  }
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
  }) }
  const agents = new Map<string, Record<string, unknown>>()
  // The worker guard each Session got, which the checkpoint test calls as DSH's tool pipeline would.
  const guards = new Map<string, (execution: { name: string; arguments: unknown }) => string | undefined>()
  const tools = new Map<string, Map<string, { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>>()
  const deliveries: { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }[] = []
  const resolveDefault = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const own = new Map<string, { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>()
      tools.set(sessionId, own)
      agentCtx.reflect.provide('tools', { register: (tool: { name: string }) => { own.set(tool.name, tool as never); return () => own.delete(tool.name) },
        get: () => undefined, restrict: vi.fn(() => () => {}),
        guard: vi.fn((check: (execution: { name: string; arguments: unknown }) => string | undefined) => {
          // A Session's guard is its last registered one; the ticket-ended guard and the checkpoint guard come together.
          guards.set(sessionId, check); return () => {}
        }) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries.push({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        agents.get(sessionId)!.status = 'running'
      })
      const cancel = vi.fn()
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), status: 'idle',
        inject: vi.fn(), session: { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() }, cancel,
        whenIdle: async () => {} })
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(resolveDefault), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }), inspect: vi.fn(async () => ({ events: [] })),
  }
  let ctx = new Context()
  const services = { agents, llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) }, sessionController: controller,
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} } }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources: {
    github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets', cli: AGENT } },
    feishu: { kind: 'feishu', enabled: true, config: { cli: BOT } } } }))
  seeded.close()
  let runtime = new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...settings.sources, feishu: { kind: 'feishu', enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })

  const runTool = async (sessionId: string, name: string, args: unknown) => {
    const tool = tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    const value = await tool.execute(args, { signal: new AbortController().signal })
    await runtime.idle()
    return value as Record<string, unknown>
  }
  async function accept(text: string, deliverable: 'change' | 'analysis' = 'change') {
    const trigger = feishuTrigger({ message_id: `om_${deliverable}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: text, create_time: String(Date.parse('2026-09-09T00:00:00Z')), mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    runtime.receive(trigger)
    await runtime.idle()
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', deliverable, trigger_id: trigger.id,
      title: 'Inspect', worktree_name: 'inspect', acknowledgement: 'On it.', repository_id: 'none' }] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    await runtime.idle()
    const ticketId = (results[0]!.ticket as { ticket_id: string }).ticket_id
    return { ticketId, sessionId: `worker-${ticketId}`, ticket: runtime.store.tickets.get(ticketId)! }
  }
  /** Emit one worker `step/start` at Session sequence `seq`, as a real DSH Session does. */
  const step = async (sessionId: string, seq: number) => {
    const agent = agents.get(sessionId)
    const session = (agent?.session ?? { id: sessionId }) as never
    ctx.emit('session/event', session, { type: 'step/start', seq, time: Date.now(), data: { turn: 1, step: seq } } as never)
    await runtime.idle()
  }
  const stop = async () => { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  /** Stop the host and start it again on the same state directory, as a process restart does. */
  const restart = async () => {
    await runtime.stop()
    // A new process has its own Cordis context; the host services and the Sessions the earlier context held carry over.
    ctx = new Context()
    for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
    runtime = new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())
    await runtime.ready
    return runtime
  }
  return { get runtime() { return runtime }, get ctx() { return ctx }, agents, guards, deliveries, runTool, accept, step, stop, restart, directory, services, controller }
}

let host: Awaited<ReturnType<typeof startRuntime>>
beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { await host.stop() })

describe('counting a worker\'s steps', () => {
  it('counts a worker\'s steps once by sequence number, and no other Session\'s', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 0, epoch: 1, status: 'ok' })
    await host.step(sessionId, 1)
    await host.step(sessionId, 2)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 2, lastSeq: 2 })
    // A replay and a duplicate of a counted sequence number count nothing.
    await host.step(sessionId, 2)
    await host.step(sessionId, 1)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 2, lastSeq: 2 })
    // The main Session and a worker Session of no Ticket count nothing either.
    await host.step(host.runtime.masterId, 90)
    await host.step('worker-unknown', 91)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 2, lastSeq: 2 })
  })

  it('steers one checkpoint prompt at the soft limit, and never again after a restart', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 梳理一下这个模块', 'analysis')
    const points: string[] = []
    for (let seq = 1; seq <= DEFAULT_STEP_LIMITS.analysis.soft; seq++) {
      await host.step(sessionId, seq)
      points.push(...host.deliveries.filter(item => item.sessionId === sessionId && item.mode === 'steer'
        && item.text.startsWith('Step budget checkpoint')).map(item => item.id))
    }
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 30, status: 'checkpoint' })
    const checkpoint = host.deliveries.filter(item => item.sessionId === sessionId && item.text.startsWith('Step budget checkpoint'))
    expect(checkpoint).toHaveLength(1)
    expect(checkpoint[0]!.text).toMatch(/UNKNOWN/)
    expect(points.every(id => id === checkpoint[0]!.id)).toBe(true)
    // Further steps do not repeat it, and the status stays at the checkpoint.
    for (let seq = 31; seq <= 35; seq++) await host.step(sessionId, seq)
    expect(host.deliveries.filter(item => item.text.startsWith('Step budget checkpoint'))).toHaveLength(1)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 35, status: 'checkpoint' })
  })

  it('allows only the final report through the worker guard once the checkpoint passed, for the worker and its subagents', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 梳理一下这个模块', 'analysis')
    const guarded = () => host.guards.get(sessionId)!
    expect(guarded()({ name: 'bash', arguments: { command: 'ls' } })).toBeUndefined()
    for (let seq = 1; seq <= 30; seq++) await host.step(sessionId, seq)
    expect(host.runtime.store.tickets.get(ticketId)!.budget.status).toBe('checkpoint')
    // Every work tool is refused with the reason that says what to do, while the final report stays allowed.
    for (const name of ['bash', 'read', 'edit', 'grep', 'subagent', 'web_search']) {
      expect(guarded()({ name, arguments: {} })).toMatch(/only orchestrator_report may run now/)
    }
    expect(guarded()({ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'done' } })).toBeUndefined()
    // A subagent of the worker gets the same guard, so it cannot keep investigating on the worker's behalf.
    await host.controller.create({ sessionId: 'child-1' })
    const child = host.agents.get('child-1') as unknown as { session: { header: { parentSession?: string } } }
    child.session.header = { parentSession: sessionId }
    await host.ctx.parallel('agent/created', { agent: child } as never)
    expect(host.guards.get('child-1')!({ name: 'bash', arguments: {} })).toMatch(/only orchestrator_report may run now/)
    expect(host.guards.get('child-1')!({ name: 'orchestrator_report', arguments: {} })).toBeUndefined()
    // A retry starts a fresh budget epoch and lifts the refusal.
    await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Checkpoint reached without a result.' })
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticketId })
    expect(guarded()({ name: 'bash', arguments: {} })).toBeUndefined()
  })

  it('keeps the count and the checkpoint across a restart, so no prompt is sent twice and no step counts twice', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 梳理一下这个模块', 'analysis')
    for (let seq = 1; seq <= 32; seq++) await host.step(sessionId, seq)
    const before = host.runtime.store.tickets.get(ticketId)!.budget!
    expect(before).toMatchObject({ used: 32, lastSeq: 32, status: 'checkpoint' })
    const next = await host.restart()
    expect(next.store.tickets.get(ticketId)!.budget).toEqual(before)
    // Its steps count on from the watermark, and the checkpoint prompt goes out once more only if the Session lost it: a
    // replayed sequence number changes nothing at all.
    await host.step(sessionId, 32)
    await host.step(sessionId, 33)
    expect(next.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 33, lastSeq: 33 })
    expect(host.deliveries.filter(item => item.text.startsWith('Step budget checkpoint'))).toHaveLength(1)
  })

  it('records a blocked report and stops the worker at the hard limit, and never reports ready', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    const agent = host.agents.get(sessionId) as { status: string; cancel: ReturnType<typeof vi.fn> }
    for (let seq = 1; seq < DEFAULT_STEP_LIMITS.change.hard; seq++) await host.step(sessionId, seq)
    expect(agent.cancel).not.toHaveBeenCalled()
    await host.step(sessionId, DEFAULT_STEP_LIMITS.change.hard)
    const ticket = host.runtime.store.tickets.get(ticketId)!
    expect(ticket.budget).toMatchObject({ used: 180, status: 'blocked' })
    expect(ticket.assignments.at(-1)!.report).toMatchObject({ state: 'blocked', summary: expect.stringMatching(/change, 180 of 180 steps used/) })
    expect(ticket.ended).toBeUndefined()
    expect(agent.cancel).toHaveBeenCalled()
    // The Ticket stays open and retryable, and a replayed step of the ended epoch reports nothing.
    const blocking = ticket.assignments.at(-1)!.report!.summary
    await host.step(sessionId, DEFAULT_STEP_LIMITS.change.hard)
    expect(host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!.summary).toBe(blocking)
    // A person's explicit retry starts a fresh budget and a new Assignment; the Ticket is not ended and not stopped.
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticketId })
    const retried = host.runtime.store.tickets.get(ticketId)!
    expect(retried.ended).toBeUndefined()
    expect(retried.budget).toMatchObject({ used: 0, lastSeq: 180, epoch: 2, status: 'ok' })
    expect(retried.assignments).toHaveLength(2)
    await host.step(sessionId, 181)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 1, lastSeq: 181, epoch: 2, status: 'ok' })
  })

  it('queues one status notice per budget epoch at the hard stop, never a result, and once more only after a retry', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    const stopId = (epoch: number) => key('budget-stop', ticketId, String(epoch))
    expect(host.runtime.store.receipts.get(stopId(1))).toBeUndefined()
    for (let seq = 1; seq <= DEFAULT_STEP_LIMITS.change.hard; seq++) await host.step(sessionId, seq)
    const notice = host.runtime.store.receipts.get(stopId(1))
    await host.runtime.sendReplies()
    expect(host.runtime.store.receipts.get(stopId(1))!).toMatchObject({ kind: 'notice', ticketId, status: 'sent' })
    expect(notice!.text).toContain('step budget was exhausted')
    expect(notice!.text).toContain('change, 180 of 180 steps used')
    expect(notice!.text).toMatch(/not a ready result/)
    expect(notice!.text).toContain('explicit retry starts a fresh budget')
    // It goes to the conversation the Ticket started in, and never presents the stop as a result.
    expect(notice!.channel.source).toBe('feishu')
    expect(notice!.text).not.toMatch(/is ready|PR #|has merged/)
    // A repeated step of the same epoch queues nothing twice, even when the stop is recorded again.
    await host.step(sessionId, DEFAULT_STEP_LIMITS.change.hard + 1)
    expect(host.runtime.store.receipts.waiting().filter(item => item.id === stopId(1))).toHaveLength(0)
    // A restart keeps the one receipt and has no reason to send another for the epoch.
    const next = await host.restart()
    expect(next.store.receipts.get(stopId(1))).toMatchObject({ status: 'sent' })
    // The next epoch notifies once on its own stop, under its own ID.
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticketId })
    expect(next.store.receipts.get(stopId(2))).toBeUndefined()
    for (let seq = 182; seq <= 361; seq++) await host.step(sessionId, seq)
    // It is queued for the new epoch (it may wait behind the blocked report's own delivery), once and with its own id.
    expect(next.store.receipts.get(stopId(2))!).toMatchObject({ kind: 'notice', ticketId })
    expect(next.store.receipts.get(stopId(2))!.text).toContain('change, 180 of 180 steps used')
  })

  it('keeps its blocked report when the cancelled turn ends with an abort error and an idle', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    const agent = host.agents.get(sessionId) as unknown as { status: string; cancel: ReturnType<typeof vi.fn> }
    for (let seq = 1; seq <= 180; seq++) await host.step(sessionId, seq)
    const blocked = host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!
    expect(blocked.state).toBe('blocked')
    // The cancel makes the turn fail and go idle, as DSH says; neither may replace the blocked report with a failure or waiting.
    agent.status = 'running'
    host.ctx.emit('agent/error', { agent, turn: 1, step: 180, error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) } as never)
    agent.status = 'idle'
    host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await host.runtime.idle()
    expect(host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report).toMatchObject({ state: 'blocked', summary: blocked.summary })
  })

  it('keeps the blocked report of the hard stop against any late report of that epoch', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    const replied = host.runtime.store.tickets.get(ticketId)!.channels.length
    for (let seq = 1; seq <= 180; seq++) await host.step(sessionId, seq)
    const blocked = host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!
    // A tool call of the cancelled step still lands and tries to report the work as done; the domain refuses it, so no
    // result reply and no end can happen from it, whatever order the cancellation and the tool call took.
    await expect(host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'All done.' })).rejects.toThrow(/blocked report stands/)
    // So do a failure, a dropped result and a progress report.
    for (const state of ['failed', 'dropped', 'progress'] as const) {
      await expect(host.runTool(sessionId, 'orchestrator_report', { state, summary: `${state} after the stop` }))
        .rejects.toThrow(/blocked report stands/)
    }
    const ticket = host.runtime.store.tickets.get(ticketId)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.assignments.at(-1)!.report).toMatchObject({ state: 'blocked', summary: blocked.summary })
    expect(ticket.channels.length).toBe(replied)
    // The cancelled turn's own idle cannot restate it as waiting either.
    const agent = host.agents.get(sessionId) as unknown as { status: string }
    agent.status = 'idle'
    host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await host.runtime.idle()
    expect(host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report).toMatchObject({ state: 'blocked', summary: blocked.summary })
    // It stays a Ticket a person must act on, and the retry accepts reports again because it starts a fresh epoch.
    expect(ticketSummary(ticket)).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true } })
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticketId })
    await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Starting the fresh budget.' })
    expect(host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report).toMatchObject({ state: 'progress' })
  })

  it('starts a fresh epoch only on an explicit retry, not for an automatic restart or ordinary work', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    for (let seq = 1; seq <= 6; seq++) await host.step(sessionId, seq)
    // An automatic restart replaces the Assignment and keeps the epoch.
    host.runtime.engine.assignmentInterrupted(ticketId, host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.id)
    await host.runtime.idle()
    expect(host.runtime.store.tickets.get(ticketId)!.assignments).toHaveLength(2)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 6, lastSeq: 6, epoch: 1 })
    // So does a later step of the new Assignment, and so does an Input the worker is given.
    await host.step(sessionId, 7)
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_note', { ticket_id: ticketId, text: 'A fact for context.' })
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 7, lastSeq: 7, epoch: 1 })
    // Only the person's explicit retry starts one, and it keeps the watermark.
    await host.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Needs a decision' })
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticketId })
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 0, lastSeq: 7, epoch: 2, status: 'ok' })
    // A sequence number from before the retry never counts again; a new step does.
    await host.step(sessionId, 4)
    await host.step(sessionId, 8)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 1, lastSeq: 8, epoch: 2 })
  })

  it('lets a restart after the hard stop keep the blocked report, and only a person\'s retry lift it', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    for (let seq = 1; seq <= 180; seq++) await host.step(sessionId, seq)
    const blocked = host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report!
    const next = await host.restart()
    const recovered = next.store.tickets.get(ticketId)!
    expect(recovered.budget).toMatchObject({ used: 180, status: 'blocked' })
    expect(recovered.assignments.at(-1)!.report).toMatchObject({ state: 'blocked', summary: blocked.summary })
    // It shows as a blocked Ticket a person must act on, and a step of the restarted worker of the same epoch counts nothing.
    expect(ticketSummary(recovered)).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true } })
    await host.step(sessionId, 181)
    expect(next.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 180, status: 'blocked', lastSeq: 181 })
  })

  it('blocks an analysis at its own 50-step limit, not the change limit', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 梳理一下这个模块', 'analysis')
    for (let seq = 1; seq < DEFAULT_STEP_LIMITS.analysis.hard; seq++) await host.step(sessionId, seq)
    expect(host.runtime.store.tickets.get(ticketId)!.assignments.at(-1)!.report?.state).not.toBe('blocked')
    await host.step(sessionId, DEFAULT_STEP_LIMITS.analysis.hard)
    const ticket = host.runtime.store.tickets.get(ticketId)!
    expect(ticket.budget).toMatchObject({ used: 50, status: 'blocked' })
    expect(ticket.assignments.at(-1)!.report).toMatchObject({ state: 'blocked', summary: expect.stringMatching(/analysis, 50 of 50 steps used/) })
  })

  it('shows the budget on the ticket card and the views a person reads', async () => {
    const { ticketId, sessionId } = await host.accept('@bot 修一下回归')
    await host.step(sessionId, 1)
    await host.step(sessionId, 2)
    const ticket = host.runtime.store.tickets.get(ticketId)!
    expect(ticketCard(ticket).budget).toEqual({ status: 'ok', used: 2, soft: 120, hard: 180 })
    expect(budgetState(ticket)).toMatchObject({ deliverable: 'change', used: 2, soft: 120, hard: 180 })
    const views = { store: host.runtime.store, sources: host.runtime.sources, links: host.runtime.links() }
    expect(ticketSummary(ticket).budget).toEqual({ status: 'ok', used: 2, soft: 120, hard: 180 })
    expect(ticketDetail(views, ticketId)!.budget).toEqual({ status: 'ok', used: 2, soft: 120, hard: 180 })
  })
})

describe('the budget a Ticket is accepted with', () => {
  it('starts fresh, with the limits of its deliverable', async () => {
    const { ticketId } = await host.accept('@bot 梳理一下这个模块', 'analysis')
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toEqual({ used: 0, lastSeq: -1, epoch: 1, status: 'ok', soft: 30, hard: 50 })
    expect(budgetState(host.runtime.store.tickets.get(ticketId)!)).toMatchObject({ used: 0, soft: 30, hard: 50, deliverable: 'analysis' })
  })
  it('snapshots the configured step budgets, keeps them across a restart, and retries under the settings current then', async () => {
    const settings = () => host.runtime.store.settings()
    // The settings a person saves hold both deliverables' pairs; only the Ticket's own pair is snapshotted.
    await host.runtime.settings.save('executor', { ...settings().executor, stepBudgets: { analysis: { soft: 4, hard: 6 },
      change: { soft: 7, hard: 9 } } }, host.runtime.store.blockRevision('executor'), 'panel')
    const { ticketId, sessionId } = await host.accept('@bot 梳理一下这个模块', 'analysis')
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ soft: 4, hard: 6, used: 0 })
    // Editing the settings leaves a running Ticket on its snapshot.
    await host.runtime.settings.save('executor', { ...settings().executor, stepBudgets: { analysis: { soft: 40, hard: 60 },
      change: { soft: 70, hard: 90 } } }, host.runtime.store.blockRevision('executor'), 'panel')
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ soft: 4, hard: 6 })
    for (let seq = 1; seq <= 6; seq++) await host.step(sessionId, seq)
    expect(host.runtime.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 6, soft: 4, hard: 6, status: 'blocked' })
    // A restart keeps the snapshot and the blocked report.
    const next = await host.restart()
    expect(next.store.tickets.get(ticketId)!.budget).toMatchObject({ soft: 4, hard: 6, used: 6, status: 'blocked' })
    // An explicit retry snapshots the settings current now and starts at zero used in the next epoch.
    await host.runTool(host.runtime.masterId, 'orchestrator_ticket_retry', { ticket_id: ticketId })
    expect(next.store.tickets.get(ticketId)!.budget).toMatchObject({ soft: 40, hard: 60, used: 0, epoch: 2, status: 'ok' })
    await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Starting the fresh budget.' })
    for (let seq = 7; seq <= 46; seq++) await host.step(sessionId, seq)
    expect(next.store.tickets.get(ticketId)!.budget).toMatchObject({ used: 40, soft: 40, hard: 60, status: 'checkpoint', epoch: 2 })
  })
  it('rejects a step budget that is out of bounds or whose hard stop is not above its checkpoint', async () => {
    const executor = host.runtime.store.settings().executor
    const save = (stepBudgets: typeof executor.stepBudgets) => host.runtime.settings.save('executor', { ...executor, stepBudgets },
      host.runtime.store.blockRevision('executor'), 'panel')
    const valid = { analysis: { soft: 3, hard: 5 }, change: { soft: 7, hard: 9 } }
    await expect(save({ ...valid, analysis: { soft: 5, hard: 5 } })).rejects.toThrow('hard must be greater than soft')
    await expect(save({ ...valid, change: { soft: 0, hard: 9 } })).rejects.toThrow()
    await expect(save({ ...valid, change: { soft: 7, hard: 1001 } })).rejects.toThrow()
    await expect(save({ ...valid, change: { soft: 7, hard: 9.5 } })).rejects.toThrow()
    // A missing deliverable, or an extra key, is refused rather than defaulted.
    await expect(save({ analysis: { soft: 3, hard: 5 } } as typeof valid)).rejects.toThrow()
    await expect(save({ ...valid, analysis: { soft: 3, hard: 5, note: 1 } } as typeof valid)).rejects.toThrow()
    expect(host.runtime.store.settings().executor.stepBudgets).toEqual(executor.stepBudgets)
  })
})
