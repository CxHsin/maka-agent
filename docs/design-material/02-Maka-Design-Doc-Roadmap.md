# Maka Design Document Topics and Roadmap (Essential Edition)

> Only design documents related to **the Agent harness itself** are kept. The five harness elements (context management, tool interface, constraints, verification, correction) are the main thread; everything else (memory knowledge base, multimodal, robotics, agent societies, etc.) only includes parts directly related to the harness.
>
> Priority: P0 = the core foundation of Maka's existing architecture (Event Log/context/tools/permissions/eval/headless), to be documented first; P1 = deepening and closing the loop; P2 = forward-looking.
> Each topic is tagged with the corresponding knowledge point (KP-xx-xx); the supporting evidence lives in `agent-book-knowledge/`.

---

## A · Overall Guidelines and Design Principles

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| A1 | 《Maka Design Principles and the Mapping of Agent = LLM + Context + Tools》 | **P0** | KP-11-01, KP-00-01 | The four credos correspond to the three questions of "what it sees / what it can do / how to verify whether it did it right"; must not be overturned by model API changes |
| A2 | 《Maka Harness Five Elements and Package Structure Mapping (Log Events for Constraints/Verification/Correction)》 | **P0** | KP-01-09 | Context/tools/constraints/verification/correction → acceptance checklist for each Maka package; these events must be recorded in the log |
| A3 | 《Model-Agnosticism Argument for Maka Architecture Principles and Cross-Generation Evolution》 | P1 | KP-00-04, KP-11-08 | Which credos get internalized by the model and which never become obsolete; "credo review process" |
| A4 | 《Evolution of Maka's Layered Architecture and the Harness Retirement Strategy》 | P1 | KP-11-05/06 | Every harness fallback logic must be observable/deletable/upgradeable into a training signal |

## B · Runtime Event Log and Context Projection

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| B1 | 《Runtime Event Log Event Model and Context Projection Specification》 | **P0** | KP-02-01/02/05 | Complete set of event types; schema must strictly separate evidence (immutable) from conclusions (mutable projections) |
| B2 | 《TaskRun Loop Event Protocol and Parallel Tool Call Modeling》 | **P0** | KP-02-03/04 | Loop termination facts, budget / deadlock prevention, parallel call modeling, repeated-call fingerprints |
| B3 | 《Context Projection Architecture: From Event Log to Model Requests》 | **P0** | KP-02-05, KP-02-27 | How static prefix / dynamic trajectory are projected from the log; pruning / Compaction / status bar are all projection views |
| B4 | 《Maka ReAct Loop and Trajectory Projection Model over the Event Log》 | P1 | KP-02-08 | Precisely reconstruct "static prefix + trajectory" at any turn to support resumption from any point |
| B5 | 《Multi-Provider Message Projection and Chain-of-Thought Relay Strategy》 | P1 | KP-02-07 | Per-provider reasoning/thinking relay; the log retains complete assistant messages |
| B6 | 《Replayable Trajectory Log and Event Encoding + Feedback Token Masking Markers》 | P1 | KP-07-05, KP-07-13 | Logs are designed for offline replay; distinguish model-generated from tool-returned content (masking principle) |
| B7 | 《Event Log → Span Tree and the Closed Loop of Evaluation Asset Reuse》 | P1 | KP-06-18 | Align with OpenTelemetry/OpenInference; production bad cases → desensitization → regression set |

