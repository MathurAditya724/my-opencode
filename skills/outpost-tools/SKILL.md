---
name: outpost-tools
description: Reference for opentower/outpost tools available to agents. Load this skill to understand the cron scheduling, lifecycle inspection, and session interaction tools. Auto-load at session start for autonomous agents.
license: Apache-2.0
metadata:
  audience: autonomous-agents
  autoload: true
---

# Outpost Tools Reference

This skill documents the tools provided by the opentower plugin for
managing scheduled jobs, inspecting dispatches/entities, and
interacting with other sessions. Load this skill when you need to
schedule work, check on other sessions, or understand the opentower
lifecycle.

## Cron Tools

Use these tools to schedule recurring or one-time delayed tasks.

### `create_cron_job`

Create a scheduled job that runs a prompt at specified times.

**Args:**
- `name` (required): Unique name for the job (e.g., `daily-triage`)
- `cron_expression` (required): Standard cron format (`minute hour day month weekday`)
  - `0 9 * * MON-FRI` — weekdays at 9am
  - `0 0 * * *` — daily at midnight
  - `*/15 * * * *` — every 15 minutes
- `prompt` (required): The prompt to execute when the job runs
- `agent` (optional): Agent to use (defaults to configured default)
- `entity_key` (optional): Entity key for session affinity (e.g., `owner/repo#42`).
  If set, executions reuse the same session as that entity.
- `timezone` (optional): Timezone for schedule (default: `UTC`)
- `run_once` (optional): If true, job is disabled after first execution.
  Use for one-time delayed tasks like CI polling.

**Important:** Recurring jobs must have intervals of at least 1 hour.
`run_once` jobs bypass this restriction.

**Confirmation required:** Always present job details to user and get
explicit confirmation before creating.

### `list_cron_jobs`

List all scheduled cron jobs with their status and next run time.

**Args:**
- `enabled_only` (optional): Filter by enabled/disabled status
- `limit` (optional): Max jobs to return (default: 50)

### `get_cron_job`

Get details of a specific job including its prompt and execution history.

**Args:**
- `identifier` (required): Job name or ID
- `include_executions` (optional): Include recent execution history

### `update_cron_job`

Modify an existing cron job.

**Args:**
- `identifier` (required): Job name or ID
- `enabled` (optional): Enable/disable the job
- `cron_expression` (optional): New schedule
- `prompt` (optional): New prompt
- `agent` (optional): New agent
- `timezone` (optional): New timezone
- `entity_key` (optional): New entity key (null to clear)

### `delete_cron_job`

Permanently delete a cron job and its execution history.

**Args:**
- `identifier` (required): Job name or ID

**Confirmation required:** Always confirm with user before deleting.

### `trigger_cron_job`

Manually trigger a job to run immediately, outside its normal schedule.

**Args:**
- `identifier` (required): Job name or ID

## Lifecycle Tools

Use these tools to inspect opentower dispatches, entities, and sessions.

### `list_dispatches`

List recent dispatches (sessions triggered by webhooks or cron).

**Args:**
- `limit` (optional): Max dispatches to return (default: 10)
- `status` (optional): Filter by status: `started`, `completed`, `failed`, `timeout`
- `event` (optional): Filter by event type (e.g., `issues`, `pull_request`, `check_suite`)

**Use case:** Scan recent activity, check session statuses, find session IDs.

### `list_entities`

List entities (issues/PRs) tracked by opentower with their session mappings.

**Args:**
- `limit` (optional): Max entities to return (default: 10)
- `repo` (optional): Filter by repository (e.g., `owner/repo`)

**Use case:** Find which session handles a specific issue/PR.

### `get_entity`

Get full details of a specific entity including all its dispatches and links.

**Args:**
- `entity_key` (required): Entity key (e.g., `owner/repo#42`)

**Returns:** Entity details, all dispatches, and linked entities.

### `read_session_messages`

Read messages from an opentower-managed session.

**Args:**
- `session_id` (required): Session ID (get from `list_dispatches` or `get_entity`)
- `limit` (optional): Max messages to return (default: 20)

**Use case:** Check what another session has done, read its conversation history.

### `post_session_message`

Post a message into an existing session. This sends a prompt to the
agent in that session.

**Args:**
- `session_id` (required): Session ID to post to
- `message` (required): The prompt to send
- `agent` (optional): Override the handling agent

**Confirmation required:** Always explain which session you will message,
show the message content, and get explicit user confirmation before posting.

**Use with care:** This directly interacts with another agent session.

## Common Patterns

### Scheduling a CI check after PR creation

After creating a draft PR, schedule a `run_once` job to check CI in ~10 minutes:

```
create_cron_job(
  name: "ci-check-pr-42",
  cron_expression: "13 14 * * *",  // ~10 min from now
  run_once: true,
  entity_key: "owner/repo#42",     // same session
  prompt: "Check CI status for PR #42. If passed, load mark-pr-ready skill."
)
```

### Finding a session for an entity

```
get_entity(entity_key: "owner/repo#123")
// Returns session_id, share_url, and all dispatches
```

### Checking recent failures

```
list_dispatches(status: "failed", limit: 5)
// Then read_session_messages to understand what went wrong
```

### Nudging a stalled session

```
// First, check what the session has done
read_session_messages(session_id: "...")

// Then, if appropriate and user-approved, send a nudge
post_session_message(
  session_id: "...",
  message: "CI has passed. Please continue with the review."
)
```

## Notes

- Dispatches are the source of truth for opentower sessions. Use
  `list_dispatches` for session discovery, not the SDK client directly.
- `post_session_message` bypasses dispatch creation — use it for simple
  nudges, not for starting new work.
- Session affinity via `entity_key` ensures related work happens in
  the same session, preserving context.
