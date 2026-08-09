# Automation Domain · Maka Code Analysis and Architecture Design

## 1. Code Map

The Automation domain spans 4 packages and about 18 `*automation*` files plus a cron compiler — a mature "has-code-but-no-docs" feature domain in Maka. By layer:

| Layer | Files | Responsibility |
|---|---|---|
| **core (types/pure functions)** | `packages/core/src/automation.ts` | Domain model: `AutomationDefinition`, `AutomationPendingFire`, `AutomationExecutionTemplate`, `AutomationAuthoritySnapshot`; text-length limits (dual caps of code-units + UTF-8 bytes) and truncation utilities |
| | `packages/core/src/cron-expression.ts` | 5-field cron compiler: `compileCronExpression` (two compatible profiles), bounded minute-scan `nextAfter`, `matchesCronField` compat entry |
| | `packages/core/src/runtime-event.ts` | Turn-origin validation: `isTurnOrigin` supports `kind:'automation'` (~L729) |
| **runtime (pure logic/tools)** | `packages/runtime/src/automation-state.ts` | `AutomationManager` (CRUD, state machine, jitter, `computeNextCronFire`, restart reconcile); exports `MAX_AUTOMATIONS_PER_SESSION=20`, `MAX_CONSECUTIVE_FAILURES=5`, `DEFAULT_EXPIRY_DAYS=7` |
| | `packages/runtime/src/automation-tools.ts` | The model-side single `Automation` tool (mode: create/delete/list/pause/resume), zod schemas, rich error copy |
| | `packages/runtime/src/automation-can-fire.ts` | Pure-function fire gating `evaluateAutomationCanFire` (kind-aware, incognito, idle-state set `HEARTBEAT_IDLE_STATUSES`) |
| | `packages/runtime/src/automation-schedule-policy.ts` | Scheduling constants: `FIRE_CHECK_INTERVAL_MS=5000`, `DEFER_WINDOW_MS=45min` |
| **runtime-host (orchestration)** | `server/automation-coordinator.ts` | `HostAutomationCoordinator`: durable authority (revision-based commits, serial lane, snapshot rollback), model-tool permission, fire admission/defer/failure/settlement |
| | `server/automation-fire-coordinator.ts` | `HostAutomationFireCoordinator`: 5s tick scheduling loop, canFire, fire launch (cron session creation), AgentRun identity binding |
| | `server/automation-errors.ts` | `AutomationAuthorityInvariantError` (invariant violation → crash/drain) |
| | `protocol/automation.ts` | `automation.query` / `automation.mutate` protocol (pagination, revision-change detection, projection) |
| | `server/execution-composition.ts` | Assembly: `prepareRecovery→recover→start` (L1158-1171), residency |
| **storage (persistence)** | `storage/automation-authority.ts` | SQLite authority: revision optimistic concurrency, atomic commits, relational invariants, branded writer gating |
| | `storage/automation-store.ts` | Legacy facade (loadAll/save/remove/sync, 4-retry CAS on top of authority) |
| | `storage/sqlite-automation-schema.ts` | Schema v1: `automation_authority_state`, `automation_definitions`, `automation_pending_fires` |
| **tests** | `runtime/__tests__/automation.test.ts`, `runtime-host/__tests__/{automation-coordinator,automation-protocol,automation-two-client-uds}.test.ts`, `storage/__tests__/automation-authority.test.ts` | Scheduling, recovery, concurrency, multi-client UDS |
| **UI** | `ui/src/tool-activity/result-projection.ts` | Dedicated rendering hook for the `Automation` tool card |

## 2. Core Data Model and Flows

**Data model** (`core/automation.ts`):
- `AutomationKind = 'heartbeat' | 'cron'`; `AutomationStatus = 'active' | 'paused' | 'completed' | 'expired'`
- `AutomationSchedule = cron(expression) | interval(seconds) | once(delaySeconds)`
- `AutomationDefinition`: beyond the base fields has `nextFireAt / lastFireAt / fireCount / maxFires / expiresAt / lastError / consecutiveFailures / durable / deferredFireCount / execution`
- `AutomationPendingFire`: durable execution intent (`admitted → running`), carrying `turnId / runId / userMessageId / scheduledFor / execution`, **atomically removed when the canonical Run terminates**
- `AutomationExecutionTemplate`: frozen execution settings (cwd/projectId/backend/model/thinking/collab/orchestration), guaranteeing a cron still runs as originally configured even after the creator changes settings

