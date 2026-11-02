/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'gitee' | 'gitlab' | 'feishu' | 'token'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  tokenRepositoryUnset: ['token', 'The {provider} Source names no repository.'],
  tokenCredentialUnset: ['token', 'The {provider} credential reference names {variable}, which is not set in the dsh-superagent process.'],
  tokenCredentialRejected: ['token', '{provider} did not accept the configured token.'],
  tokenRepositoryUnreadable: ['token', '@{account} cannot read {repository} on {provider}.'],
  tokenRepositoryUnreported: ['token', '{provider} did not return {repository}.'],
  tokenRepositoryReadOnly: ['token', '@{account} cannot push to {repository} on {provider}.'],
  repositoryDuplicate: ['deployment', 'Two repository-bound Source instances resolve the same repository {repository}: {sources}. One binding can own one repository.'],
  sourceBindingFixed: ['deployment', 'The {source} Source is already bound to {from}, but setup resolved {to}. A Source instance cannot be rebound to another repository; add a new Source instance.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
/** A setup failure; `source` names the Source instance it belongs to when it does not stop the whole deployment. */
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string; source?: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  /** `provider` scopes a provider-neutral problem code (such as a token credential failure) to the Source that owns it. */
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}, provider?: SetupPlace) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = provider ?? place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
