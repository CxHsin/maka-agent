# Swarm Domain · Maka Code Analysis and Architecture Design

## 1. Code Map

### 1.1 The Swarm domain proper (8 files)
| File | Role |
| --- | --- |
| `packages/core/src/agent-swarm.ts` | **Legacy** projection of the `agent_swarm` tool result (`projectAgentSwarmResult`: status/start/completed/failed/cancelled/artifact/duration counts). The read-side authority is in the child AgentRun. |
| `packages/core/src/swarm-command.ts` | `/swarm` slash-command parsing (`status` / `on`→swarm / `off`→default / everything else treated as a run_once task), rejecting similar words like `/swarming`. |
| `packages/runtime/src/swarm-mode.ts` | `renderSwarmModePrompt()`: the Swarm policy prompt injected into the main Agent (when to use an async swarm, how to shard, no polling, how to replace failed items, how to synthesize). |
| `packages/runtime/src/agent-swarm-status-tool.ts` | The `agent_swarm_status` tool: projects `AgentGraphClientSnapshot` into a compact status table (9 item states, `running/needs_attention/settled`, attention set, failure phase). Includes `isAgentSwarmSupervisorCheckpoint` / `shouldWakeAgentSwarmSupervisor` / `renderAgentGraphSupervisorWake` (wake-after hint). |
| `packages/core/src/__tests__/agent-swarm-result.test.ts` | Legacy result decode/projection contract. |
| `packages/core/src/__tests__/swarm-command.test.ts` | Command parsing. |
| `packages/runtime/src/__tests__/agent-swarm-status-tool.test.ts` | Status projection. |
| `packages/runtime/src/__tests__/swarm-orchestration.test.ts` | Orchestration admission: `yield_agent_graph`'s `executionSemantics: 'exclusive_step'` (exclusive step, ends the turn). |

### 1.2 Supporting domain (Swarm's real runtime = Agent Graph)
- Core data contracts: `packages/core/src/agent-graph-schedule.ts` (schedule update / work / finish / claim-store interfaces), `agent-graph-control.ts` (intent-claim admission), `agent-graph-topology.ts` (operator provision, monotonic topology expansion), `agent-graph-supervisor-wake.ts` (wake records), `agent-graph-client-projection.ts` (client read-side projection), `agent-graph-timeline.ts`.
- Runtime: `packages/runtime/src/stream-graph-coordinator.ts` (in-process single-flight driver), `stream-graph-supervisor-tools.ts` (the three main-Agent control tools `view/update/yield_agent_graph`), `stream-graph-schedule-reconcile.ts` (schedule reconciliation loop), `stream-graph-dispatch.ts` / `stream-graph-readiness.ts` (operator readiness/dispatch), `stream-graph-read-model.ts` (`AgentGraphClientSnapshot`), `agent-graph-supervisor-wake.ts` (runtime-side wake-turn coordinator, incl. context-overflow recovery), `graph-mode.ts`.
- Orchestration mode: `packages/core/src/orchestration.ts` (`default/swarm/graph`, `EffectiveOrchestration`, `agentSwarmAuthorization`).
- Subagents: `packages/core/src/subagent-settings.ts` (user-approved presets: `subagent_id` + model routing), `subagent-workspace.ts` (implementation git-worktree isolation lease); `packages/runtime/src/subagent-tools.ts` (`agent_spawn/agent_list/agent_output`), `subagent-execution.ts` (child_session migration-compat handle), `child-agent-progress.ts` (bounded progress projection), `child-agent-run-limiter.ts` (global child-run permission pool), `agent-catalog.ts` (built-in agent definitions and restricted tool sets), `configured-subagent-catalog.ts`.
- Orchestration/execution: `packages/core/src/agent-run.ts` (`RootExecutionDescriptor` with `claimed_agent_graph_intent`, `agent_graph_supervisor_wake`), `packages/core/src/events.ts` (`agent_swarm`/`subagent` result kinds), `packages/runtime/src/ai-sdk-backend.ts` (swarm-mode fixed tool set, prompt injection, `graph_yield` loop stop).
- Docs: `docs/agent-swarm.md` (usage-oriented; **describes the legacy blocking `agent_swarm` tool**, drifting from the current implementation — see §4).

