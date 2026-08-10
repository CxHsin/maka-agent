# ScheduledTask — unified 定时任务

## Problem

Maka previously had two clocks:

1. **Plan reminders** (desktop SQLite + Electron timer) — UI-created notify jobs  
2. **Automation cron** (Runtime Host) — agent-created session runners  

The product word was one (“定时任务”), the data paths were two. Agent-created work never appeared in the desktop catalog.

## Design

One noun: **`ScheduledTask`**.

| Concern | Owner |
|---------|--------|
| Catalog + schedule math | Desktop `ScheduledTaskMainService` + SQLite `workflow_scheduled_tasks` |
| Fire admission and recovery | Desktop authority (`workflow_scheduled_task_fires`) |
| Due effects (notify / agent_run) | Desktop authority (sole scheduler) |
| Agent create/list/pause/resume/delete | `ScheduledTask` tool → Session-bound Desktop capability service |
| Heartbeat (session polling) | still `Automation` tool, session-scoped only |

### Effects

- `notify.local` / `notify.bot` — delivery only  
- `agent_run` — freeze execution template at create; on fire, create session + `turn.start`

### UI

The existing plan-reminder panel remains the view layer and is fed through
`scheduledTaskToPlanReminderView`. Renderer operations use the single
`scheduled-tasks:*` IPC surface; there is no second Plan Reminder API or store.

### Authority invariant

The Desktop process is the only catalog writer and the only scheduler. Runtime Host never opens
the ScheduledTask SQLite tables. Agent tools call the initiating Desktop through the existing
reverse Client Capability channel, so a successful create is immediately visible to the same
timer authority.

Before an effect crosses its irreversible boundary, the Store persists one unique fire claim per
task. Concurrent timer/manual requests therefore admit one effect. A claim that survives process
termination is settled as interrupted during startup instead of replaying an effect whose outcome
is unknown.

### Runtime boundary

Scheduled tasks run while the Desktop product is running. Missed tasks are claimed when Desktop
starts again. Headless Runtime Host clients without a Desktop capability provider cannot create or
manage this workspace catalog; heartbeat remains available for session-scoped Host polling.

## Key files

- `packages/core/src/scheduled-task.ts`  
- `packages/storage/src/scheduled-task-store.ts`  
- `packages/runtime/src/scheduled-task-tools.ts`  
- `packages/runtime-host/src/server/scheduled-task-authority.ts`  
- `apps/desktop/src/main/scheduled-tasks-main.ts`  
- `apps/desktop/src/main/runtime-host-boot.ts` (Desktop authority wiring)
