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
| Catalog + schedule math | `@maka/core/scheduled-task` + SQLite `workflow_scheduled_tasks` |
| Due fires (notify / agent_run) | Desktop `ScheduledTaskMainService` (sole timer) |
| Agent create/list/pause/resume/delete | `ScheduledTask` tool → same SQLite via Host authority |
| Heartbeat (session polling) | still `Automation` tool, session-scoped only |

### Effects

- `notify.local` / `notify.bot` — delivery only  
- `agent_run` — freeze execution template at create; on fire, create session + `turn.start`

### UI

Existing plan-reminder panel remains the glass; it is fed through `scheduledTaskToPlanReminderView`. IPC `plans:*` is a thin alias over the unified catalog.

### Non-goals

- Migrating old plan-reminder rows (greenfield; no dual-write)  
- Host-side fire loop (desktop owns the timer while the app is the product surface)

## Key files

- `packages/core/src/scheduled-task.ts`  
- `packages/storage/src/scheduled-task-store.ts`  
- `packages/runtime/src/scheduled-task-tools.ts`  
- `packages/runtime-host/src/server/scheduled-task-authority.ts`  
- `apps/desktop/src/main/scheduled-tasks-main.ts`  
- `apps/desktop/src/main/runtime-host-boot.ts` (wiring + `plans:*` alias)
