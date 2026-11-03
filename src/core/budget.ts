/**
 * The fixed worker step budget of a Ticket: how many DSH steps its worker may take before it must synthesize what it has,
 * and before it is stopped. The limits follow the Mandate's deliverable and are not configurable; the count is durable on
 * the Ticket, so a restart neither loses it nor counts a step twice. There is no wall-clock deadline: a long build or test
 * uses no step.
 */
import type { BudgetStatus, Deliverable, StepBudget, Ticket } from './model.ts'

/** Worker steps each deliverable allows before a soft checkpoint and before the hard stop. */
export const STEP_LIMITS: Record<Deliverable, { soft: number; hard: number }> = {
  analysis: { soft: 30, hard: 50 },
  change: { soft: 120, hard: 180 },
}
/** The budget together with the limits its Mandate's deliverable sets. */
export interface StepBudgetState extends StepBudget { deliverable: Deliverable; soft: number; hard: number }
/** What one worker step reached, as the Executor acts on it. */
export interface StepOutcome {
  /** The budget after the step, with its limits. */
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
/** A fresh budget for a newly accepted Ticket. */
export const freshBudget = (): StepBudget => ({ used: 0, lastSeq: -1, epoch: 1, status: 'ok' })
/**
 * The next budget epoch an explicit retry starts. The Session sequence watermark is kept, so steps counted before the retry
 * never count again, and nothing but `retryTicket` starts an epoch.
 */
export const retryBudget = (budget: StepBudget): StepBudget => ({ used: 0, lastSeq: budget.lastSeq, epoch: budget.epoch + 1, status: 'ok' })
/** A budget with the limits its deliverable sets. */
export const stateOf = (budget: StepBudget, deliverable: Deliverable): StepBudgetState =>
  ({ ...budget, deliverable, ...STEP_LIMITS[deliverable] })
/** What a Ticket has of its budget. */
export const budgetState = (ticket: Pick<Ticket, 'mandate' | 'budget'>): StepBudgetState =>
  stateOf(ticket.budget, ticket.mandate.deliverable)
/** The compact projection of a Ticket's budget: the count, both limits and the status, for cards and views. */
export const budgetView = (ticket: Pick<Ticket, 'mandate' | 'budget'>) => {
  const { status, used, soft, hard } = budgetState(ticket)
  return { status, used, soft, hard }
}
/**
 * Counts the worker step at Session sequence `seq`, once. A sequence number at or below the watermark is a replay or a
 * duplicate and changes nothing; a step after the hard stop only advances the watermark, so a later epoch does not count it.
 */
export function countStep(budget: StepBudget, deliverable: Deliverable, seq: number): StepResult {
  const limits = STEP_LIMITS[deliverable]
  const unchanged: StepResult = { budget, counted: false, changed: false, checkpoint: false, blocked: false }
  if (!Number.isSafeInteger(seq) || seq <= budget.lastSeq) return unchanged
  // Steps after the hard stop advance the watermark only: the worker is already stopped, and a retry starts a fresh epoch.
  if (budget.status === 'blocked') return { ...unchanged, budget: { ...budget, lastSeq: seq }, changed: true }
  const used = budget.used + 1
  const blocked = used >= limits.hard
  const checkpoint = !blocked && budget.status === 'ok' && used >= limits.soft
  const status: BudgetStatus = blocked ? 'blocked' : checkpoint ? 'checkpoint' : budget.status
  return { budget: { used, lastSeq: seq, epoch: budget.epoch, status }, counted: true, changed: true, checkpoint, blocked }
}
/**
 * The one steering prompt a worker gets at its soft limit: stop expanding scope, synthesize what is already known, mark
 * missing facts UNKNOWN and report promptly. An analysis turns nothing into new work; a change narrows to finishing the
 * verified change at hand.
 */
export function checkpointPrompt(deliverable: Deliverable, state: Pick<StepBudgetState, 'used' | 'hard'>): string {
  const prompt = `Step budget checkpoint: ${state.used} of this ticket's ${state.hard} worker steps are used. Stop expanding scope. `
    + 'Synthesize the evidence you already have, mark missing facts UNKNOWN, and report promptly.'
  return deliverable === 'analysis'
    ? `${prompt} Turn nothing you found into new work in this ticket.`
    : `${prompt} Narrow to finishing the current verified change; start no new investigation.`
}
/** The summary of the `blocked` report a hard stop records: the deliverable, the steps used and the limit. */
export function blockedReport(state: Pick<StepBudgetState, 'deliverable' | 'used' | 'hard'>): string {
  return `Worker step budget exhausted: ${state.deliverable}, ${state.used} of ${state.hard} steps used. `
    + 'Work stopped without a ready result; the ticket stays open and an explicit retry starts a fresh budget.'
}
