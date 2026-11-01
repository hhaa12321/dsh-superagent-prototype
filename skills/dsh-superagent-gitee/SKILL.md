---
name: dsh-superagent-gitee
description: Work on a Gitee repository binding through Git and the provider-neutral pull-request and comment tools.
---

A Gitee ticket works through its RepositoryBinding: `$DSH_SUPERAGENT_REPOSITORY_ID`, `$DSH_SUPERAGENT_REPOSITORY_PROVIDER` (`gitee`), `$DSH_SUPERAGENT_REPOSITORY` (owner/name), `$DSH_SUPERAGENT_REPOSITORY_ACCOUNT`, and `$DSH_SUPERAGENT_REPOSITORY_COMMIT_EMAIL` from the execution environment. Do not use `gh`, a global Gitee account, or another repository; there is no fallback.

Git operations use HTTPS and the deployment's binding-scoped credential helper. The helper asks the running dsh-superagent process over its private socket; never print, echo, copy, or persist a token, and never put one in an argument, prompt, commit, or file. The helper refuses any host or repository other than this ticket's binding.

Clone and push only this ticket's repository. The ticket directory is `$DSH_SUPERAGENT_DIR`; if it has no `.git`, clone into it:

```sh
git clone "https://gitee.com/$DSH_SUPERAGENT_REPOSITORY.git" "$DSH_SUPERAGENT_DIR"
cd "$DSH_SUPERAGENT_DIR"
git config user.name "$DSH_SUPERAGENT_REPOSITORY_ACCOUNT"
git config user.email "$DSH_SUPERAGENT_REPOSITORY_COMMIT_EMAIL"
git switch -c "agent/$DSH_SUPERAGENT_NAME"
```

Commit on the ticket branch whose last path segment is `$DSH_SUPERAGENT_NAME`, then push it with `git push -u origin "agent/$DSH_SUPERAGENT_NAME"`. The PR claim accepts only a branch whose last path segment is the ticket name.

Open the pull request through the worker tool, not the Gitee web UI:

- `orchestrator_pull_request` with `operation: "create"`, `title`, `body`, `head: "agent/$DSH_SUPERAGENT_NAME"`, and `base` (defaults to the binding's default branch). The tool creates the Gitee PR and claims it for this ticket. It returns `native_id`, `display_number`, `state`, and `web_url`.
- `orchestrator_pull_request` with `operation: "claim"` and `native_id` (plus `display_number` when known) follows an existing source PR; a PR from another repository, another account, or another active ticket is refused.
- `orchestrator_pull_request` with `operation: "read"` reads a PR's state by `native_id` or `display_number`.

Report progress immediately after creating or claiming the PR, naming the immutable ID:

```json
{"state": "progress", "summary": "PR #<display> is open.", "pr_native_id": "<native_id>"}
```

The Gitee Source observes the claimed PR's state, comments, merge, and close. Do not merge, close, force-push, or change a PR's base branch unless the ticket explicitly asks and the Delivery requirements allow it. A merged PR ends the ticket; a closed PR ends it unmerged.

After accepted work, and before a final `ready` report that may end a ticket with no pull request, write the result comment once on the originating Issue through the worker tool:

```
orchestrator_comment with text: "..." and key: "result"
```

Use one stable key for one status (`result`, `progress`, `blocked`); repeating a key returns the comment already written instead of creating another, also after a restart. Do not repeat a comment with a different key to work around a retry. The tool writes only through this ticket's binding.

Read the original Trigger and acknowledge a new human request with `orchestrator_ack` before substantial work. Report through `orchestrator_report`; the orchestrator delivers the concise source-conversation message. Keep technical evidence and the PR link in the report and the PR, not in an unsolicited comment.