**Core mechanisms**:
1. **Cron compilation** (`cron-expression.ts`): 5 fields, `automation-v1` profile (allows aliases, legacy-token coercion, Vixie DOM/DOW OR semantics only when both are restricted, rejects impossible dates, `nextMinuteRounding:'truncate'`). Search upper bound `MAX_SEARCH_MINUTES = 8*366 days` (covering 2/29 up to 8 years out). **Evaluated only in the host's local timezone**; on DST folding, epoch-minute advancement prevents re-firing.
2. **Scheduling/trigger determination**: `AutomationManager.computeNextFire` (once stops at its due point; interval/cron advance to the next slot) + jitter (recurring delayed by 10% capped at 15min; one-shots landing on :00/:30 fire up to 90s early). `HostAutomationFireCoordinator` ticks every 5s: `listDueAutomations(now)` (incl. expiry sweep) → `evaluateAutomationCanFire` → `admitFire` → launch.
3. **Scheduling policy**: can-fire gating (incognito globally blocks; cron can always fire because it opens a new session; heartbeat requires the target session to exist, be non-archived, and be idle∈{active,done,waiting_for_user}); continuous retry within the **45min defer window**, `skipFire` beyond the window (once directly becomes expired); `maxFires` is an **attempt cap** (counted at attemptStarted, success or not); 7-day expiry; 20 per session, 5 active heartbeats, 50 terminal-state retentions.
4. **State persistence** (`automation-authority.ts` + schema): full JSON snapshot + monotonic `revision` optimistic concurrency (commit validates expectedRevision, conflict raises an invariant error); `commitOrRestore` rolls back the in-memory state on failure; on restart `registerAll` reconciles "interrupted fires" (active with nextFireAt=null → if budget spent, mark completed and record 'Interrupted on restart', otherwise re-arm).
5. **Fire lifecycle** (`automation-fire-coordinator.ts`): `admitFire` (validates active/due/no-pending/backfills the deferred execution template) → `ensureFireTarget` (cron uses the deterministic session id `automation_session_` + sha256(fireId) + fingerprint dedupe) → `executeRoot({execution:{kind:'automation'}})` → `sendMessage` (`durability:'required'`, origin=automation) → on terminal Run, `settleFire` and `attemptSucceeded/Failed`. `assertFireRunIdentity` strongly validates Run↔session/turn/runId/execution consistency.

**Boundary with AgentRun/TaskRun/event loop**: Automation is **not an independent execution engine**; it is a "scheduler + message injector" — each fire injects an ordinary UserMessage with `origin:{kind:'automation'}` into an existing/new session, going through the standard RootTurnAdmission (`execution.kind==='automation'`) and the standard AgentRun lifecycle; settlement relies entirely on that Run's terminal state (completed/failed/cancelled). The coordinator serializes all state changes through a single promise lane (`#exclusive`); side effects (timers, session creation, Run launch) all converge inside the fire coordinator, and the two interact through the narrow port `AutomationFireStateAuthority`.

## 3. Mapping to the Book's Key Points (Chapter 4)

| Book concept | Maka counterpart | Manifests / exceeds |
|---|---|---|
| **Event-triggered tool set_timer** | The `Automation` tool (cron/interval/once) | Direct correspondence: the model creates scheduled tasks parameterized through a single tool; Maka goes further with **durability** (SQLite persistence, cross-restart, revision concurrency), **attempt/success separation semantics**, and identity binding |
| **Event-triggered tool monitor_shell** | `heartbeat` kind (resumes into the current session) | Corresponds to "in-session monitoring polling"; injects prompt text `[Automation: name]\n\n...` instead of "user triggers on next message" |
| **Event-triggered tool connect_channel** | (no direct equivalent) | Maka expresses external event sources through turn `origin` (automation/goal/agent_graph, see `isTurnOrigin` in `runtime-event.ts`); automation is one of the three event sources, uniformly entering the event loop |
| **Consuming events at safe points** | `HEARTBEAT_IDLE_STATUSES` + can-fire gate + 45min defer window | **Textbook manifestation**: heartbeats inject only at "safe points" where the session is `active/done/waiting_for_user`, never interrupting an in-flight/under-review/blocked/archived turn; busy → defer rather than drop; only past the window → skip |
| (not covered by the book) | Single-host scheduling + residency | **Beyond**: holds runtime residency while pending/scheduled, so the host does not idle-exit |
| (not covered by the book) | Event-driven complement | **Beyond**: timers are not per-event driven but a "next-due-point + 5s polling" hybrid; `assertFireRunIdentity` + deterministic session fingerprints make safe continuation after restart possible, eliminating duplicate fires |

In one sentence: Maka lands the book's "event-driven async Agent + safe-point consumption" as a **transactional, recoverable, concurrency-safe persistent scheduler**, and explicitly acknowledges the architectural idea that "event sources uniformly enter the event loop" (the origin discriminator).

## 4. Current Implementation Analysis

**Strengths**:
- Extremely clean layering: core pure types/compiler → runtime pure logic → storage persistence → runtime-host orchestration, one-way dependencies.
- State separated from side effects: `AutomationManager`/authority is an injectable, unit-testable pure state machine; timer/network/session side effects all live in the fire coordinator, and tests inject fake timers/root to validate the full lifecycle (see `automation-coordinator.test.ts`).
- Hard consistency design: revision optimistic concurrency + `AutomationAuthorityInvariantError` ("stop on contradiction"), commit-failure rollback, `assertSnapshotRelationships` enforcing fire↔definition invariants at the storage layer, dual-bound fire↔Run identity.
- Complete idempotency and recovery paths: deterministic cron session ids, `createStableSession` fingerprint dedupe, `registerAll` reconciling interrupted fires, recovering pending fires before start on recovery.
- Explicit quotas/boundaries/expiry/failure budgets (20/5/50/7 days/5 consecutive failures), with semantics pinned in comments and tests.

