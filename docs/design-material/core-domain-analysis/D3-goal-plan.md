# Goal/Plan Domain · Maka Code Analysis and Architecture Design

## 1. Code Map

The goal/plan domain spans 4 packages and about 37 files (14 core-logic files + tests/wiring), with clean layering: **core holds only pure types/domain rules → runtime holds in-session execution → storage holds persistence → runtime-host holds process-level coordination**.

**packages/core/src (pure domain contracts, no side effects)**
| File | Responsibility |
|---|---|
| `goal.ts` | Goal status enum (9 states), condition/reason text caps (500 chars/1500B) |
| `plan.ts` | Full Plan model: Proposal/Execution/Step/Event/Store interfaces, cap constants, feasibility validation |
| `plan-reminders.ts` | PlanReminder model: once/recurring/cron scheduling, local/bot delivery, input normalization |
| `daily-review.ts` | Daily Review pure projection: local-timezone day boundary, Summary/Totals, 1/7/30-day archive contract |

**packages/runtime/src (in-session autonomous execution)**
| File | Responsibility |
|---|---|
| `goal-state.ts` | `GoalManager`: Goal state machine, checkpoint/controlLease (ABA protection), settleTurn, circuit breakers |
| `goal-tools.ts` | The five model tools GoalSet/GoalClear/GoalStatus/GoalPause/GoalResume + refusal copy |
| `goal-evaluator.ts` | Codex-style external judge: tool-free single LLM call, 30s timeout, JSON verdict |
| `goal-continuation.ts` | `GoalContinuationCoordinator`: per-session FIFO lane settlement, continuation admission, waiting backoff, task gate |
| `goal-turn-lifecycle.ts` | `SessionActivityRegistry` + `drainGoalTurn`: synchronously reserves idle sessions, prevents turn overlap |
| `goal-session-close-fence.ts` | A one-shot fence over Goal continuation when archiving/deleting a session (commit/rollback holder) |
| `goal-task-gate-policy.ts` | Injects an "uncleared todos" hint on each Goal admission (once per goal) |
| `plan-mode.ts` | Plan collaboration mode: tool-allowlist filtering + Plan/Interrupt/Execute three-stage prompt rendering |
| `plan-tools.ts` | SubmitPlan / update_plan / cancel_plan tools (idempotent operationId) |

**packages/storage/src**: `plan-store.ts` (SQLite event-sourcing implementation), `plan-authority.ts`, `plan-legacy-projection.ts`, `plan-reminder-store.ts`, `daily-review-authority.ts` (implicit).
**packages/runtime-host/src/server**: `plan-coordinator.ts` (Host-layer user-control boundary, `plan.query/control/turn.start`), `daily-review-coordinator.ts` (`HostDailyReviewCoordinator`, setInterval scheduled execution).

