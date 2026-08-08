# Maka Design Question Checklist (Essential Edition)

> Only the core design questions directly relevant to **the Agent Harness itself** are kept: logging & runtime, context projection & compression, persistent tasks & recovery, verification & fact authority, tool system & safety, evaluation, continuous evolution, multi-agent collaboration. Organized by Maka's four creeds. Each question is tagged with its corresponding knowledge point (KP-xx-xx), with supporting arguments available in `agent-book-knowledge/`.
>
> Usage: design review checklist, the "Open Questions" section of a design doc, requirements-clarification interviews.

---

## I. Log is the Runtime

1. **Q-L1** Which events must the Event Log cover for it to truly count as "log is the runtime" — model decisions, context inputs, tool calls and results, termination facts? Whichever piece is missing, recovery loses the evidence for that piece? (KP-00-01)
2. **Q-L2** Should tool results be stored as raw payloads or post-projection content? The log is append-only and immutable while projections are mutable — how should the two be stored separately? (KP-02-02)
3. **Q-L3** Which events must be logged: status bar injection, tool schema loading, guardrail judgments, permission checks, self-check evidence, recovery actions? Constraints without a log cannot be audited. (KP-01-09)
4. **Q-L4** How can the schema layer enforce the distinction between "evidence (immutable)" and "conclusions (mutable projection)"? (KP-08-01)
5. **Q-L5** Should a TaskRun's termination fact be its own event type? How does recovery recognize that "the task has terminated"? (KP-02-03)
6. **Q-L6** How are parallel tool calls modeled in the log (one assistant event carrying multiple tool_calls + multiple tool results)? (KP-02-03)
7. **Q-L7** Does every event carry its own idempotency key / operation ID to support multi-agent recovery and "settle exactly once"? (KP-10-10/10-11)
8. **Q-L8** How does the log align with OpenTelemetry/OpenInference's span tree to avoid being locked into an analysis platform? (KP-06-18)
9. **Q-L9** How are provisional results and confirmed facts distinguished in the log, so downstream consumers don't mistake transient states for final facts? (KP-09-02)

## II. Context is not history (context projection & compression)