**Deficiencies / Risks**:
1. **Timezone**: no per-automation IANA timezone; everything anchors to the host's local timezone; a process migrating across timezones re-anchors (source comments explicitly "out of scope"). `cron-expression.ts`'s DST handling (epoch advancement to prevent re-fire) shows the author is aware but has only solved half of it.
2. **Sleep/wake**: in the local-first single-machine scenario, the host process going to sleep/exiting stalls everything; due fires can only be caught up after restart by `nextFireAt<=now` (`listDueAutomations` treats all backlog as due at once), potentially causing a "catch-up barrage", and there is no per-automation catch-up policy (all vs skip vs latest-only).
3. **Failure retry**: `consecutiveFailures>=5 → paused`, with no exponential backoff / backoff duration and no retry classification (LLM rate-limit vs environmental failure); within the 45min defer window it only retries without recording backoff; failure just relies on the next schedule, with no alert/retry-timeout strategy.
4. **Precision**: 5s polling + whole-minute alignment + non-negative jitter → actual cron trigger can lag by up to ~5s+15min; unsuitable for second-level tasks (interval also ≥10s minimum).
5. **Dual protocols coexist**: `automation-store.ts` (legacy facade) and `automation-authority.ts` (new authority) coexist; `automation-store`'s mutate and the authority's fire semantics can have implicit races; a technical debt.
6. **Approval/permission**: cron new sessions are `permissionMode:'explore'` with no human-approval injection point; durable cron depends on the creator session's execution template, and when the creator session is deleted/archived the only option is "pause + record error", with no migration path.
7. **Observability**: `deferredFireCount` is just a counter; no audit view of missed fires, defer durations, or fire↔run association.
8. Quota constants are hardcoded (`automation-state.ts`), not configurable per host/user.

## 5. Target Architecture

1. **Timezone**: `AutomationDefinition.timezone?: string` (IANA); the cron compiler evaluates per zone (candidate instances use `Intl`/TZ projection), defaulting to the machine's local timezone; give deterministic "skip or catch up" semantics on DST jumps/folds.
2. **Wake-based scheduling**: move from 5s polling to "exact-point timer + polling backstop"; the host hooks into OS-level keep-awake (macOS `beginActivity` / desktop injection) to avoid sleep-point loss; optional launchd user agent for residency.
3. **Catch-up policy**: `AutomationDefinition.catchUp?: 'run' | 'skip' | 'latest-only'`, handling backlog after restart/wake per policy; default `latest-only` to prevent barrages.
4. **Retry and alerting**: failure classification + exponential backoff (capped to align with DEFER_WINDOW) + explicit notification/pause when backoff ends; expose `missedFireCount` and `deferHistogram` to the UI.
5. **Approval/permission inheritance**: cron fires reuse the creating session's permission-policy snapshot, or add an `approval:'required'` trigger injecting an approval step before execution.
6. **Converge storage**: retire the `automation-store.ts` facade, unify onto the `automation-authority` API; promote the `registerAll` reconcile logic into the authority layer's `recover()`.
7. **Multi-instance contingency**: evolve from SQLite revision CAS into "single-writer lease + heartbeat lease renewal", so multiple hosts (desktop+CLI) can safely co-write (current `writerByLease` is already lease-branded, direction is right).
8. **Observability closed loop**: fire↔AgentRun association audit table, UI showing pending/running fires, automation run-history page; `AutomationProjection` already contains `firePending`, continue extending.
9. **Configurable quotas**: promote 20/5/50/7-days into runtime-policy tunables.

## 6. Open Questions

1. **Timezone boundary**: is a per-automation IANA timezone needed? Or keep "follow the host" and only make it explicit in docs/UI? (Affects the `AutomationSchedule` type and all callers — a large change surface.)
2. **Sleep semantics**: for backlog after power loss/sleep, which of `run / skip / latest-only`? Does a one-time catch-up match user expectations (e.g. "nightly backup" running N times on wake)?
3. **Single-writer assumption**: is runtime-host guaranteed single-instance in the current product (desktop and CLI both open)? Must multi-host concurrent writes be solved in this version?
4. **Retry granularity**: should transient LLM failures and environmental failures get different strategies? Does `attemptFailed`'s `consecutiveFailures>=5` threshold need backoff rather than a hard stop?
5. **Approval injection**: a cron's auto-executed prompt can trigger dangerous operations (delete/network); do we need a human-approval/policy-check layer before firing?
6. **6-field cron/second-level tasks**: do the current interval ≥10s floor and 5s tick satisfy monitoring scenarios? Should second-field cron be supported?
7. **Long-lived heartbeat sessions**: `waiting_for_user` is a safe point (#639), but should a long-resident heartbeat have a lifecycle cap (beyond the 7-day expiry)?
8. **Dual-protocol cleanup**: does `automation-store.ts` still have consuming callers? Safe to delete, or does it need compat retention?
