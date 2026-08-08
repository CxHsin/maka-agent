# Chapter 2 · Context Engineering — Knowledge Point Extraction

> Source: `book/chapter2.md` (the most critical chapter in the book). Chapter throughline: **what you show the model and how you organize it affect the final result more than how smart the model itself is.** It answers "how to provide the model with an information-rich $c_t$ (the complete interaction context up to the present) at lower cost," unfolding along the "static prefix + trajectory" skeleton: KV cache → prompt engineering → prompt injection → Agent skills → status bar → context compression.
>
> **One-sentence takeaway for Maka as a whole**: nearly every mechanism in this chapter (status bar, compression, Skills, sub-Agent isolation, cache stability) can be unified as **"the Runtime Event Log is the single source of truth, and the various context views (system/tools/Skill catalog/status bar/pruning/compaction/recovery) are all projections of the log"**, and "append-only log + mutable projections" happens to satisfy both the KV cache prefix-stability credo and the "Context is not history" credo at the same time.

## 1. Context: What Determines the Ceiling of Capability

### [KP-02-01] Context quality determines the ceiling of Agent capability
- **One-sentence core**: model intelligence is only the foundation; context quality is the real key to Agent capability; a mid-tier model with carefully organized context often beats a top-tier model blindly groping in information scarcity.
- **Key design points**: the minimum information requirements of a Coding Agent fall into three categories (real-time code context / process conventions / environment information); context engineering is even more of an organizational problem ("teams that are remote-work-friendly are also friendly to AI Agents"); ReAct defines $c_t$ = the complete interaction history up to the present; the model API is stateless, and each call has the context reconstructed by the framework — production systems may compress but **must not silently drop the information needed to decide the next action**.
- **Maka design insight**: directly supports "Log is the Runtime" — the Event Log is precisely the "interaction history" that must be retained in full; pruning/compaction must explicitly declare "what was removed from the next inference and why it is safe to drop."
- **Writable design doc**: "Runtime Event Log Event Model and Context Projection Specification"

## 2. API Message Structure and the Agent Core Loop

### [KP-02-02] API message structure and the four message roles
- **One-sentence core**: the core of the model API is the message list; four roles (system/user/assistant/tool) + an independent `tools` field = the five components of context.
- **Key design points**: system has the highest priority and usually sits first as a single message; assistant is echoed back verbatim so the model can "see" its own decisions; tool is linked via `tool_call_id`; the static prefix (System+Tools) stays unchanged within a session while the trajectory grows dynamically — "the front cannot be touched, the back can be compressed."
- **Maka design insight**: Event Log roles/event types should align with this but be finer-grained (also recording framework-injected metadata and tool schema loading); the log should retain role markers and `tool_call_id` links so that a valid API message list can always be replayed at any point in time.
- **Writable design doc**: "Message Role ↔ Event Log Event Type Mapping Table"

### [KP-02-03] Agent core loop: the multi-turn tool-call interaction protocol
- **One-sentence core**: the core loop is "request → tool call → execution → return result → request again"; **the model is responsible for decisions, the framework is responsible for execution**.
- **Key design points**: the model returns a tool-call request rather than an answer; the second request must include the complete history of the first; independent calls can be parallel, dependent calls are serial; the termination condition = the model outputs text (no `tool_calls`); the fixed output-token order is "internal thinking → text → tool call."
- **Maka design insight**: consistent with TaskRun loop driving and the "model decides, framework executes" division of responsibility; each iteration is replayable/interruptible/resumable (the log is the loop state).
- **Writable design doc**: "TaskRun Loop Event Protocol and Parallel Tool-Call Modeling"

### [KP-02-04] max_iterations and deadlock/repeated calls
- **One-sentence core**: the minimal Agent core is "while loop + judgment"; the framework's core job = managing the messages list; production code must add a max_iterations cap, otherwise the model may repeat the same tool call forever.
- **Key design points**: a sliding window drops key tool results → the Agent "forgets" → repeatedly executes the same call and falls into a loop (empirically demonstrated by Experiment 2-3); common pitfalls: mistaking tool results for user messages, and the model losing count.
- **Maka design insight**: budget mechanisms and max_iterations share the same origin; both should be projections/checkpoints over the Event Log; deadlock/repeated calls should be written to the log as observable signals (same tool N consecutive times, no new information increment) for headless budget interruption and self-check to reference.
- **Writable design doc**: "Loop Termination Conditions and Budget/Deadlock-Prevention Strategies"