## 2. Core Data Model and Flows

### 2.1 The three "orchestration modes" are not a second execution runtime
`orchestration.ts` defines `default | swarm | graph`. The key claim lives in a comment in `agent-swarm-status-tool.ts`:

> *"Supervisor wake admission is always Graph orchestration; Swarm remains the durable graph identity and presentation policy, not a second runtime."*

That is: **Swarm is not a second execution engine; it is a set of "presentation policies + authorization" layered on top of Graph**. `resolveEffectiveOrchestration()` yields `agentSwarmAuthorization: session_mode | turn_override | none`, controlling whether the main Agent is allowed to take the async fan-out path.

### 2.2 Data model (everything in SQLite, keyed by idempotency/fingerprint/version)
- **Schedule update**: `AgentGraphScheduleUpdateRequest` (`updateId`+`updateFingerprint`+`graphId`+`source(session/run/turn/toolCallId)`+`addWork[]+stop[]+finish?`), committed with a monotonically increasing `revision`. `addWork≤32`, `instruction≤60k`, `inputIds≤64`, `resultIds≤64`.
- **Work item**: `AgentGraphScheduledWork { workId, target(agent|preset|operator), instruction, inputIds[], replaces? }`. `inputIds` is the explicit input frontier (upstream committed record ids); `replaces` is for replacing failed items (`replacement_mode=replace`).
- **Intent claim**: `AgentGraphIntentClaimRequest` (`claimId`+`intentId`+`intentFingerprint`+`readinessContextFingerprint`+`targetOperatorId/SessionId/TurnId/RunId`), conditionally linearized on the schedule revision (`claimAgentGraphIntentAtScheduleRevision`). Turn/run ids are pre-allocated → a retry sees the same activation rather than a second launch.
- **Operator provision**: `AgentGraphOperatorProvisionRequest` (`provisionId`+`graphId`+`workId`+`agentId`+`operatorId`+`edges`); the child Session and the topology row commit in the same transaction; topology only allows monotonic expansion (add work/add edges), **no edge deletion, rewiring, or cycles**.
- **Supervisor wake records**: `AgentGraphSupervisorWakeRecord` (`pending/running/waiting_permission/delivered/superseded/retryable_failed`, with `attemptCount`, `currentTurnId`).
- **Client projection**: `AgentGraphClientProjectionStore` (dual graph+operator projection + terminal activities + idempotent incremental delivery), so the UI does not replay JSONL. `AgentGraphClientSnapshot` carries `orchestrationMode: 'graph'|'swarm'`.
- **Status projection (agent_swarm_status)**: `queued/running/blocked/completed/failed/aborted/cancelled/stopped/superseded`; the attention set `blocked/failed/aborted/cancelled` → `needs_attention`; all terminal → `settled`; `status!=='running'` is a supervisor checkpoint.

