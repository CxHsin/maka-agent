# Introduction + Chapter 1 · Agent Fundamentals — Knowledge Point Extraction

> Source: `book/introduction.md` + `book/chapter1.md`. This chapter is the foundation of the whole book, establishing the unified conceptual framework of **Agent = Model + Harness** and **context = static prefix + trajectory**.

## Introduction (5 knowledge points)

### [KP-00-01] Core formula: Agent = LLM + context + tools (three mappings)
- **Core in one sentence**: The minimal engineering formula for an Agent is just one sentence — `Agent = LLM + context + tools`, and all three are indispensable; the formula only speaks of implementation "within the Agent boundary," and does not include the environment it interacts with.
- **Key design points**:
  - Implementation layer: LLM (the decision-making core, including pretrained knowledge + post-training strategy) + context (observations / memory / domain knowledge / its own state / task progress) + tools (interfaces for perceiving or changing the external world).
  - Intuition layer: brain (LLM) + eyes (context) + hands and feet (tools); the "eyes" is a rough analogy — context also includes tool definitions.
  - RL layer: LLM ↔ Policy, context ↔ Observation Space, tools ↔ Action Space.
- **Maka design implications**: Maka's core/runtime is precisely the implementation of this formula; "Log is the Runtime" unifies the interactions of the three components into the Event Log, so that all three components of the formula can be projected from the log, rather than scattered across UI / session-private state.
- **Discussion questions**: Q1 Does the Event Log fully cover the three components of the formula (whatever part of the log is missing, recovery is missing that part of the evidence)? Q2 What constraints does "context is the representation of the environment inside the Agent, not the environment itself" place on Session/Context modeling?
- **Possible design doc**: 《Maka Core Formula: Component Mapping of LLM + Context + Tools to the Runtime Event Log》

### [KP-00-02] Practice first, naming later
- **Core in one sentence**: It's not that Anthropic invented the Skill/harness/loop engineering concepts and Agents then adopted them; rather, a great many Agents had already been doing this, and only then did the industry summarize and name them.
- **Key design points**:
  - The author's practice at Pine AI: before Skills became popular, they already used dynamically loaded prompts, command-line execution tools, and a system status bar; before harness became popular, they already used methods similar to Claude Code to solve unstable tool calls / hallucinations / dangerous operations / privilege escalation / instruction non-following; before loop engineering became popular, they already used a **proposer-reviewer** to address "the model concluding the task is done too early."
  - Knowing how to do things before the terminology exists comes down to two things: **(1) real business with extremely demanding capability ceilings**; and **(2) establishing an evaluation mechanism**.
- **Maka design implications**: Architecture decisions in the design docs should be derived from real failure modes / requirements, not from chasing new terminology. Maka's self-check/eval is the engineering implementation of "practice first, names later."
- **Discussion questions**: Q1 Does Maka record and replay "real cases that caused errors" to drive design? Q2 What does "the model concluding the task is done too early" correspond to in Maka?
- **Possible design doc**: 《Maka Design Decisions' Empirical Origins: The Derivation Chain from Real Failure Modes → Architecture Principles》

### [KP-00-03] Evaluation is the foundation of scientific methodology
- **Core in one sentence**: Without evaluation there is no progress; evaluation lets you tell whether a change is "actually better" or "just luck."
- **Maka design implications**: Any change to the Event Log schema, context pruning strategy, or self-check logic should first run regression evaluation before being merged; the Log is also an evaluation data source — real trajectories can be used directly as an evaluation set.
- **Discussion questions**: Q1 Does Maka's eval set cover Maka-specific capabilities such as "log-driven recovery correctness"? Q2 What statistical methodology is needed to distinguish "actually better vs. luck" for pruning changes?
- **Possible design doc**: 《Maka Evaluation Methodology: A Regression Evaluation Loop Using the Event Log as Data Source》