### [KP-02-05] Context composition: static prefix + dynamic trajectory
- **One-sentence core**: each API call = the unchanged system prompt and tool definitions (static prefix) + the ever-growing conversation history (trajectory); understanding this is the key to "why the front cannot be touched and the back can be compressed."
- **Maka design insight**: "context projection" is precisely a product of this structure — the Event Log is the single source of truth, and the System Prompt / tool set / Tool Result pruning / compaction / status bar are all views assembled at projection time; changing a projection does not affect already-recorded evidence.
- **Writable design doc**: "Context Projection Architecture: From Event Log to Model Request"

## 3. KV Cache-Friendly Context Design

### [KP-02-06] Three iron rules of KV cache-friendly design
- **One-sentence core**: the KV cache reuses already-computed K/V, on the precondition that **the prefix token sequence is byte-identical**.
- **Key design points**: ① Once the system prompt and tool definitions are decided, don't change them (the further forward a change is, the bigger the latency/cost impact); ② dynamic information is always appended to the end; ③ use the standard API format, don't hand-concatenate messages. Counter-example: adding `Current time: {{now}}` to system → first-token latency 0.5s→3-5s, monthly bill nearly doubled.
- **Maka design insight**: pruning and compaction must obey the "static prefix stays untouched" discipline; dynamic information such as the status bar/timestamps is always appended; any implementation that "rewrites existing messages" is audited against this.
- **Writable design doc**: "KV Cache-Friendly Context Layout Specification (Three Iron Rules)"

### [KP-02-07] Chat template and token structure
- **One-sentence core**: structured messages are converted by the Chat template into a linear token stream (special markers delineate role boundaries); it is not just the cache foundation — it also determines whether multi-turn tool calls and chain-of-thought retention work correctly.
- **Key design points**: treating tool results as user messages gets them misidentified as new queries → the historical chain of thought is taken away; **historical chain-of-thought return policy varies by model and is evolving rapidly** (DeepSeek R1 strips all → V4 forces all back, Kimi K2/GLM-5 likewise; Claude requires the client to echo back the signed thinking block verbatim) — always consult the latest docs before use.
- **Maka design insight**: the log retains API-layer messages rather than token streams; multi-model support makes chain-of-thought return a per-provider projection parameter, and the log must retain the full assistant message (including the reasoning/thinking field) to enable per-model replay.
- **Writable design doc**: "Multi-Provider Message Projection and Chain-of-Thought Return Policy"

### [KP-02-08] KV cache principles and constraints
- **One-sentence core**: without a cache, prefill attention computation grows **quadratically N²** with context; even with a cache it still slows linearly with length, and memory/bandwidth become the bottleneck; the cache only recognizes token-byte prefix invariance.
- **Key design points**: attention visualization (Experiment 2-2) — the **attention store** (the first token can hold >70% weight), the twin triangles of thinking and output, and **Lost in the Middle** (high attention at the start and end, the middle is easily neglected).
- **Maka design insight**: pruning/compression/status bar respect "the further forward a change point is, the higher the cost"; "put the most critical information at the start or the end" is simultaneously a guiding principle for both prompt design and log-projection ordering.
- **Writable design doc**: "Context Layout and Attention-Position Preference Guide"

### [KP-02-09] Common erroneous context management patterns (measured in Experiment 2-3)
- **One-sentence core**: five seemingly harmless patterns systematically break the KV cache and even core capability — dynamic system prompt, dynamic user configuration, dynamic ordering of tool definitions, sliding-window conversation history, and text formatting.
- **Key design points**: the sliding window both breaks prefix consistency and drops key results (error rate rises significantly, frequent loops); tool definitions **keeping a fixed order has almost no effect on tool-selection capability but yields a significant performance gain**; what text formatting truly breaks is deviating from the training format → the model spends attention inferring role boundaries. **Deviating from the standard format is usually digging a hole for yourself.**
- **Maka design insight**: the Event Log is naturally "append-only," sidestepping the sliding-window and prefix-rewriting problems; but Tool Result pruning/compaction is subtraction from history and must beware of repeating the same mistakes — pruned key evidence must leave traces in the log and be traceable.
- **Writable design doc**: "Anti-Pattern Checklist for Pruning and Compression (against Experiment 2-3)"