## C · Context Management: Pruning / Compaction / Status Bar / Skills / Caching

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| C1 | 《KV Cache-Friendly Context Layout Specification (Three Iron Rules) and Anti-Pattern Checklist》 | **P0** | KP-02-06/09 | Static prefix untouched, dynamic appended at the tail, standard API format; 2-3 controlled experiments |
| C2 | 《Layered Compaction Mechanism and Circuit-Breaker Strategy (Aligned with Claude Code's Five Layers)》 | **P0** | KP-02-25 | Trigger conditions and cost model for the five layers; archival-style summarization = record turn by turn; circuit-break on consecutive failures |
| C3 | 《Compaction Retention Priority Checklist and Task-Type-Adaptive Strategy》 | **P0** | KP-02-26 | Architecture decisions / verification state / TODO must not be summarized; retrieval favors breadth, analysis favors depth |
| C4 | 《Compaction Scheduling: Timing, Location, and Batch Trigger Strategy》 | P1 | KP-02-24 | Batch compaction near the threshold; freeze replacement strings; trade off against caching cost |
| C5 | 《Compaction Motivation Model and Context Corruption Detection》 | P1 | KP-02-23 | Corruption vs overflow; log metrics (repeated calls / back-and-forth flailing) as signals |
| C6 | 《Agent Status Bar Projection: Deterministic Generation, Injection Protocol, and Reliability Metrics》 | **P0** | KP-02-20/21 | Status bar = log projection; user-slot borrowing convention; the model trusts it unconditionally, so accuracy is a first-line metric |
| C7 | 《Status Bar Update Strategy and the Caching Cost Trade-off (append vs replace)》 | P1 | KP-02-22 | Frequent updates + long trajectories → append; short trajectories + large state → replace |
| C8 | 《Agent Skills Plugin Model and Progressive Disclosure》 | **P0** | KP-02-18/19 | Three-layer structure; description with counter-example routing conventions; the catalog = stable prefix, body goes into the trajectory |
| C9 | 《Sub-Agent Context Isolation and TaskRun Delegation Contract》 | **P0** | KP-02-27 | Delegated task descriptions must be self-contained; the main log records only dispatch + conclusion; trade off isolation vs byte alignment |

## D · Tool System, Permissions, and Security

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| D1 | 《Maka Tool Taxonomy & Event Typology》 | **P0** | KP-04-01 | Event types by which the five tool categories enter the Event Log |
| D2 | 《Maka Capability Expression Decision Guide (Dedicated Tool vs Skill)》 | **P0** | KP-04-02 | Three-dimensional decision on parameter complexity / change frequency / model capability; fewer tools + Skills |
| D3 | 《Maka Tool Schema Description Specification and Automatic Validation》 | **P0** | KP-04-04 | Five fields: "when to use / boundaries / counter-examples / examples / cost"; infer description defects from failure logs |
| D4 | 《Maka Execution Tool Security Hierarchy (Input Validation / Permission / Sandbox)》 | **P0** | KP-04-10 | Fast failure over smart correction; process-level / container / microVM chosen by deployment |
| D5 | 《Maka Watchdog / Sidecar Security Validation Design》 | **P0** | KP-04-12 | Structured input + independent lightweight judgment + gating + rejection circuit-breaker |
| D6 | 《Maka Proposer-Reviewer and Self-Check Audit》 | **P0** | KP-04-11 | Cross-source mutual review; rejections enter the trajectory as tool-call results; risk-graded approval |
| D7 | 《Maka Execution Tool Engineering Specification (Validation / Truncation / Audit / Idempotency / Cancellation)》 | P1 | KP-04-13 | Automatic verification closed loop; truncate long outputs; two-stage pre-check-then-confirm |
| D8 | 《Maka Event-Driven Asynchronous Architecture and Event Handling Strategy》 | **P0** | KP-04-15/17 | Uniform modeling of event streams; consumption at safe points; three strategies: cancel / queue / parallel; five rules for placeholders |
| D9 | 《Maka Parameter Fidelity and Tool Granularity Specification》 | P1 | KP-04-03/05 | Merge the similar, separate the heterogeneous; pass through with a trace left, treat rewriting as an explicit event |
| D10 | 《Maka Security: Sandbox Isolation, Command Semantic Parsing, and the Loyalty Code》 | P1 | KP-05-09 | Three fatal elements + four dimensions of persistent memory; semantic parsing rather than blacklists; network off by default, whitelist to enable |

## E · Evaluation System (maka eval)

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| E1 | 《Maka Evaluation Units and Attribution Methodology: Model × Harness, model swap, and Ablation》 | **P0** | KP-06-01 | Evaluation unit = model × harness; component-level ablation switches |
| E2 | 《maka eval Metric Definitions: Pass@1 / Pass@k / Best@k / Pass^k》 | **P0** | KP-06-03 | Capability ceiling vs business reliability; define the metric semantics clearly |
| E3 | 《maka eval Evaluation Pipeline and Rubric Scoring Specification (Including Veto Dimensions)》 | **P0** | KP-06-02 | Case → run → score → analysis; hallucination / safety vetoes |
| E4 | 《maka eval Judge Calibration and Multi-Source Heterogeneous Judging》 | **P0** | KP-06-06/13 | Golden set + kappa; same-source model problems; force heterogeneous judges |
| E5 | 《Failure Attribution and Structured Attribution Record Specification (Based on the Runtime Event Log)》 | **P0** | KP-06-14 | Locate the first error; step / tool / evidence / confidence / primary and secondary causes |
| E6 | 《End-to-End and Trajectory-Prefix Regression Set Construction Specification (Including Acceptable Action Sets)》 | **P0** | KP-06-15 | Freeze the prefix, test only the next-step decision boundary |
| E7 | 《maka eval Report Statistical Significance Specification (Confidence Intervals, Paired Tests, Seed Strategy)》 | **P0** | KP-06-17 | SE / CI; McNemar / paired bootstrap; multiple random seeds |
| E8 | 《Iterative SOP from Benchmark Reports to System Improvement》 | **P0** | KP-06-19 | Inspect the evaluation system before touching the agent; change only one variable per round |
| E9 | 《Process Metric Computation Specification Based on the Runtime Event Log》 | P1 | KP-06-04 | Action legality rate / tool correctness / path efficiency / cost & latency = log projections |
| E10 | 《Model Selection and Differentiated Routing Decision Process》 | P1 | KP-06-16 cont. | Three-level cost decomposition; empirically test independent switch combinations; differentiated routing |

## F · Continuous Evolution (headless / self-evolution)

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| F1 | 《From Runtime Event Log to Experiential Learning (Evaluation Layer Design)》 | **P0** | KP-08-01 | Log = runtime ≠ log = learning; evaluation / induction / verification layers |
| F2 | 《Three Sources of Learning Signals and SelfCheck Signal Integration》 | **P0** | KP-08-02 | Environment outcomes / process rules / LLM Rubrics; evaluation over summarization |
| F3 | 《SelfCheck Three-Layer Verification Structure and Dimensionalized Diagnosis Protocol》 | **P0** | KP-08-03 | Bottom: results / middle: process / top: quality; structured diagnosis, not a scalar; judge and evolution are decoupled |
| F4 | 《SelfCheck Default Rubric (Commitment-Action Consistency First)》 | **P0** | KP-08-04 | Seven-dimension Rubric; cross-check claimed vs actual tool calls |
| F5 | 《Online Execution — Offline Evolution Dual-Loop Architecture》 | **P0** | KP-08-11 | Online never modifies the production agent; offline aggregation + diagnosis + candidates + verified release |
| F6 | 《Candidate Release State Machine, Automatic Rollback, and Tiered Evaluation Metrics》 | P1 | KP-08-12 | harness-updating ≠ harness-benefit; activation rate / rule-following success rate |
| F7 | 《Self-Evolution Safety Boundaries (Three Isolations and the Root of Trust)》 | **P0** | KP-08-14 | Evidence vs instruction isolation / candidate vs production isolation / safety mechanisms cannot self-modify |
| F8 | 《Four-Vector Routing for Self-Evolution and Minimal-diff Learning》 | P1 | KP-08-05/07 | Knowledge / Prompt-Skill / program / parameters; minimal auditable diffs |
| F9 | 《The Boundary Between Completion and Progress, and the Human Intervention Protocol》 | P1 | KP-08-13 | Separate conclusions from evidence; keep negative results; humans intervene at the high level |
| F10 | 《Sleep-Learning Cycles (Trigger — Direct — Integrate — Verify — Prune)》 | P2 | KP-08-15 | Five-step cycle; separate collection from curation |

## G · Multi-Agent / Agent Swarm

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| G1 | 《Maka Multi-Agent Collaboration Architecture Selection: 2×3 Classification Matrix and Decision Checklist》 | **P0** | KP-10-01 | Which cells the swarm supports in the first phase; place each task type |
| G2 | 《Maka Multi-Agent Benefit Criterion, Budget Awareness, and Cost Model》 | **P0** | KP-10-05 | New-information criterion (swarm decision gate); 15× token / 80% performance difference |
| G3 | 《Maka Agent Swarm Communication Mechanism Design (IPC Mapping)》 | **P0** | KP-10-03 | Tool parameters / shared workspace / message bus selection; bus messages go into the log |
| G4 | 《Maka Multi-Agent State Query and Failure Recovery (Trajectory Persistence + Checkpoints + Idempotency/Reconciliation)》 | **P0** | KP-10-10 | JSONL trajectories / progress files; WAL + checkpoints + idempotency keys |
| G5 | 《Maka Error Propagation Protection: Evidence Tracing, Cross-Validation, and Runaway-Loop Guardrails》 | **P0** | KP-10-19 | Relay distortion; cite original evidence rather than relays; deterministic feedback loop-breakers |
| G6 | 《Maka Proposer-Reviewer Loop and Validator (Loop) Design》 | P1 | KP-10-12 | A model cannot approve its own completion; the Reviewer must bring new evidence |
| G7 | 《Maka Manager Mode (Manager Orchestration, Structured Summaries, Model Routing)》 | P1 | KP-10-14 | Agents are tools for each other; strong model to the planner; sub-agents return structured summaries |
| G8 | 《Maka Decentralized Peer Handoff (Handoff Package, Handoff Count Limit)》 | P1 | KP-10-15 | Handoff packages have three parts; confirmed facts = verified facts; cycle protection |
| G9 | 《Maka Shared Workspace Concurrency Control (Optimistic Locking / worktree Isolation)》 | P1 | KP-10-18 | Lost updates; optimistic-lock version numbers; isolation over compaction |
| G10 | 《Maka Multi-Agent Failure Mode Checklist (MAST Mapping) and Evidence Credibility Grading》 | P1 | KP-10-17 | 14 failure modes in 3 broad categories as a static checklist; Byzantine-failure perspective |
| G11 | 《Maka Multi-Agent Termination and Resource Scheduling (Cascading Cancellation, Budget, Preemption)》 | P1 | KP-10-11 | cancel/kill two levels; cascading cancellation along creation relations; settle only once |

## H · Memory and Knowledge Base (Cross-Session Extension of Context)

| # | Design Document | Priority | Knowledge Points | Core Questions to Answer |
|---|---|---|---|---|
| H1 | 《Maka Local Memory: Extraction Pipeline from Runtime Event Log to Persistent Memory》 | P1 | KP-03-01 | Memory = log projection; selective / abstracted / structured; asynchronous batch extraction |
| H2 | 《Maka Local Memory Three-Level Evaluation Framework and Storage Model》 | P1 | KP-03-02/03 | Basic recall → multi-session retrieval → proactive service; the three tables: events / memories / task_state |
| H3 | 《Maka Knowledge Update Governance: Proposer-Reviewer Review Closed Loop and Three-Layer Storage Separation》 | P1 | KP-03-15 | Evidence layer / knowledge layer / service layer separation; cross-source mutual review; permission-filtered retrieval |

---

## Single Design Document Writing Template

```markdown
# <Title> — Maka Design Document

## 1. Background and Goals
- The problem to solve (derived from real failure modes / needs)
- Corresponding Maka credos (Log is the Runtime / Context is not history /
  A task may outlive a Turn / Feedback is not fact authority)
- Related knowledge point IDs (KP-xx-xx) and priority

## 2. Current State
- Maka's current implementation (packages / modules / entry points)
- Existing mechanisms (Runtime Event Log, Tool Result pruning, LLM Compaction,
  Self-check, budget/continuation, maka eval)

## 3. Design Key Points (principles distilled from the book)
- Principle + rationale (engineering details / numbers from the book)

## 4. Design Decisions and Trade-offs
- Decision items: Option A vs Option B, trade-off rationale, selection

## 5. Mapping to Maka's Four Credos
| Credo | How this document implements it |
|---|---|
| ... | ... |

## 6. Open Questions (reference the corresponding items in 01-Maka Design Problem Checklist)
- Q-xx: ...

## 7. Acceptance / Evaluation
- How to evaluate this design (ablation switches? regression sets? model swap attribution?)

## 8. References
- Book chapters / experiments / knowledge point IDs
```

---

## Execution Order

1. **Lay the foundation first (P0, ~30 documents)**: A1-A2 → B1-B3 → C1-C3/C6/C8-C9 → D1-D8 → E1-E8 → F1-F5/F7 → G1-G5. These underpin Maka's existing architecture (Event Log / context / tools / permissions / eval / headless).
2. **Deepen and close the loop (P1)**: A3-A4, B4-B7, C4-C5/C7, D9-D10, E9-E10, F6/F8-F9, G6-G11, H1-H3.
3. **Forward-looking (P2)**: F10. Multimodal / robotics / agent societies, etc., are not on this list and will be evaluated separately.

> Note: This list keeps only the design documents directly related to the Agent harness; knowledge points for domains such as the memory knowledge base and multimodal remain in `agent-book-knowledge/` for on-demand reference.
