/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Repository identity and credentials are resolved per RepositoryBinding by `Commands`; the shim only selects the account.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { tokenCredentialHelperFiles, tokenCredentialHelperPath } from '../forge/token-credential.ts'
import { tokenCredentialHost } from '../forge/adapters.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
export const workerCredentialHelper = (stateDir: string): string => join(stateDir, 'worker-credential-helper')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
/** Git's credential helper command: a wrapper that admits only the ticket's repository; see `writeEnvironment`. */
export const credentialHelper = (stateDir: string): string => `!${shellQuote(workerCredentialHelper(stateDir))}`
/** The token credential helper command, whose helper asks the host broker for one binding's credential. */
export const tokenCredentialHelper = (stateDir: string): string => `!${shellQuote(tokenCredentialHelperPath(stateDir))}`
/** The unique Git hosts of the deployment's token-authenticated bindings, in binding order. */
function tokenCredentialHosts(deployment: Pick<Deployment, 'repositories'>): string[] {
  return [...new Set(deployment.repositories.map(binding => tokenCredentialHost(binding.provider))
    .filter((host): host is string => host !== undefined))]
}

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A token-authenticated forge's token stays in the dsh-superagent process: setup must not remove it from the host
    // environment, and DSH's SENSITIVE_ENV_PATTERN already strips credential-shaped names such as GITEE_TOKEN or
    // GITLAB_TOKEN from every worker subprocess.
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.some(line => line.includes(marker)))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/** One repository slug with the CLI of its binding's credential, in repository order. */
function credentialOfBinding(deployment: Pick<Deployment, 'repositories' | 'credentials' | 'github'>): { slug: string; cli: string }[] {
  const result: { slug: string; cli: string }[] = []
  const seen = new Set<string>()
  for (const binding of deployment.repositories) {
    const credential = deployment.credentials[binding.credentialId]
    if (!credential || seen.has(binding.slug)) continue
    seen.add(binding.slug)
    result.push({ slug: binding.slug, cli: credential.cli })
  }
  return result
}
/** Shell `case` lines selecting a binding's CLI by its repository value, failing closed for an unmapped repository. */
function cliCase(variable: string, deployment: Pick<Deployment, 'repositories' | 'credentials' | 'github'>): string[] {
  const entries = credentialOfBinding(deployment)
  return [
    `  case "${variable}" in`,
    ...entries.map(entry => `    ${shellQuote(entry.slug)}) real=${shellQuote(entry.cli)} ;;`),
    '    *) echo "dsh-superagent: no GitHub credential is configured for this repository binding" >&2; exit 1 ;;',
    '  esac',
  ]
}