### [KP-02-10] KV cache and prompt cache: two tiers of caching
- **One-sentence core**: KV cache = faster token generation within a single request; prompt cache = reusing the same prefix across requests (Anthropic/DeepSeek/GPT-5 at roughly 1/10 the cost).
- **Maka design insight**: projection stability directly determines prompt cache hit rate; the log records prompt/cached tokens per request as a context-health metric.
- **Writable design doc**: "Prompt Cache Hit-Rate Observation and Projection-Stability Metrics"

### [KP-02-11] Cache as an architectural constraint
- **One-sentence core**: in production-grade systems, caching is not a post-hoc optimization but an **architectural constraint** — when the economic benefit of the prompt cache is significant, cache consistency in turn dominates architecture choices (the Claude Code practice).
- **Key design points**: prompt structure is determined by cache boundaries; dynamically injected tool schemas are "appended to the end and frozen" to keep the prefix stable.
- **Maka design insight**: once a pruning/replacement decision is made, it is "frozen" (to avoid repeatedly rebuilding the cache); cache constraints should be front-loaded into architecture design.
- **Writable design doc**: "Cache Economics as an Architectural Constraint"

## 4. Prompt Engineering and Prompt Injection

### [KP-02-12~16] Prompt engineering essentials
- **KP-02-12 The full landscape of prompt engineering**: tone/style (persona), structuring (format), process-driven vs. rule-stacking (organization), business-rule refinement (content), few-shot examples (when to give examples), tool-definition design (when to use / boundaries / examples). Experiment 2-4 ablation: scrambling information organization → success rate −30%+; removing tool descriptions → call error rate +45%.
- **KP-02-13 Tool-definition design**: write "when to use, boundaries, counter-examples, examples, cost" into the description (same lineage as the art of tool description in Chapter 4).
- **KP-02-14 Dynamic prompts**: append dynamic information to the end; don't render the system prompt with templates.
- **KP-02-15 Prompt injection attack and defense (core threat)**: every perceptual tool is a potential injection entry point (hidden web elements / PDF metadata / image EXIF); the core of context-layer defense is helping the model distinguish **"instructions" from "data"** — source marking (`<external_content source=...>`), structured roles (strictly use the Chat template role system), input scrubbing (auxiliary only); **new injection surfaces: third-party Skills hiding malicious instructions (must be audited before installation as if auditing code), and status-bar poisoning** (the status bar is highly trusted; if it derives from externally polluted data it can be exploited in reverse). Context-layer defense is only the first line of defense.
- **Maka design insight**: the Event Log should record "source markers" (webpage/doc/email/external) at injection points; extending "Feedback is not fact authority" — external content/Skills/status bar all belong to "low-authority inputs," and self-check conclusions must not be automatically promoted to system facts, preventing injected content from "whitewashing" itself through self-check.
- **Writable design doc**: "Source Marking, Instruction/Data Separation, and Injection Audit (Security Design)"

## 5. Dynamic Prompts and Agent Skills

### [KP-02-18] Agent skills: composable units and progressive disclosure
- **One-sentence core**: a Skill is a "on-demand professional knowledge package" using progressive disclosure — first give a catalog summary (a few hundred tokens), and load the full body only when needed, avoiding unbounded prompt bloat.
- **Key design points**: two problems of system-prompt bloat (wasted tokens, attention dilution = context rot); **a three-tier structure** (YAML metadata name+description resident → core SKILL.md loaded on demand → finer sub-documents); Skills can bundle executable code tools and templates; **description should read like a routing condition rather than a feature description — "Use when / Don't use when" + counter-examples, and counter-examples are not optional** (vague descriptions trigger frequently by mistake; accuracy recovers once counter-examples are added); Skills are self-contained knowledge modules (a pip/npm-style ecosystem); the chosen Agent interaction mode should align with the model vendor's training methodology.
- **Maka design insight**: Skill loading/body injection are both log events (catalog resident in system, body appended into the trajectory); Maka can treat Skills as a "capability-as-content" plugin system (similar to opencli adapters), reusing the "description with counter-examples" routing convention.
- **Writable design doc**: "Agent Skills Plugin Model and Progressive-Disclosure Implementation"