### 2.3 Main-Agent scheduling and result-synthesis flow (timeline in Swarm Mode)
1. A user request enters a turn with `mode: 'swarm'`; `ai-sdk-backend.ts:1592` injects `renderSwarmModePrompt()`; `ai-sdk-backend.ts:1456` fixes the tool set to `{agent_list, update_agent_graph, yield_agent_graph, agent_swarm_status, agent_output}` (and `agent_swarm` has been removed; tests assert `agent_swarm stays removed`).
2. The main Agent `agent_list` → picks a user-approved `subagent_id` → submits all independent items in one `update_agent_graph(operation=add_work, add_work:[{target_kind:new_preset, subagent_id, instruction, input_ids, replacement_mode:none}])`.
3. `yield_agent_graph` (`executionSemantics:'exclusive_step'`, `recoveryMode:'replay_safe'`): validates the schedule is not closed, there is pending work, and there are in-flight operators or a reconcile that can produce a future checkpoint; returns `agent_graph_yielded`; `ai-sdk-backend.ts`'s `handleAgentGraphYieldToolResult` sets `loopStopReason='graph_yield'` to stop the loop. **No polling.**
4. `AgentGraphCoordinator` (`stream-graph-coordinator.ts`) single-flight reconcile: `reconcileAgentGraphSchedule` reads all schedule updates → computes readiness (`map`/`all_settled` strategies) → derives runnable intents → conditional claim → dispatches `runClaimedAgentGraphIntent` (the `claimed_agent_graph_intent` execution descriptor in `agent-run.ts`) → the child Session runs as a **graph operator** with a restricted tool set (local_read=Read/Glob/Grep, web_research=WebSearch, implementation=Read/Glob/Grep/Write/Edit/Bash + worktree isolation). A child Session never gets the `update_agent_graph/yield/agent_swarm_status` control surface → **batches cannot nest**.
5. The child run produces committed RuntimeEvents → the client projection advances incrementally → reaching a swarm checkpoint (`isAgentSwarmSupervisorCheckpoint` in `agent-swarm-status-tool.ts`) → `AgentGraphSupervisorWakeCoordinator` (runtime-side `agent-graph-supervisor-wake.ts`) writes the wake in SQLite and starts a new `agent_graph_supervisor_wake` supervisor turn (with `startTurn` activity lease, 3 delivery attempts, `recoverAgentGraphSupervisorContextOverflow` on context overflow).
6. The woken supervisor is only allowed to view compact status via `agent_swarm_status` and read committed final results via `agent_output(view=result)`; failed items are replaced via `update_agent_graph(replaces=<failed workId>, replacement_mode=replace)` so the swarm does not sit in `needs_attention`; once all useful work is settled, `update_agent_graph(finish, result_ids=[committed record ids])` (`assertFinishResultsCommitted` forces results to be committed records), and the main Agent dedupes, validates, semantically synthesizes, and reports to the user.