### [KP-00-04] Good design principles transcend model iteration cycles
- **Core in one sentence**: No matter how the underlying model upgrades, successful Agent systems follow the same architectural pattern — the principles describe the basic pattern of how an intelligent system interacts with the world, not the usage of a particular model.
- **Key design points**: Models ship a new generation every six months (GPT-5.2→5.5, Opus 4.5→4.8); Agentic RL trains tool calling into the parameters; "code generation + file system" has become the mainstream paradigm; Sutton's perspective: Agents can bootstrap and self-evolve by generating code.
- **Maka design implications**: Directly supports "Log is the Runtime" and "Context is not history" — they describe interaction/recording patterns independent of the model. Design docs should decouple principles from specific model capabilities.
- **Discussion questions**: Q1 Which of the four credos will be "eaten" by model capabilities? Which is an interaction pattern that never goes out of style? Q2 When models natively build in stable long-chain calls, how do Headless budgets/recovery evolve?
- **Possible design doc**: 《Model-Independence Argument for Maka Architecture Principles》

### [KP-00-05] Terminology convention: thinking vs. reasoning
- **Core in one sentence**: "reasoning" is translated as "思考" (intermediate derivation), and "inference" is translated as "推理" (forward computation and deployment), to avoid one term carrying two meanings.
- **Maka design implications**: If the Event Log records a reasoning field, its semantics should be "the thought process" (explanability / coherence evidence), to avoid ambiguity in the log schema.
- **Possible design doc**: 《Maka Message Model Terminology and reasoning Field Semantics Specification》

## Chapter 1 (10 knowledge points)

### [KP-01-01] Modern Agent = LLM + context + tools (boundary and Model–Harness structure)
- **Core in one sentence**: The formula only describes implementation within the Agent boundary; the Model is responsible for policy decisions, and the Harness is the runtime and governance layer surrounding the model within the Agent boundary (constructing context, exposing tools, maintaining loop state, enforcing permission/verification/correction).
- **Key design points**: The Harness can create/isolate/proxy an environment, yet does not contain the environment's own state and transition rules; "context is just the representation of the environment inside the Agent, not the environment itself."
- **Maka design implications**: The boundary between packages/core (sessions/events/permissions/connections) and runtime (AgentRun/context/recovery) corresponds to the "Agent boundary"; the external environment must be explicitly modeled as connections and must not be mistaken for Agent-internal state; the Event Log records only in-boundary events, while out-of-boundary changes are presented indirectly through tool-result events.
- **Possible design doc**: 《Maka Agent/Environment Boundary and Connections Modeling》

### [KP-01-02] Observation space and action space: the interface between model and world
- **Core in one sentence**: When the model is fixed, the primary systems-engineering lever for improving Agent performance is redefining/expanding the observation space and action space (i.e., expanding context and tools).
- **Key design points**: Information that doesn't enter the context through an observation channel is as if it doesn't exist to the model; operations not permitted by the action interface leave the model stuck at textual suggestions. Manus = the union of observation/action spaces along three routes; OpenClaw = local Gateway + integration with the user's digital life.
- **Maka design implications**: Expanding the observation space is not just piling up historical messages; it's systematically bringing task-required data into the context and packaging required operations as tools; the connections mechanism is the extension point for the observation/action space.
- **Possible design doc**: 《Maka Observation Space and Action Space: An Interface-Extension Capability Model》