### [KP-02-19] Where Skills sit in context, cache cost, and the relationship to tools
- **One-sentence core**: the metadata catalog = a stable prefix (continuously reusing the prompt cache); the full body = enters the trajectory when invoked; "KV cache-friendly" is not zero-cost.
- **Key design points**: the Skill catalog goes in the system prompt (Claude Code) or in the fixed-prefix position that activates tool descriptions; **in the Skill + general executor mode the number of tools stays small (about 7 core tools in Chapter 5)**.
- **Maka design insight**: the tool set should be "small and stable"; the Skill catalog is a stable prefix and the body is appended into the trajectory — both have corresponding events on the Event Log; prefer few tools + Skills over piling up tool definitions.
- **Writable design doc**: "Skills Context Layout and KV Cache Cost Model"

## 6. Agent Status Bar

### [KP-02-20] Status bar: theoretical foundation (retrieval rather than reasoning + context distillation)
- **One-sentence core**: the status bar is a structured status summary the framework continuously injects at the end of context; its theoretical foundation is **"in-context learning behaves like retrieval rather than reasoning — the context window is a retrieval engine with only half a machine"** (retrieval is strong, but there is no distillation layer).
- **Key design points**: models are not good at "aggregating statistics" in a single forward pass; any conclusion about existing content must be recomputed from scratch each time; distilling scattered implicit state into explicit knowledge ("this is the 3rd call") → error rate drops substantially. Context-distillation research: ① weak models recover accuracy (a 2B small model matches a frontier large model without a status bar); ② strong models save efficiency (thinking volume/latency/cost drop by about an order of magnitude); ③ thinking volume goes from "growing continuously with context" to "basically constant." **Three hard-won practical lessons**: ① maintain the status bar with code, not with a large model (20 lines of regex reach the standard-answer level); ② don't delete the original context (the status bar is a lossy projection that only computes the dimensions "expected to be asked about"; dimensions not computed collapse off a cliff); ③ treat status-bar accuracy as a first-line production metric (**the model trusts the status bar almost unconditionally**; if it's written wrong it goes verbatim into the final answer, so the poisoning risk must be taken seriously).
- **Maka design insight**: "deterministic maintenance with code + don't delete the original evidence" is highly isomorphic with "Log is the Runtime / Context is not history" — the status bar is a projection of the log (recomputable from code), and the original trajectory still lives in the log.
- **Writable design doc**: "Agent Status Bar Projection: Deterministic Generation and Reliability Metrics"

### [KP-02-21] Status bar composition and its position in context
- **One-sentence core**: the status bar contains three kinds of meta-information — task planning (TODO), event side-channel information, and an environment-current-state observation summary; at the API layer it is inserted at the end of context as a **user-role message** (borrowing the user message slot), wrapped in an `<agent_status>` tag.
- **Key design points**: end + tag = right next to the new tokens with the highest attention + append doesn't break the cache; **the user role here is only a protocol-level technical choice; it does not equal "end-user input."** Five status-bar techniques (Experiment 2-8): timestamp tracking, tool-call counter, TODO-list management (15 vs 21 iterations), detailed error messages (alternative-success rate 60%→95%), system-state awareness; combining them produces emergent effects; non-invasive to the model, no fine-tuning needed.
- **Maka design insight**: the status bar is the best projection sample of "Log is the Runtime"; this protocol detail of "borrowing the user slot" must be clearly recorded (the log distinguishes "real user events" from "framework-injected user-slot events").
- **Writable design doc**: "Status Bar Composition Standard and Injection Protocol (including the user-slot borrowing convention)"

### [KP-02-22] Two implementations of status updates and their cache cost
- **One-sentence core**: "appending doesn't break the cache" only holds for a single injection; status updates have two implementations — replace-per-turn vs. persistent append — each with its own explicit cache cost.
- **Key design points**: replace-per-turn = only one latest status is kept, but removing the old status invalidates the cache after it (at the end; invalidation scope is limited to only the most recent few turns); persistent append (Claude Code `<system-reminder>`) = fully cache-friendly but stale statuses accumulate. Trade-off: frequent updates and a long trajectory → append; short trajectory or a single very large status → replace.
- **Maka design insight**: the log keeps the full history of status events; the projection layer chooses replace or append based on trajectory length/update frequency.
- **Writable design doc**: "Status Bar Update Strategy and Cache-Cost Trade-off (append vs replace)"