/** The shell fragment that keeps a ticket's shared `gh` CLI from addressing another repository, with its binding's credential. */
function bindingGuard(deployment: Pick<Deployment, 'repositories' | 'credentials' | 'github'>): string {
  return [
    '  allowed=${DSH_SUPERAGENT_GITHUB_REPOSITORY:-}',
    '  if [ -z "$allowed" ]; then echo "dsh-superagent: no repository binding is active for this shell; GitHub commands are unavailable" >&2; exit 1; fi',
    ...cliCase('$allowed', deployment),
    '  export GH_REPO="$allowed"',
    '  # `gh api` is the easiest way around the flags below: admit only this repository and the account endpoints the prompts use.',
    '  if [ "$1" = api ]; then',
    '    endpoint=; found=0',
    '    for arg in "$@"; do',
    '      if [ "$found" = 1 ]; then case "$arg" in -*) ;; *) endpoint=$arg; break ;; esac; continue; fi',
    '      [ "$arg" = api ] && found=1',
    '    done',
    '    endpoint=${endpoint#/}',
    '    case "$endpoint" in',
    '      repos/"$allowed"|repos/"$allowed"/*|user|users/*) ;;',
    '      *) echo "dsh-superagent: gh api may only read this ticket\'s repository $allowed or the account" >&2; exit 1 ;;',
    '    esac',
    '  fi',
    '  bad=0; want=0',
    '  for arg in "$@"; do',
    '    if [ "$want" = 1 ]; then want=0; case "$arg" in "$allowed"|"$allowed"/*) ;; *) bad=1 ;; esac; continue; fi',
    '    case "$arg" in',
    '      -R|--repo) want=1 ;;',
    '      --repo=*) want=0; rest=${arg#--repo=}; case "$rest" in "$allowed"|"$allowed"/*) ;; *) bad=1 ;; esac ;;',
    '      repos/*) rest=${arg#repos/}; owner=${rest%%/*}; rest=${rest#*/}; name=${rest%%/*}; case "$owner/$name" in "$allowed") ;; *) bad=1 ;; esac ;;',
    '      https://github.com/*) rest=${arg#https://github.com/}; owner=${rest%%/*}; rest=${rest#*/}; name=${rest%%/*}; name=${name%.git}; case "$owner/$name" in "$allowed") ;; *) bad=1 ;; esac ;;',
    '      git@github.com:*) rest=${arg#git@github.com:}; owner=${rest%%/*}; rest=${rest#*/}; name=${rest%%/*}; name=${name%.git}; case "$owner/$name" in "$allowed") ;; *) bad=1 ;; esac ;;',
    '    esac',
    '  done',
    '  if [ "$bad" = 1 ] || [ "$want" = 1 ]; then echo "dsh-superagent: this worker is bound to $allowed, not another repository" >&2; exit 1; fi',
    'exec "$real" "$@"',
  ].join('\n')
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'github' | 'credentials' | 'repositories' | 'feishu'>,
  blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  // A worker's shell receives the ticket's binding as DSH_SUPERAGENT_GITHUB_REPOSITORY (src/app/shell-environment.ts).
  // The shim selects that binding's CLI, constrains repository selection to it, and fails closed for an unmapped repository.
  await shim('gh', `${withoutShims}
${bindingGuard(deployment)}`)
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh${github ? `, which acts as ${github.login}` : ''}.`))
  }
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  // The credential helper admits only the ticket's repository: git asks per path (useHttpPath) and the shell
  // environment supplies the ticket binding for each worker command.
  await own(workerCredentialHelper(stateDir), [
    '#!/bin/sh',
    MARKER,
    'if [ -z "${DSH_SUPERAGENT_GITHUB_REPOSITORY:-}" ]; then',
    '  echo "dsh-superagent: no repository binding is active for this shell; GitHub credentials are unavailable" >&2',
    '  exit 1',
    'fi',
    'input=$(cat)',
    "  repo=$(printf '%s\\n' \"$input\" | sed -n 's|^url=https://[^/]*/||p;s|^path=||p' | head -n 1)",
    '  repo=${repo%.git}',
    '  case "$repo" in',
    '    "${DSH_SUPERAGENT_GITHUB_REPOSITORY}"|"${DSH_SUPERAGENT_GITHUB_REPOSITORY}/"*) ;;',
    '    *) echo "dsh-superagent: credentials for $repo are outside this ticket\'s repository ${DSH_SUPERAGENT_GITHUB_REPOSITORY}" >&2; exit 1 ;;',
    '  esac',
    ...cliCase('$repo', deployment),
    "  printf '%s\\n' \"$input\" | \"$real\" auth git-credential \"$@\"",
  ].join('\n') + '\n', 0o755)
  // The token helper contains no secret: it names the binding the shell environment carries and asks the host broker over
  // its private socket. Git is told to use it only for the hosts of this deployment's token-authenticated bindings, so a
  // worker cannot address another provider's host.
  for (const file of tokenCredentialHelperFiles(stateDir)) await own(file.path, file.body, file.mode)
  const tokenHosts = tokenCredentialHosts(deployment)
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    // A credential is resolved for a concrete repository path, never the host alone, so the helper can enforce the binding.
    '[credential]', '\thelper =', '\tuseHttpPath = true',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(stateDir))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com:',
    ...tokenHosts.flatMap(host => [[`[credential "https://${host}"]`, `\thelper = ${gitQuote(tokenCredentialHelper(stateDir))}`],
      [`[url "https://${host}/"]`, `\tinsteadOf = git@${host}:`, `\tinsteadOf = ssh://git@${host}:`]]).flat(),
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub CLI helper and every token credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repositories'>, subprocess: SubprocessRuntime,
  signal: AbortSignal): Promise<void> {
  const { stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = async (host: string): Promise<string> => await runAsWorker(subprocess,
    ['git', 'config', '-z', '--show-origin', '--get-all', `credential.https://${host}.helper`], stateDir,
    AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')
  if (await helpers('github.com') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(stateDir), ''].join('\0')) throw new SetupError('gitTooOld')
  for (const host of tokenCredentialHosts(deployment)) {
    if (await helpers(host) !== [`file:${workerGitConfig(stateDir)}`, tokenCredentialHelper(stateDir), ''].join('\0')) throw new SetupError('gitTooOld')
  }
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