### 2.4 Boundary with collaboration tools (agent_spawn / agent_swarm / Agent Team / Rive)
`docs/agent-swarm.md`'s selection table gives the official boundary:
- small task/tightly coupled → the main Agent does it directly; single expert result / depends on the previous step → sequential `agent_spawn`; multiple finite independent items + one synthesis → **swarm**; persistent ownership / task claiming / worker communication → **Agent Team** (roles + mailboxes + Task Ledger); dynamic dependent sub-work under root-session supervision → **Agent Graph**; explicit workflow recovery / distributed → **Rive**.
- The subagent toolchain shares the **same real child-run budget pool** via `ChildAgentRunLimiter` (`child-agent-run-limiter.ts`): both `agent_spawn` and swarm draw "real execution" from the same permission pool, and with "tool admission (how many subagent calls a model can open at once)" and "in-batch local concurrency (swarm default 3, max 32)" they form a three-layer observable concurrency boundary.
- `agent_spawn` is a **blocking foreground** single sub-task (result contains `summary` + artifact refs, `child-agent-progress.ts` does bounded progress projection); Agent Graph/swarm are **async durable** scheduling. Both share the child-Session execution base (`subagent-execution.ts`'s `child_session` handle) and preset resolution (`subagent-settings.ts` + `configured-subagent-catalog.ts`).

## 3. Mapping to the Book's Key Points

### 3.1 Context sharing vs not — **strongly not-shared + structured frontier (manifests and exceeds)**
- Book: sharing context reduces duplication but amplifies interference and cost; not sharing preserves fidelity but requires explicit passing. Maka chose the extreme of "**not-shared + explicit frontier**": the built-in agent contract `context: AGENT_CONTEXT_ISOLATED` (`agent-catalog.ts`), child Sessions fully independent.
- Beyond: cross-work sharing is not "paste the last summary into the next instruction", but a **committed-record-id frontier** (`input_ids` → `hydrateAgentGraphInputHandoffs` generates operator handoffs with source links); messages are structured records, not free text.

### 3.2 Peer / manager / decentralized topology — **strict "manager (beside the data path) + deterministic scheduling"**
- Book: the three topologies each trade off (peer=robust but hard to converge, manager=clear but a single point, decentralized=scalable but hard to audit). Maka is a **hardened manager topology**: the main Agent is a supervisor "**beside the data path**" (`stream-graph-dispatch.ts`: the observer callback "the driver never awaits these callbacks … supervision stays beside the graph instead of becoming a data-path gate").
- Characteristic: operators have **no peer mailboxes** (that is Agent Team's job); work flow is entirely driven by the scheduler's map/all_settled readiness strategy; monotonic topology expansion forbids cycles. This solves the manager topology's "non-auditable/non-replayable" weakness, but sacrifices peer topology's resilience (see §4).

### 3.3 Structured summary vs full trajectory — **a "bounded summary projection" threading the whole chain (exceeds)**
- Book: to save context, pass summaries rather than full trajectories. Maka made it a **system invariant rather than a prompt suggestion**: `agent_swarm_status` "omits child logs, tool activity, reasoning, and partial output"; `agent_output view=result` only reads committed final results; `child-agent-progress` has dual event/char budgets (64/8k, batch 128/16k); the docs assert "presentation never copies child prompts, tool arguments, or raw child tool output". UI/CLI both have only aggregate counts + bounded lines.

### 3.4 Budget awareness — **multidimensional (partial manifest / partial exceed)**
- Beyond: shared child-run permission pool (`ChildAgentRunLimiter`, abort-aware FIFO), in-batch concurrency cap 32, provider rate-limit adaptive backoff (5 items to start +700ms fill + 3/6/12s retries + capacity-tier recovery), tool-result archival and list truncation (`AGENT_LIST_MAX_RESPONSE_CHARS`), progress/event/char budgets, supervisor **context-overflow recovery** (`recoverAgentGraphSupervisorContextOverflow`, aggressive compaction).
- Missing: **no global token/spend/budget/deadline**; rate limiting is "batch-local & reactive", and the docs state it is not a provider-global RPM/TPM controller nor coordinated across sessions/processes (`child-agent-run-limiter` is an in-process object). That is, "resource budget" is localized; "financial/time budget" does not exist.

### 3.5 Cascading termination — **structured concurrent cancellation (manifests and is rigorous)**
- Book: a sub-task failure/cancellation should propagate across the topology to avoid orphans. Maka: parent cancellation will "signal active children, prevent locally queued items from starting, join active work, return explicit cancelled rows for started and never-started items" (`docs/agent-swarm.md`); swarm state includes `aborted/cancelled/stopped/superseded`; Graph `stop()` recursively stops known operators and collects `stopGeneration`/`driveGeneration` races; rate-limit retries are still backstopped by the shared permission pool under parent cancellation.
- Worth noting: `yield_agent_graph`'s "cascade" runs the opposite direction — **the supervisor voluntarily suspends**, relying on durable wake records to recover after process restart (`recoverAgentGraphSupervisorWakes`), an "async cascading wake-up" the book develops less.

### 3.6 Error amplification — **isolation + explicit replacement protocol (manifests, but synthesis still relies on prompt discipline)**
- Book: multi-agent amplifies errors along the chain; needs isolation, traceability, and human/self validation. Maka: partial child failure **does not erase successful siblings** (partial settled); every work item has `failurePhase: schedule|topology|stop|render|dispatch` + `failureReason`; `reconciliationFailures` enter `needs_attention` and trigger a supervisor wake; failed items are explicitly replaced via `replaces` (`replacement_mode=replace`), and after replacement the old item terminates as `superseded`.
- Gap: **replacement is a "supervisor's manual decision", with no automatic retry-with-cap/degradation protocol** (the legacy `agent_swarm` doc's RateLimit auto-retry — in the Graph version, who does it? currently Graph dispatch failures land in `reconciliationFailures` waiting for supervisor decisions). And the final "dedupe/validate/synthesize" fully depends on the prompt's "semantic synthesis before finish", with no strong validation step (only the one hard constraint that result_ids must point to committed records).

## 4. Current Implementation Analysis

### 4.1 Strengths
1. **Persistence turns "supervision" into a recoverable state machine**: schedule/claim/provision/wake all in SQLite + fingerprint idempotency + revision linearization; the coordinator is a "stateless single-flight driver", process-rebuild-safe (`AgentGraphCoordinator` comment: durable rows remain the recovery authority).
2. **Clean responsibility separation**: Graph=durable scheduling authority, AgentRun/RuntimeEvent=child-lifecycle authority, client projection=presentation authority; `agent_swarm_status`/`agent_swarm` are both only "bounded projections", never duplicating authoritative data.
3. **Control plane decoupled from data plane**: the supervisor observer never becomes a data-path gate; `update_agent_graph` only writes intent, the reconciler is the one touching the runtime; the main Agent "beside the path" cannot block child execution.
4. **Secure defaults**: child Sessions cannot reach the graph control surface (no nesting), presets must be user-approved, `subagent_id` freezes connection/model/thinking into the child Session, root-supervisor ownership checks (`assertScheduleOwnedByRoot`), worktree isolation (implementation cannot write the main workspace).
5. **Async benefits landed**: the yield→wake closed loop (`exclusive_step` + durable wake + delivery retries + context-overflow recovery) keeps long-tail tasks off the foreground.

### 4.2 Deficiencies / Risks
1. **Docs drift from implementation (the most direct)**: `docs/agent-swarm.md` throughout describes the legacy blocking `agent_swarm` tool (`agent_swarm({items, max_concurrency})`, resume_run_ids, provider backpressure), but the current runtime has removed that tool (`deferred-tools-backend.test.ts` asserts `agent_swarm removed`); the operative model is "Swarm Mode = Graph + presentation policy". `events.ts`/`agent-swarm.ts`/conversation-copy still keep the `agent_swarm` result kind as a compat projection. Two mental models coexist.
2. **Steep size/complexity**: 15+ stream-graph files in the Graph domain plus extensive schema versions and fingerprint validation; the architectural tax for "bounded presentation" is high, and the onboarding cost for newcomers is large; the 8 "swarm files" are just the tip of the iceberg.
3. **Supervisor context grows linearly with wake count**: each wake is a new turn of the same root Session; although `agent_swarm_status` is compact and context overflow has recovery, there is **no "cross-wake supervisory briefing compaction"** — a large number of already-settled child results can occupy the root-session context for a long time.
4. **Error amplification in the "synthesis" phase still relies on prompt discipline**: failure replacement (replaces), dedupe, and semantic synthesis are prompt suggestions, not enforced flows; if the model does not follow "don't read child logs, don't poll", there is no hard runtime block (only tool-capability boundaries).
5. **No global budget**: no hard swarm-wide token/spend/step/deadline budget; the shared child-run permission pool is in-process single-machine, uncoordinated across sessions/processes.
6. **Limited topology expressiveness**: monotonic expansion, no arbitrary edge deletion/rewiring/cycles; when "the dependency direction was judged wrong and needs reordering", the only path is replace + compensating new work, which tends to produce duplicate execution and a bloated work list.
7. **Blurry swarm-vs-graph semantic boundary**: when `orchestrationMode` switches between `swarm` and `graph`, `requiredOrchestrationTools` differ only by `agent_list` vs `view_agent_graph`, everything else identical; "is swarm just an alias for graph" has no clearly documented discriminator.

## 5. Target Architecture

**Overall principle: converge "Swarm" into "a controlled presentation/authorization policy of Agent Graph", eliminate the dual model, and turn the parts currently guaranteed by prompt discipline into verifiable mechanisms.**

1. **Unify docs and model**: rewrite `docs/agent-swarm.md` around the operative `update_agent_graph / yield_agent_graph / agent_swarm_status` protocol; downgrade the `agent_swarm` result kind to a read-only compat projection and remove it in v2; make an explicit decision table: when `swarm`, when `graph`, when just do it directly.

2. **Supervisor briefing mechanism**: generate a **persistent, idempotent "swarm briefing record"** per wake (aggregate counts + each settled item's `recordId` + the needs-attention list + the delta since the last briefing); a new wake turn only injects the briefing rather than the full history; upgrade `agent_swarm_status`'s compactness into a **cross-turn context compaction strategy** (working with the existing `recoverAgentGraphSupervisorContextOverflow`).

3. **Hard budget layer**: add a swarm-level `budget { maxTokenEstimate | maxSteps | maxCost | deadline }` in `AgentGraphCoordinator`, passed in with `update_agent_graph`, exposed with the snapshot; on overrun, automatically enter `stopped` and wake the supervisor to decide (continue/degrade/fail), no longer relying on model self-discipline.

4. **Formalize error recovery**: upgrade "failed-item handling" from prompt to deterministic decision: `reconciliationFailures` carries a suggested action (`retry_once` / `replace` / `fallback_profile` / `stop_branch`); provide a `recover_agent_graph` tool or let `update_agent_graph`'s `replaces` support `replacement_mode: retry` (keeping the failed run as evidence, generating a `retriedFromRunId` chain, reusing the legacy agent_swarm rate-limit retry logic).

5. **Synthesis validation closed loop**: add an optional `verification` phase before `finish` — require the records referenced by result_ids to satisfy a set of assertions (e.g. cross-check items), or when the supervisor explicitly declares `verified: false`, go through `replaces`; turn "dedupe/validate/synthesize" into a stateful graph phase rather than pure free text.

6. **Topology enhancement (incremental)**: allow "reverse-dependency correction" under restricted semantics (the supervisor explicitly `supersede`s a set of work and atomically `add_work` replacements, so reordering does not produce orphans); reserve an operator→operator **record-level message edge** for peer-collaboration needs (reusing existing handoff, no mailbox runtime), so Maka can cover the book's "peer topology" scenarios without losing audit.

7. **Observability**: emit structured diagnostics for every wake/reconcile/replacement/recovery (there is already an `AgentGraphSupervisorWakeDiagnostic` prototype), plus "convergence metrics" (incremental settled count per round, attention dwell time, replacement count), so swarm idling can be monitored and alerted.

## 6. Open Questions

1. **Swarm's positioning**: should the claim "Swarm = Graph presentation policy + authorization" hold long-term, or should Swarm get its own (thinner) execution model in the future? (The current code comment already leans toward the former.)
2. **Legacy `agent_swarm` tool**: remove entirely (including the `events.ts` kind and UI projection), or keep it as a lightweight shortcut for "blocking foreground small batches"? Does the coexistence of two contracts (blocking vs async) have value?
3. **Long-running supervisor**: how to govern root-session context growth across many wakes — "briefing injection", or "periodic supervisor-session snapshot/archival of child results"? How does a cross-turn user response flow for permission waiting (`waiting_permission`) coexist with wakes?
4. **Budget and authorization**: where is the cost-runaway boundary for async fan-out? Is `agentSwarmAuthorization: turn_override`'s semantic granularity enough (per-session / per-request / per-amount)?
5. **Model discipline vs enforcement**: for "no polling, no reading child logs, no creating duplicate work", which should be hard-blocked by capability boundaries (e.g. after `yield`, calling `view_agent_graph` in the same turn is forbidden), and which can only rely on prompt? (Currently `exclusive_step` is the only hard point.)
6. **Cross-process/cross-session coordination**: `ChildAgentRunLimiter` and rate-limit backoff are in-process local; when multiple windows/processes share compute, is a centralized permission/quota service needed?
7. **Error-recovery strategy**: which layer should automatic retry-with-backoff of failed items live in — the Graph reconciler (deterministic) or the supervisor (intelligent decision)? How do the two divide work to avoid "error amplification" and "dead waiting"?
8. **Topology freedom**: is the monotonic-expansion limit a deliberate simplification or a temporary constraint? Is it worth introducing richer topology operations for multi-round dependency correction (DAG reordering), at the cost of higher reconciliation complexity?