## 7. Context Compression Strategies

### [KP-02-23] Compression: why it's needed + the internal mechanics of in-context learning
- **One-sentence core**: compression has two motivations — length/cost constraints, and (more deeply) **improving thinking quality**: high-density summarized knowledge is more usable by the model than its raw form, because "in-context learning is essentially retrieval rather than reasoning."
- **Key design points**: the pet shop with 100 cages, 90 black and 10 white — the chain of thought counts from zero each time, costs accumulate; writing "black 90, white 10" in advance → the model immediately retrieves the conclusion. **Context rot vs overflow**: rot is "it fits, but you can't find it," more insidious, decision quality quietly degrades. Design principle: **don't make the model passively retrieve among a flood of information; proactively provide distilled structured knowledge**; in-context learning is a fast-adaptation mechanism, not real learning.
- **Maka design insight**: compaction is not discarding evidence but "turning conclusions that require thinking into retrievable knowledge"; beware of context rot (compress before quality drops even when the window isn't full).
- **Writable design doc**: "Compression Motivation Model and Context Rot Detection"

### [KP-02-24] Compression and the KV cache: seemingly contradictory, actually complementary
- **One-sentence core**: compression is a pre-processing step the framework performs on the message list between two API calls — the static prefix is never touched; only tool results in the trajectory are compressed.
- **Key design points**: the compression target is tool results (a summary replacement invalidates the cache after the replacement point); **it's best to compress in batches when context approaches the threshold rather than every turn**.
- **Maka design insight**: Tool Result pruning and compaction should live in the "projection pre-processing between calls" layer, isolated from the log — precisely the architectural boundary of "Log is the Runtime / Context is not history."
- **Writable design doc**: "Compression Scheduling: Timing, Location, and Batch-Trigger Strategy"

### [KP-02-25] Production-grade tiered compression mechanism (Claude Code's five tiers)
- **One-sentence core**: mature systems combine multiple strategies into tiered compression, with different information types having different shelf lives.
- **Key design points** (five tiers): ① tool-result budget control (large outputs stored to disk, the model sees summaries, replacement decisions **frozen** to preserve cache consistency); ② direct deletion of noise (summarizing noise is just wasted tokens); ③ API-layer micro-compression (server-side context editing, suited for when overflow is imminent); ④ archival-style summarization (**like `git log`, keeping each turn's independent record, rather than `git squash` merging**); ⑤ full compression (LLM-driven, last resort, in two phases, **with a circuit breaker for consecutive failures** — production data shows a large number of sessions stuck in repeated compression-failure loops).
- **Maka design insight**: pruning = noise deletion + budget control; compaction = archival/full compression; the circuit-breaker idea is consistent with budget/bounded repair; "archival-style summarization = git-log-style per-turn records" is naturally compatible with the Event Log.
- **Writable design doc**: "Tiered Compression Mechanism and Circuit-Breaker Strategy (aligned with Claude Code's five tiers)"

### [KP-02-26] Compression-strategy design principles and implications for architecture
- **One-sentence core**: four design principles (non-uniform information value, semantic completeness, task relevance, **compression-as-understanding**), and "compression-as-understanding" has deep architectural implications.
- **Key design points**: architectural implication one — the compression module itself needs language-understanding ability close to the main model's → the recursive **"model calling model"** architecture; implication two — compression strategy is coupled to task type (retrieval preserves breadth, analysis preserves depth, creation preserves inspiration trigger points). Economics: context-aware compression reduces tokens by 75%+. **What compression loses most easily is not details, but early architectural decisions, the reasons behind constraints, and failure paths** → explicit retention priorities: ① architectural decisions and key constraints: must not be summarized; ② the list of modified files and key changes: retained in full; ③ verification status (pass/fail): must be retained; ④ unresolved TODOs and rollback notes: must be retained; ⑤ tool output: deletable, keeping only the pass/fail conclusion.
- **Maka design insight**: the retention-priority list should directly become compaction's system prompt/constraint; "Context is not history" = compression changes what the next inference sees, but the original evidence still lives in the log.
- **Writable design doc**: "Compression Retention-Priority Checklist and Task-Type-Adaptive Strategy"

### [KP-02-27] Isolation beats compression: sub-Agent context isolation
- **One-sentence core**: more radical than compression — delegate tasks that produce a flood of intermediate content to independent sub-Agents, and the sub-Agent only sends back a few-hundred-token conclusion.
- **Key design points**: the main Agent searching itself → tens of thousands of tokens of raw code enter the main context as permanent noise; delegating to a search sub-Agent → the main context only gains two messages. **In essence, isolation replaces compression** (compression is a lossy post-hoc remedy; isolation insulates the noise from the start); the cost: the task description must be self-contained with a clear goal.
- **Maka design insight**: directly supports TaskRun/Headless persistent tasks — each sub-task has its own independent Task Event Log and context, and the main log only records the two events "dispatch task + receive conclusion"; "task description must be self-contained" should become a mandatory contract for derived TaskRuns.
- **Writable design doc**: "Sub-Agent Context Isolation and the TaskRun Delegation Contract"

## Chapter Golden Quotes / Core Conclusions
- "People, like models, matter most is Context" (翁家翌 / Weng Jiayi); "AI is not in the same environment as humans."
- "What you show the model and how you organize it usually affect the final result more than how smart the model itself is."
- "An AI Agent is like a perpetual new hire: given enough background information it can do great work; told nothing, no matter how smart, it's useless; building an AI-native team is first and foremost a documentation movement."
- The three iron rules of the KV cache: "once the system prompt and tool definitions are set, don't change them," "always append dynamic information to the end," "use the standard API format, don't hand-concatenate messages."
- "The context window is a retrieval engine with only half a machine" — retrieval is strong, but there is no "distillation layer."
- "The status bar is a lossy projection of the original context"; "the model trusts the status bar almost unconditionally."
- "In-context learning is more like a fast-adaptation mechanism than real learning."
- "Context rot is 'it fits, but you can't find it,' more insidious than overflow ('it no longer fits')."
- "Compression is understanding"; "what compression loses most easily is not the details themselves, but early architectural decisions, the reasons behind constraints, and failure paths."
- "Isolation beats compression: compression is a lossy post-hoc remedy that needs extra LLM calls; isolation keeps noise insulated from the main context from the very start."

## Companion Experiments Quick Look (chapter2/, all Passed)
| Experiment | Topic | Key Conclusion |
|---|---|---|
| 2-1 | Local LLM service and tool calling | Qwen3-0.6B reliable tool calls; >100 tok/s on M2 |
| 2-2 | Attention visualization | attention store (first token >70%), twin triangles, Lost in the Middle |
| 2-3 | Erroneous context management patterns | sliding window causes repeated-call loops |
| 2-4 | Prompt engineering ablation (Tau-Bench) | scrambled information organization −30%+; removing tool descriptions +45% errors |
| 2-5 | Prompt injection attack and defense | 3 attacks × 4 defenses; ledger notes Kimi K3 measured at all 0% (model fully resists) |
| 2-6 | Skills generate PPT | progressive loading (metadata → SKILL.md → sub-docs → script) |
| 2-7 | Status bar effectiveness | with `<agent_status>` 3/3 stable constraint compliance |
| 2-8 | Five status-bar techniques | TODO 15 vs 21 iterations; detailed errors 60%→95% |
| 2-9 | Six context compression strategies | context-aware compression −75%+ tokens (40,157 vs 165K); adaptive-window 80%-threshold batch compression |

## Review Questions from the Book (transcribed key points)
1. Sliding-window information loss vs. context bloat vs. not breaking the KV cache — design a strategy that satisfies all three.
2. Chain-of-thought retention in very long ReAct loops; what does the reversal from DeepSeek R1 stripping reasoning to V4 forcing it back indicate?
3. How to resolve the irreversible information-loss risk of extreme compression (148K→2K)?
4. How to mitigate the "meta-information reliability" problem when the status bar's meta-information itself goes wrong (a tool-counter bug)?
5. How to prevent the "entropy increase" of a system prompt maintained by many people through engineering practice?
6. If "in-context learning is retrieval rather than reasoning" holds, how should the optimization direction of "stuff in more information" be re-examined?
7. Skills' progressive disclosure relies on the model "knowing what it doesn't know" — how to solve this metacognition problem?
8. Can a model correctly follow prompts it dynamically reads from a SKILL file? What are the support differences across models?
9. For a production system with many tools whose tool set changes frequently, how should the context layout be designed to maximize cache hit rate?