1. **Q-C1** "Don't silently drop information needed to decide the next action" — who decides which information is necessary? Is an explicit "discardability declaration" protocol needed? (KP-02-01)
2. **Q-C2** How are static prefixes (system+tools) and dynamic trajectories distinguished in the projection? How are they marked in the log? (KP-02-05)
3. **Q-C3** Can Tool Result pruning repeat the "missing tool result → infinite loop" failure? What detection/termination mechanism provides the fallback? (KP-02-05/02-09)
4. **Q-C4** When pruning replaces a tool result in the middle of a trajectory, how is "cache rebuild cost vs. token savings" quantified? (KP-02-06)
5. **Q-C5** How is the priority for what compaction keeps determined? Must architecture decisions / verification states / unresolved TODOs never be summarized? (KP-02-26)
6. **Q-C6** How is context rot (fits but can't be found) detected? Can log metrics (repeated calls, back-and-forth agonizing) serve as signals? (KP-02-23)
7. **Q-C7** Is the status bar a deterministic projection of the log or independent state? Since the model trusts the status bar unconditionally, how is accuracy tracked as a first-line metric? (KP-02-20/21)
8. **Q-C8** Should status bar updates use "replace every turn" or "persistent append"? How is the choice made automatically based on trajectory length / update frequency? (KP-02-22)
9. **Q-C9** When delegating to a sub-agent, the task description must be self-contained — the main log only records "dispatch + conclusion". How is auditability guaranteed? (KP-02-27)
10. **Q-C10** With the Skill catalog as a stable prefix and body content appended to the trajectory, how does this work with byte-level KV Cache stability? (KP-02-18/19)

## III. A task may outlive a Turn (persistent tasks & recovery)

1. **Q-T1** How do a TaskRun's recovery points align with "safe points" — which log events constitute a recoverable checkpoint? (KP-04-17)
2. **Q-T2** When budget runs out, is that a "termination fact" or a "suspended fact"? Which log offset does a resumed run start recovering from? (KP-02-04)
3. **Q-T3** Events are consumed only at safe points — how do the three strategies (cancellation-style / queue-style / parallel-style) map onto scheduling semantics? (KP-04-17)
4. **Q-T4** How does synchronous LLM tolerate asynchronous interruption? Do the five placeholder rules preserve the "normal perfectly-synchronous trajectory"? (KP-04-17)
5. **Q-T5** For tools with external side effects (payments / messaging), how is the recovery contract (idempotency keys / reconciliation) turned into a platform convention? (KP-10-10)
6. **Q-T6** Where do circuit-breaker thresholds come from? Are they production-data statistics (e.g. "3 consecutive times") or made up? (KP-05-05)
7. **Q-T7** How are repeated-call fingerprints and death spirals detected and terminated using the log? (KP-05-05)
8. **Q-T8** On failure, "retry the current sub-task" or "globally re-plan"? What is the basis for the decision? (KP-09-15)

## IV. Feedback is not fact authority (verification, self-check & fact authority)

1. **Q-F1** Is Self-check "bounded repair" rather than "unlimited retry"? After consecutive failures, does it trip the circuit breaker and hand control back to a human? (KP-01-15)
2. **Q-F2** Is Self-check "evidence" restricted to structured fields? How do we prevent prompt injection from "laundering" results through self-check? (KP-01-11)
3. **Q-F3** How is the "commitment–action consistency" check implemented cheaply on the TaskRun log? (claimed completion vs. actual tool calls in the log) (KP-08-04)
4. **Q-F4** A rejected self-check enters the log as a tool-call-level event, letting the Agent digest it through its existing failure-handling path — how is this implemented? (KP-04-11)
5. **Q-F5** Validators are module-separated from "generation and modification" (judge decoupled from evolution) — how is this guaranteed? (KP-08-03)
6. **Q-F6** Learning signals have three sources (environment outcomes / process rules / LLM rubrics) — are the deterministic parts never delegated to the model? (KP-08-02)
7. **Q-F7** How are veto dimensions (hallucination / safety) calibrated and double-checked, so false positives don't drag down the overall score? (KP-06-02)
8. **Q-F8** Task-completion facts are defined by terminal-state events, not by front-end claims — how is "it's done" solidified into the log? (KP-09-14)

## V. Tool System & Safety (the Harness's "hands and feet")

1. **Q-U1** How do the five tool categories (perception / execution / collaboration / user communication / event triggering) enter the Event Log as first-class events? (KP-04-01)
2. **Q-U2** Capability expression: specialized tools vs. Skill + generic executor — how is the three-dimensional decision (parameter complexity / change frequency / model capability) implemented? (KP-04-02)
3. **Q-U3** Are the five tool-description fields ("when to use / boundaries / counterexamples / examples / costs") mandatory? Can description defects be reverse-engineered from failure logs? (KP-04-04)
4. **Q-U4** Safety layers for execution tools (input-validation fast-fail / permissions / sandbox isolation) — how is process-level / container / microVM chosen by deployment? (KP-04-10)
5. **Q-U5** The sidecar safety validator reads only structured fields, never the model's free-form text — is the watchdog designed accordingly? (KP-04-12)
6. **Q-U6** Parameter-passing fidelity: tools must not silently alter parameters; any rewriting is recorded as an explicit event — how is this guaranteed? (KP-04-05)
7. **Q-U7** Does the sandbox meet the four bottom lines of "no network by default, time-limited / CPU-limited / memory-limited / output-limited"? (KP-01-03)
8. **Q-U8** Commands go through semantic parsing rather than blacklists — how does Maka's Bash recognize parameter-consumption rules? (KP-05-09)
9. **Q-U9** Idempotency and cancellation: how is "did the side effect happen or not" answered? Which operations need the two-phase "pre-check—confirm"? (KP-04-13)

## VI. Evaluation (evaluation is the foundation)

1. **Q-E1** The evaluation unit = model × Harness — do Tool Result pruning, Compaction, and Self-check belong to "model capability" or "Harness design"? How is model swap judged? (KP-06-01)
2. **Q-E2** How are Pass@k (capability ceiling) and Pass^k (business reliability) reported simultaneously with their definitions clearly stated? (KP-06-03)
3. **Q-E3** Can every harness feature be independently disabled for ablation (bare-model baseline)? Is the switch injected extremely early in the startup path? (KP-06-19)
4. **Q-E4** Before using LLM-as-a-Judge, is the judge calibrated first (gold set + kappa)? How is a heterogeneous judge forced in for same-family-model issues? (KP-06-06/06-13)
5. **Q-E5** How does failure attribution locate the "first error"? How are structured attribution records (step / tool / evidence / confidence / primary & secondary causes) produced from the Event Log? (KP-06-14)
6. **Q-E6** End-to-end regression vs. trajectory-prefix regression (frozen prefix that tests only the next decision boundary) — how are both sets maintained? (KP-06-15)
7. **Q-E7** Is statistical significance (confidence intervals / paired tests / multiple random seeds) built into comparison output? (KP-06-17)
8. **Q-E8** How is the closed loop of production bad cases → de-identification → regression set built? (KP-06-18)
9. **Q-E9** When scores drop, how do we distinguish "evaluation-system problem" from "real degradation" — check the evaluation first, then touch the Agent? (KP-06-19)

## VII. Continuous Evolution (headless / self-evolution)

1. **Q-V1** "Log = runtime" does not mean "log = learning" — how are the evaluation / induction / verification layers stacked on top of the Task Event Log? (KP-08-01)
2. **Q-V2** The online execution loop doesn't directly rewrite the production Agent; experience accumulation happens in an offline loop — where is the physical boundary placed? (KP-08-11)
3. **Q-V3** How are the four update carriers (knowledge / instructions / programs / parameters) routed? Is the choice based on "whether the carrier can naturally express it"? (KP-08-05)
4. **Q-V4** Changes first become candidates, then canary release, with automatic rollback on metric degradation — how is the candidate → canary → production state machine implemented? (KP-08-12)
5. **Q-V5** How are the three security isolation layers (evidence vs. instructions / candidate vs. production / safety mechanisms cannot self-modify) mapped into file permissions? (KP-08-14)
6. **Q-V6** "Complete" ≠ "progress" — how is "agent metric improved but the real goal untouched" flagged? (KP-08-13)
7. **Q-V7** How does the five-step sleep-learning cycle (trigger—orient—integrate—verify—prune) couple with the budget? (KP-08-15)
8. **Q-V8** How is the root of trust (evaluator / permission boundary / held-out tests) guaranteed to lie outside the modifiable scope? (KP-08-10)

## VIII. Multi-Agent Collaboration (swarm)

1. **Q-M1** The 2×3 matrix (context sharing × collaboration topology) — which cells does the swarm support in its first phase? (KP-10-01)
2. **Q-M2** The value criterion for multi-agent = whether "new information unavailable at generation time" is introduced — how is the swarm decision gate implemented? (KP-10-05)
3. **Q-M3** When context isn't shared, the handoff package has three parts (task description / confirmed facts & constraints / artifact references) — how do "confirmed facts" connect with creed 4? (KP-10-15)
4. **Q-M4** Agents-as-tools for each other (Manager mode) + sub-agents returning structured summaries rather than full trajectories — how is this implemented? (KP-10-14)
5. **Q-M5** Concurrency in a shared workspace (optimistic locking / worktree isolation) — how are file-level and semantic-level conflicts handled? (KP-10-18)
6. **Q-M6** Cascade termination — "one succeeds, everyone stops" — how does the race condition (settle exactly once) get deduplicated via the log? (KP-10-11)
7. **Q-M7** Error-cascade amplification — handoffs/scheduling reference original evidence rather than retellings; how does cross-validation break the amplification chain? (KP-10-19)

---

## Mapping to Maka's Four Creeds

| Creed | Questions | Count |
|---|---|---|
| Log is the Runtime | Q-L1…L9 | 9 |
| Context is not history | Q-C1…C10 | 10 |
| A task may outlive a Turn | Q-T1…T8 | 8 |
| Feedback is not fact authority | Q-F1…F8 | 8 |
| Tool system & safety | Q-U1…U9 | 9 |
| Evaluation | Q-E1…E9 | 9 |
| Continuous evolution | Q-V1…V8 | 8 |
| Multi-agent collaboration | Q-M1…M7 | 7 |
| **Total** | | **68** |