**packages/headless/src**: **no goal/plan files**. Only parallel eval-domain mechanisms (`heavy-task-self-check.ts`'s self_check_plan, `task-ledger-experiment.ts`'s todo_write, `matrix-resume.ts`'s planMatrixRetry) — this is the benchmark framework's own planning, not the interactive goal/plan domain.

## 2. Core Data Model and Flows

**Goal (autonomous long-horizon objective)** — `runtime/src/goal-state.ts`
```
GoalState { id, revision, sessionId, condition, status, iterations, maxIterations(50),
            consecutiveNoProgress, blockCap(8), tokenBudget?, tokensAtStart/Now,
            controlLease, checkpoint(id+revision) }
```
- Lifecycle (Codex-inspired): `active → waiting → active → achieved/impossible/cleared/paused → stalled/budget_limited/max_iterations` (terminal set in `TERMINAL_GOAL_STATUSES`).
- Triple circuit breaker: `blockCap=8` consecutive no-progress → stalled; `tokenBudget` overrun → budget_limited; `maxIterations=50` → max_iterations.
- **Explicitly non-persistent**: "a restart clears every Goal; persisted snapshots deliberately deferred" (goal-state.ts header comment).

**Goal autonomous closed loop (per turn)**
```
model calls GoalSet(condition) → GoalManager.create(active)
→ after the turn completes, GoalContinuationCoordinator.settleRegisteredTurn (FIFO lane)
→ external judge goal-evaluator reads the last ~5 messages → JSON verdict {met, impossible, progress, waiting, reason}
→ met/impossible terminate; waiting uses a backoff timer (5s→5min); continue admits a new turn via admitTurn
→ buildContinuationPrompt(evaluation reason + no-progress count + task reminder) continues
```
- **Externalized judge** (unlike Codex): "The working model never judges its own completion" — prevents the agent from rationalizing an early "done".
- Evaluation failure is **fail-open** for continuation, but `evaluatorFailed` is treated as neutral (neither advances nor resets the stall counter), guarding against transient failures being misjudged.
- Concurrency protection: one lane per session, `reserveIfIdle` synchronously reserves idle sessions to prevent turn overlap; `controlLease`/`checkpoint`/`revision` optimistic concurrency + ABA protection; the Goal tools' 5 refusal reasons (`turn_not_registered`/`coordinator_disposed`/`goal_already_armed`/`goal_not_observed`/`goal_changed`) distinguish "true race" from "doomed to fail".

**Plan (controlled planning)** — `core/src/plan.ts`
```
PlanProposal { proposalId, revision, supersedesProposalId, sourceExecutionId?, title, overview,
               steps(≤50, each step title≤30 chars, files≤50, complexity), risks(≤20), status }
PlanExecution { executionId, status: active/completed/cancelled/interrupted, steps(status advancement) }
PlanEvent (event sourcing): plan_submitted → plan_revision_requested → plan_approved
                    → plan_progress_updated → plan_execution_completed/cancelled/interrupted/resumed
```
- Flow: `SubmitPlan` (pending_approval) → user `approveProposal` (expectedRevision+storeVersion optimistic concurrency) → during execution `update_plan` advances step by step (**at most one in_progress**) → completed/cancelled. If execution is interrupted → the user returns to Plan mode and a new proposal carries `sourceExecutionId` to **replan the remaining work**.
- Extremely strict constraints: plain text rejects Markdown, 16KB text cap, 60KB projection cap, `isPlanProposalLifecycleAdmissible` pre-checks worst case, `operationFingerprint` idempotent replay.
- **Delegation to subagents is forbidden during execution** (plan-mode.ts `renderPlanExecutionPrompt`).

**PlanReminder / DailyReview (reminders and scheduling)**
- `PlanReminder`: once/recurring(daily/weekly/monthly)/cron three scheduling forms, delivered locally or to a bot (platform+chatId); run records `triggered/blocked/failed` (blocked due to `incognito_active` or `bot_delivery_unavailable`); run-history cap 10, max delay 366 days.
- `DailyReview`: pure projection (local-timezone day boundary, DST-safe); `HostDailyReviewCoordinator` schedules by `executeTime`, producing summary/gaps/usage/code four sections archived as `YYYY-MM-DD-{1|7|30}d`.

**Boundaries (with AgentRun/TaskRun/Automation)**
- **AgentRun**: goal turns are hosted via `admitTurn` → `RootTurnCoordinator.startHostedExternalTransition` (runtime-host); ordinary turns are also registered via `beginObservedTurn`, and settlement is the only legal settlement path. Plan mode uses `selectCollaborationTools` (by `classifyToolUse` category) to trim the toolset to read-only.
- **TaskLedger**: a model-managed flat task list (`core/task-ledger.ts`, re-injected at the tail of every turn, cap 200); the goal task gate is only an **advisory text reminder**, explicitly "never overrides files, tests, artifacts, or verifier evidence".
- **Automation** (`core/automation.ts` + `automation-fire-coordinator`): Host-level cron single-fire calls (can carry collaborationMode), a separate mechanism from Goal's "in-session continuous autonomy".
- **Two autonomy systems coexist**: Plan = workflow-style (human-in-the-loop approval, structured steps); Goal = free-form autonomous loop (single condition, self-continuation). Mutual exclusion is only implicitly guaranteed by `collaborationMode: 'agent'|'plan'` (`core/collaboration.ts`).

## 3. Mapping to the Book's Key Points (Deep Understanding of AI Agents)

| Book key point | Maka manifestation | Assessment |
|---|---|---|
| Workflow vs autonomous Agent | **Both implemented**: Plan mode = controlled workflow (approval/steps/interrupt-replan); Goal = autonomous long-horizon Agent (self-continuation, external judge). Mutually exclusive switching within the same session | Dual modes coexist with clear positioning; but the two kernels are not shared |
| Long-horizon planning and task decomposition | Plan has explicit steps/files/complexity/risks decomposition; Goal does not decompose, relying on per-turn judge verdicts | Plan decomposition is in place; Goal has no subgoals |
| Goal clarification | Plan has an explicit pending_approval→revision→abandon clarification loop; Goal's condition is only 500 chars of free text, **no clarification step** | Goal clarification exists only in the controlled path |
| Checkable nodes / observability | `GoalManager.onChange` observers push every state transition to the UI ("a token-burning goal must never run without a visible indicator"); Plan has full event sourcing + storeVersion; GoalState immutable + revision snapshots | Stronger than typical implementations |
| Anti "early completion" hallucination | Externalized judge (fixes the Codex anti-pattern); `evaluatorFailed` treated neutrally | Beyond the Codex design |
| Circuit breakers / budget | blockCap / maxIterations / tokenBudget triple termination + waiting backoff | Autonomous-loop safety net complete |

## 4. Current Implementation Analysis

**Strengths**
1. **Rigorous state-machine engineering**: Goal 9 states + terminal set + checkpoint/revision/controlLease optimistic concurrency and ABA protection; Plan event sourcing + storeVersion + idempotent fingerprint — a rare "production-grade" autonomous-loop implementation.
2. **Externalized judge + fine-grained failure semantics**: the working model does not self-evaluate; timeouts/garbled output are treated as neutral to prevent stall misjudgment; fail-open keeps continuation alive.
3. **Strict Plan boundary constraints**: plain-text validation, double-layer byte caps, worst-case projection pre-check, replanning (interrupted→sourceExecutionId→supersedes).
4. **Clear layering**: core pure contracts / runtime execution / storage persistence / runtime-host coordination, each boundary testable (per-file unit tests, including dual-client UDS tests).
5. **Complete safety net**: no turn overlap (SessionActivityRegistry), session-close fence, auto-pause after archive rollback.

**Deficiencies / Risks**
1. **Goal has no persistence**: restart clears everything (goal-state.ts explicitly self-describes as deferred) — this **directly contradicts** the local-first workbench positioning of "data stays local, recover at any time"; it is the largest single gap.
2. **Goal has no clarification/decomposition**: single-layer free-text condition, no structured attribution to Task/Plan; evaluation reads only "the last ~5 messages", so context drift in long sessions makes the judge less accurate.
3. **Single source for evaluation quality**: one LLM judgment decides termination, with no deterministic verification cross-check; when `evaluatorFailed`, it fail-opens and keeps burning tokens.
4. **The two autonomous loops are not unified**: Goal and Plan execution are different implementations; `selectCollaborationTools` relies on `classifyToolUse` heuristic classification, so custom tools can be mis-filtered.
5. **No formal Goal↔Task↔Plan association model**: the task gate is only text injection; a goal holds no plan/execution/task references; waiting for external events cannot be woken by PlanReminder/Automation — only poll-backoff (token-burning).
6. **Crude cost model**: each continuation = 1 work call + 1 judge call, only a top-level tokenBudget, no per-turn cost monitoring/dashboard.

## 5. Target Architecture

1. **Goal persistence and recovery**: turn GoalState into event sourcing (GoalEvent: set/settle/pause/resume/clear…), landed in storage; extend the `goal-session-close-fence` holder pattern into a restart fence; after restart, recover continuation from snapshot+log.
2. **Unified autonomy kernel**: extract an `AutonomousLoop` abstraction (evaluator + settlement + circuit breakers + admission); both Plan execution and Goal run on the same kernel — Plan = autonomy with step constraints, Goal = unconstrained autonomy — eliminating the two loops.
3. **Goal clarification and attribution**: add a clarification step to Goal (condition→confirm→GoalClarify tool); the goal holds `taskKeys[]/planExecutionId` references; the task gate upgrades from "text reminder" to structural alignment (unfinished task count participates in the judge's context).
4. **Judge upgrade**: multi-signal evaluation (deterministic verifier results + model judgment + evidence checks); `evaluatorFailed` degrades to pause by default (rather than fail-open); judge output is written to audit events for postmortem.
5. **Unified event bus**: GoalEvent/PlanEvent/TaskLedgerChangedEvent converge into the runtime-event store, letting session-recap and DailyReview aggregate "today's goal/plan completion".
6. **Linked wake-up**: Goal's `waiting` state hooks into Automation/PlanReminder triggers (external event arrives→`wakeWaiting`), replacing poll-backoff with event-driven wake-up.
7. **Cost observability**: Goal continuation joins the usage ledger, providing a per-turn cost, cumulative budget, and remaining-quota panel (the `tokensAtStart` baseline already exists).

## 6. Open Questions

- **Persistence priority**: under the local-first positioning, is "Goal lost on restart" acceptable? If not, should GoalEvent and PlanEvent share storage or use separate tables?
- **Unify vs dual-mode**: should Goal and Plan merge into an "autonomy spectrum" (mode parameter), or stay as two systems (workflow approval vs free autonomy) to match different user mental models?
- **Judge cost**: the cost-effectiveness of one LLM judgment per continuation; should it be down-sampled by "evidence delta" (skip the judge when no file/test changes)?
- **Evaluation privacy**: the judge reads "the last 5 messages" and sends them to the session model — does it need a redaction/localization option?
- **Multi-goal resource governance**: global token/cost quotas when multiple sessions run Goals in parallel (currently only per-session tokenBudget).
- **Domain ownership**: should PlanReminder/DailyReview belong to the goal/plan domain, or to a separate scheduling/telemetry domain? (currently spread across core+runtime-host, with an even larger documentation gap)

---

**Core reference anchors**: `runtime/src/goal-state.ts` (state machine / non-persistence declaration), `runtime/src/goal-continuation.ts` (FIFO settlement/admission), `runtime/src/goal-evaluator.ts` (external judge / neutral failure), `core/src/plan.ts` (Plan model/event sourcing), `core/src/plan-reminders.ts` and `core/src/daily-review.ts` (reminders/scheduling), `core/src/task-ledger.ts` (boundary), `storage/src/plan-store.ts` and `runtime-host/src/server/plan-coordinator.ts` (persistence and Host coordination).