### [KP-01-03] Tools: five types of tools + four-step tool call flow + general-purpose vs. specialized
- **Core in one sentence**: The core principle of tool design is "general-purpose basic capabilities for composition and exploration; specialized tools for constraining high-risk and strong-business-rule operations."
- **Key design points**: Five types (perception / execution / collaboration / event triggering / user communication); four-step flow (declaration → model decision → execution → result appended); tool calling = the basis of ReAct; code sandboxes need time/CPU/memory/output limits; long-horizon tasks use a controlled virtual working directory; high-risk operations are wrapped as specialized tools with explicit parameters, restricted permissions, and full auditability.
- **Maka design implications**: The five tool types are a foundational taxonomy (especially event triggering, which corresponds to TaskRun's trigger modes); the virtual working directory idea corresponds to Maka's sandbox/workspace path and capacity limits.
- **Possible design doc**: 《Maka Tool Taxonomy and Sandbox Security Baseline》

### [KP-01-04] LLM: the Agent's brain and internal thinking
- **Core in one sentence**: The LLM's unique capability is "internal thinking" — planning and deriving before acting, which does not change the external environment yet significantly improves action quality.
- **Maka design implications**: Keep reasoning as an independent message component in the Event Log (ablation proves that stripping it leads to contradictory before/after decisions); strategies for handling thinking in the three places — log/UI/pruning — need to be defined.
- **Possible design doc**: 《Maka reasoning Message Handling and Pruning Strategy》

### [KP-01-05] Context: five components + static prefix / dynamic trajectory + ablation experiment conclusions
- **Core in one sentence**: Context consists of a static prefix (system prompt + tool definitions) and a dynamic trajectory (user messages + model replies + tool results); ablation experiments show that removing any component significantly degrades performance.
- **Key design points**: Ablation conclusions — removing tool definitions → loss of action capability; missing tool results → repeatedly calling the same tool and falling into an infinite loop; stripping thinking → contradictory decisions; missing history → amnesia and redoing. A model reply contains at most three parts (reasoning/content/tool_calls).
- **Maka design implications**: All five context components are projections of the Event Log (the static prefix is configuration-type events; the dynamic trajectory is message events); any pruning must preserve closed-loop-critical components such as "tool-result feedback and recent reasoning."
- **Possible design doc**: 《Maka Context Projection: Mapping Five Components ↔ Event Log and Pruning Boundaries》

### [KP-01-06] The model is the Agent: RL internalizes the decision policy, not tool execution
- **Core in one sentence**: RL internalizes the decision policy of "when to call, which to call, what arguments to pass"; the tools themselves and their execution remain in model-external infrastructure; the orchestration loop hasn't disappeared — it just moved from the client to the server side, with decision authority given to the model.
- **Key design points**: The bitter lesson — agree on direction, be pragmatic on pace: the model will keep eating the Harness, but this "eating" is far slower than intuition suggests; the model's capability boundary right now is the Harness's value right now. Kimi K3 (2.8 trillion MoE, 100K token context, stable 200–300 long-chain tool calls); GPT-5.6 Freeform Tool Calling.
- **Maka design implications**: Even as the model keeps internalizing capabilities, the Harness's responsibilities (context management / tool interfaces / permissions / verification / recovery) increase rather than decrease; "for every layer the model internalizes, the Harness sheds a layer and pivots to holding the new frontier."
- **Possible design doc**: 《Maka and "The Model Is the Agent": Decision-Authority Handover and Harness Responsibility Reallocation》

### [KP-01-07] Learning mechanisms: three time scales
- **Core in one sentence**: Context adaptation (within-task, temporary) + external artifact updates (knowledge docs / Prompts / Skills / programs, cross-task, auditable) + parameter updates (high-dimensional capability, high deployment cost).
- **Maka design implications**: "Context is not history" becomes clearer within this framework: context adaptation changes "what the next inference sees"; artifact updates should be managed by Maka as auditable products (versioned, rollbackable).
- **Possible design doc**: 《Maka Three-Time-Scale Learning: Context Adaptation, Artifact Updates, and Log-Driven Evolution》

### [KP-01-08] The ReAct loop: think → act → observe, trajectory and loop invariants
- **Core in one sentence**: ReAct is the core mechanism that chains LLM, context, and tools together; an Agent's context = static prefix + trajectory; explicit stopping conditions must be designed (task complete / max iterations / unrecoverable error).
- **Key design points**: Multi-currency summarization example: 3 iterations, 4 tool calls; explainable and debuggable; thought-question hint: cumulative cache read volume grows roughly quadratically with the number of rounds.
- **Maka design implications**: The Event Log is precisely the persistent form of the "trajectory"; TaskRun should treat max_iterations / no-tool-call / error / task-complete as first-class termination conditions, and bring "loop-invariant detection" (repeating the same tool / stuck in a loop) into runtime monitoring.
- **Possible design doc**: 《Maka ReAct Loop and Trajectory-Projection Model on the Event Log》

### [KP-01-09] Harness engineering: Agent = Model + Harness (five elements)
- **Core in one sentence**: In the production form, `Harness = context management + tool interfaces + constraints + verification + correction`; the focus of production-grade Agents shifts to "not doing wrong things" (constraints/verification/correction), and the vast majority of Claude Code's Harness code exists to provide safeguard mechanisms.
- **Key design points**: Core principles of the five elements — context = information sufficiency; tools = clear interfaces; constraints = fail-safe defaults (deny by default, open explicitly); verification = input isolation (only look at structured data, not the model's free-form text, to prevent prompt injection); correction = do not expose intermediate state before confirming it cannot be recovered. Claude Code safeguard mechanisms: process-state management, multi-level compression, permission classification, circuit breakers, error recovery.
- **Maka design implications**: The five elements map directly to Maka's packages — runtime = context + tools, core permissions = constraints, headless Self-check/eval = verification, runtime recovery = correction; "Feedback is not fact authority" is precisely the principled expression of the Verify layer. Design docs should turn the five elements into per-package acceptance checklists.
- **Possible design doc**: 《Maka Harness Five Elements and Package-Structure Mapping (Including Constraint/Verification/Correction Log-Event Design)》

### [KP-01-10] Paradigm evolution: prompt engineering → context engineering → harness engineering → loop engineering → graph engineering
- **Core in one sentence**: When model capabilities converge, competitive advantage shifts to engineering practices outside the model; the five stages contain each other layer by layer.
- **Key design points**: LangChain went from 52.8% → 66.5% on Terminal Bench 2.0 — what changed was not the model but the Harness; graph engineering (2026) organizes loops/programs/human approvals into an explicit execution graph, nodes = capabilities, typed edges = routing, with state persisted at key boundaries.
- **Maka design implications**: The four credos are almost a synthesis of loop engineering + harness engineering; the Task Event Log is precisely "persistence at key boundaries."
- **Possible design doc**: 《Maka's Paradigm Positioning: From Harness Engineering to Loop Engineering to Checkpointable Persistence》

### [KP-01-11~13] Harness core principles / principles for building effective Agents / how to choose a model
- **KP-01-11 Five-element principles**: see KP-01-09; → 《Maka Five-Element Core Principles and Implementation Acceptance Checklist》
- **KP-01-12 Simplicity / transparency / ACI fool-proofing**: keep it simple (every layer of abstraction is a debugging blind spot); keep it transparent (show planning steps / execution logs / decision trajectories — the precondition of trust); ACI designs interfaces from the Agent's perspective and is fool-proof (Poka-yoke); "ambiguous interfaces get amplified by the model into systemic errors." → 《Maka Core Principles: Simplicity, Transparency (Log-Projection UI), and the ACI Tool Interface Specification》
- **KP-01-13 Model selection**: don't just look at leaderboards — evaluate on your own task (Chapter 6); policy boundaries (capability ≠ what the product permits calling); the vast majority of Agents need models that support thinking; output speed directly determines end-to-end latency (20 rounds × 2 seconds slower per round = 40 extra seconds of waiting); differences are large when multimodality is a hard requirement. → 《Maka Model Selection and Multi-Provider Adaptation (Including Policy Boundaries and Rate Budgets)》

### [KP-01-14] Orchestration patterns: workflows vs. autonomous Agents vs. hybrids
- **Core in one sentence**: Start with single calls → then workflows → and only finally autonomous Agents (trading latency/cost for performance, weigh carefully); autonomous Agents must design explicit stopping conditions.
- **Key design points**: Workflow = predefined code paths (strict flow control + attack surface limited to single nodes, but lacking flexibility); autonomous Agent = ReAct loop (dynamic decisions, higher risk); hybrid (n8n-style). The "simple to complex" order reduces the risk of surprises.
- **Maka design implications**: TaskRun is precisely the implementation of the autonomous Agent and must build in stopping conditions and budgets; workflow can serve as a deterministic orchestration layer mixed with autonomy.
- **Possible design doc**: 《Maka Orchestration Patterns: TaskRun Autonomous Loops, Workflow Deterministic Flows, and Hybrids》

### [KP-01-15] Guardrails and safety: layered defense, guardrail types, human intervention
- **Core in one sentence**: Guardrails form a layered defense (input / execution / output side); a single guardrail is insufficient, and only combinations of several provide resilience; also guard against **false rejections**; human intervention lets the Agent hand over control gracefully.
- **Key design points**: Input side (relevance/safety classifiers, content moderation, rule-based protections — the difference between jailbreaking vs. prompt injection); execution side (tool risk ratings: reversibility / permissions / financial impact; high-risk actions need extra review or human confirmation); output side (PII filters, output verification); Anthropic Constitutional Classifiers (rule-driven + contextual joint judgment + two-stage screening); two triggers for human intervention (exceeding failure thresholds, high-risk operations). Safety is an architecture problem — consider it from the first line of code.
- **Maka design implications**: Supports "Feedback is not fact authority" and Self-check; headless needs "failure threshold → human escalation" and "high-risk operation → human supervision"; guardrail evaluation must test both "reject what should be rejected" and "allow what should be allowed" (false rejection).
- **Possible design doc**: 《Maka Guardrail Layering and Human-Intervention Design (Including Self-Check Evidence and Bounded Repair)》

## Chapter gold quotes / core conclusions
- Agent = brain + eyes + hands and feet; expanding the eyes and hands and feet is the most important capability lever.
- Information that doesn't enter context through an observation channel is as if it doesn't exist to the model; operations not permitted by the action interface leave the model stuck at textual suggestions.
- The Harness is where competitiveness lies; the industry is shifting from "getting things done" to "getting things done reliably."
- From workflows to autonomous Agents (prompts first, then workflows, then autonomy); safety is an architecture problem.
- Practice first, naming later; without evaluation there is no progress; good design principles transcend model iteration cycles.
- Agree on direction, be pragmatic on pace: the model will keep eating the Harness, but the "eating" is far slower than intuition suggests; the model's capability boundary right now is the Harness's value right now.

## Companion experiments at a glance
- Experiment 1-1 (chapter1/context/): five-arm ablation (removing tool definitions / removing tool results / removing thinking / removing history) — "context determines what the Agent can see."
- Experiment 1-2 (web-search-agent/): Kimi K3, the model as the Agent.
- Experiment 1-3 (search-codegen/): Deep Research closed loop (reproducible with qwen3.7-plus).
- Experiments 7-1/7-2 (learning-from-experience/): Q-learning vs. LLM Agent comparison.

## Thought questions from the book (transcribed key points)
1. If you could add only one capability (a stronger model / richer context / more tools), which would you choose? Under what conditions would that change?
2. How do you reduce the quadratic growth of ReAct's cumulative cache read volume?
3. How do the two trends — "the model is the Agent" autonomization and the growing importance of the Harness — coexist?
4. Besides missing tool results, what other situations cause infinite loops? How would you design detection and termination?
5. Analyze an AI product you use regularly along the perception/action/policy three dimensions.
6. Should a flight-booking customer-service system choose a workflow or an autonomous Agent? Can they be mixed?
7. delete_file becomes high-risk under certain parameter combinations — how would you design dynamic risk assessment?
8. In what scenarios is a restricted action space actually superior to an open-ended one?
9. When the user is offline / responds slowly / gives vague instructions, how does the Agent "gracefully hand over control"?
10. Give an example of an engineering method that will become obsolete as model capabilities progress.
