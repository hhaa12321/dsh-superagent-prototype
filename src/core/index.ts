/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { CHECKPOINT_DENIAL, DEFAULT_STEP_LIMITS, blockedReport, budgetState, budgetView, budgetStopNotice, checkpointPrompt, countStep,
  freshBudget, retryBudget, stateOf, type StepBudgetState, type StepLimits, type StepLimitsConfig, type StepOutcome } from './budget.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { key } from './ids.ts'
