/**
 * The worker step budget of a Ticket: how many DSH steps its worker may take before it must synthesize what it has, and
 * before it is stopped. The four thresholds are Execution settings; each Ticket snapshots its deliverable's pair when an
 * epoch starts, so editing the settings never changes a running epoch. The count is durable on the Ticket, so a restart
 * neither loses it nor counts a step twice. There is no wall-clock deadline: a long build or test uses no step.
 */
import type { BudgetStatus, Deliverable, StepBudget, Ticket } from './model.ts'

/** The soft checkpoint and the hard stop of one deliverable, in worker steps. */
export interface StepLimits { soft: number; hard: number }
/** Worker steps each deliverable allows when the Execution settings do not say otherwise. */
export const DEFAULT_STEP_LIMITS: Record<Deliverable, StepLimits> = {
  analysis: { soft: 30, hard: 50 },
  change: { soft: 120, hard: 180 },
}
/** The four configurable thresholds, by deliverable, as the Execution settings hold them. */
export type StepLimitsConfig = Record<Deliverable, StepLimits>
/** The budget together with its Ticket's deliverable; the limits are the epoch's own snapshot. */
export interface StepBudgetState extends StepBudget { deliverable: Deliverable }
/** What one worker step reached, as the Executor acts on it. */
export interface StepOutcome {
  /** The budget after the step, with its deliverable and snapshotted limits. */
  state: StepBudgetState
  /** The step count advanced; a replayed or duplicate sequence number leaves it false. */
  counted: boolean
  /** This step reached the soft limit: steer the worker once with `checkpointPrompt`. */
  checkpoint: boolean
  /** This step reached the hard limit: record the `blocked` report and stop the worker. */
  blocked: boolean
}
/** What one `step/start` event changes: nothing for a duplicate, a count, the checkpoint, or the hard stop. */
export interface StepResult {
  /** The budget after the event, equal to the one given when a replayed sequence number changes nothing. */
  budget: StepBudget
  /** The event advanced the step count. */
  counted: boolean
  /** The budget changed, so the caller persists it before acting on it. */
  changed: boolean
  /** This step reached the soft limit: the worker is steered with the checkpoint prompt once. */
  checkpoint: boolean
  /** This step reached the hard limit: the worker's report is `blocked` and its turn stops. */
  blocked: boolean
}
/** A fresh budget for a newly accepted Ticket, snapshotted with `limits`. */
export const freshBudget = (limits: StepLimits): StepBudget =>
  ({ used: 0, lastSeq: -1, epoch: 1, status: 'ok', soft: limits.soft, hard: limits.hard })
/**
 * The next budget epoch an explicit retry starts, snapshotted with the settings current at retry time. The Session sequence
 * watermark is kept, so steps counted before the retry never count again, and nothing but `retryTicket` starts an epoch.
 */
export const retryBudget = (budget: StepBudget, limits: StepLimits): StepBudget =>
  ({ used: 0, lastSeq: budget.lastSeq, epoch: budget.epoch + 1, status: 'ok', soft: limits.soft, hard: limits.hard })
/** A budget with its Ticket's deliverable. */
export const stateOf = (budget: StepBudget, deliverable: Deliverable): StepBudgetState => ({ ...budget, deliverable })
/** What a Ticket has of its budget. */
export const budgetState = (ticket: Pick<Ticket, 'mandate' | 'budget'>): StepBudgetState =>
  stateOf(ticket.budget, ticket.mandate.deliverable)
/** The compact projection of a Ticket's budget: the count, both snapshotted limits and the status, for cards and views. */
export const budgetView = (ticket: Pick<Ticket, 'mandate' | 'budget'>) => {
  const { status, used, soft, hard } = budgetState(ticket)
  return { status, used, soft, hard }
}
/**
 * Counts the worker step at Session sequence `seq`, once, against the limits the epoch was snapshotted with. A sequence
 * number at or below the watermark is a replay or a duplicate and changes nothing; a step after the hard stop only advances
 * the watermark, so a later epoch does not count it.
 */
export function countStep(budget: StepBudget, seq: number): StepResult {
  const unchanged: StepResult = { budget, counted: false, changed: false, checkpoint: false, blocked: false }
  if (!Number.isSafeInteger(seq) || seq <= budget.lastSeq) return unchanged
  // Steps after the hard stop advance the watermark only: the worker is already stopped, and a retry starts a fresh epoch.
  if (budget.status === 'blocked') return { ...unchanged, budget: { ...budget, lastSeq: seq }, changed: true }
  const used = budget.used + 1
  const blocked = used >= budget.hard
  const checkpoint = !blocked && budget.status === 'ok' && used >= budget.soft
  const status: BudgetStatus = blocked ? 'blocked' : checkpoint ? 'checkpoint' : budget.status
  return { budget: { ...budget, used, lastSeq: seq, status }, counted: true, changed: true, checkpoint, blocked }
}
/**
 * The one steering prompt a worker gets at its soft limit: stop expanding scope, start no other investigation, synthesize
 * the evidence already collected, mark missing facts UNKNOWN and report now. An analysis turns nothing it found into new
 * work in the same Ticket; a change narrows to finishing the verified change at hand.
 */
export function checkpointPrompt(deliverable: Deliverable, state: Pick<StepBudgetState, 'used' | 'hard'>): string {
  const prompt = `Step budget checkpoint: ${state.used} of this ticket's ${state.hard} worker steps are used. Stop expanding scope, `
    + 'do not start another investigation, synthesize the evidence you already have, mark missing facts UNKNOWN, and call '
    + 'orchestrator_report now with your final report. From here on only orchestrator_report may run; every other tool is refused.'
  return deliverable === 'analysis'
    ? `${prompt} Turn nothing you found into new work in this ticket.`
    : `${prompt} Narrow to finishing the current verified change.`
}
/** What the tool guard answers once a Ticket's budget reached its checkpoint: only `orchestrator_report` may still run. */
export const CHECKPOINT_DENIAL = 'The step budget checkpoint has passed: only orchestrator_report may run now. Submit your final '
  + 'report from the evidence you already collected; start no other investigation or tool call.'
/** The summary of the `blocked` report a hard stop records: the deliverable, the steps used and the limit. */
export function blockedReport(state: Pick<StepBudgetState, 'deliverable' | 'used' | 'hard'>): string {
  return `Worker step budget exhausted: ${state.deliverable}, ${state.used} of ${state.hard} steps used. `
    + 'Work stopped without a ready result; the ticket stays open and an explicit retry starts a fresh budget.'
}
/**
 * The one status notification a hard stop sends to the Ticket's origin conversation: it says the Ticket stopped because its
 * step budget ran out, names the deliverable and the steps used of the limit, and says an explicit retry starts a fresh
 * budget. It never presents the stop as a result. Its message ID is scoped by the Ticket and the budget epoch, so a restart
 * cannot send it twice and a later retry epoch sends its own.
 */
export function budgetStopNotice(state: Pick<StepBudgetState, 'deliverable' | 'used' | 'hard'>): string {
  return `This ticket stopped because its worker step budget was exhausted: ${state.deliverable}, ${state.used} of ${state.hard} `
    + 'steps used. This is not a ready result; its work stopped without one. An explicit retry starts a fresh budget.'
}
