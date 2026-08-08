# Maka Design Document Material Library — Derived from *Deep Understanding of AI Agents*

> Purpose: distill the essence of the open-source book **《深入理解 AI Agent：设计原理与工程实践》(Deep Understanding of AI Agents: Design Principles and Engineering Practice)** (bojieli/ai-agent-book, Apache-2.0) into **knowledge points + design points + discussable questions + recommended design documents**, to improve Maka (a local-first AI Agent workbench)'s documentation and design document system.
>
> Extraction method: parallel extraction via agent_swarm (11 read-only workers each read the book chapter by chapter, page by page through the full text), then organized into directly reusable material in this directory.
>
> Data date: 2026-08-08 · Source book: [bojieli/ai-agent-book](https://github.com/bojieli/ai-agent-book) (Apache-2.0, main branch)

---

## Table of Contents

| File | Contents |
|---|---|
| `agent-book-knowledge/` | Per-chapter knowledge points (11 files; each knowledge point contains: core / design points / Maka implications / discussable questions / recommended design documents, plus the chapter's key quotes, companion experiments, and thought questions). Serves as the argument bank for design documents |
| `01-Maka-Design-Question-Checklist.md` | **Essence version**: only the 68 core design questions related to the Agent Harness itself, organized by Maka's four credos, ready to use directly for review and requirements clarification |
| `02-Maka-Design-Doc-Roadmap.md` | **Essence version**: only the core Harness design documents (64 documents), with P0/P1/P2 priorities and execution order |
| `README.md` | This index + the book's overall structure + mapping to Maka's four credos |

---

## The Book's Overall Structure (10 chapters + Introduction + Afterword)

**Core formula: Agent = LLM + Context + Tools** (brain + eyes + hands; Policy + Observation Space + Action Space).

The book's four-layer structure:
1. **Building** (Chapters 1–5): fundamentals → context engineering → memory and knowledge bases → tools → Coding Agent / code generation
2. **Evaluation and evolution** (Chapters 6–8): evaluation → model post-training → continuous evolution
3. **Interaction and collaboration** (Chapters 9–10): multimodality and real-time interaction → multi-Agent collaboration
4. **Afterword**: two clouds on the horizon (real-time streaming interaction, continuously accumulating experience from success and failure) + the co-evolution of models and Agents

---

## Maka's Four Credos ←→ Mapping to the Book's Core Principles (can be written directly into the introduction of Maka design documents)

| Maka Credo | Corresponding Principle in the Book | Strongest Supporting Chapters |
|---|---|---|
| **Log is the Runtime** (model messages/tool calls/results/termination facts go into the log; sessions/UI/context/recovery are all projections of the log) | The ReAct loop's "trajectory", the event stream of event-driven architecture, WAL + checkpoints, replayable trajectory logs | Chapters 1, 2, 4, 6, 7, 10 |
| **Context is not history** (pruning/Compaction changes "what the next inference sees" without discarding already-recorded evidence) | Static prefix + trajectory; compression is "turning conclusions that need to be reasoned over into retrievable knowledge"; "keep recorded evidence, only change the projection"; isolation beats compression | Chapters 2, 3, 5, 8 |
| **A task may outlive a Turn** (TaskRun/budget/continuation support persistent tasks) | The event loop resumes at safe points, the five rules for asynchronous interruption, fast/slow decoupling, WAL + idempotent-key recovery | Chapters 4, 9, 10 |
| **Feedback is not fact authority** (self-check produces evidence plus one bounded repair opportunity, without automatically becoming system fact) | "A model can propose 'done', but cannot approve its own 'done'"; commitment–action consistency; RLVP "reward the outcome, constrain the process"; world model "prediction ≠ fact"; a Byzantine-failure perspective | Chapters 1, 5, 6, 7, 8, 9, 10 |

---

## Three Questions as Anchor (from the Afterword; timeless)

**What does it see, what can it do, and how do we verify whether it did it right** — these three questions describe the fundamental way an intelligent system interacts with the world, not the usage of any particular model. Maka's four credos are precisely the engineering answer to these three questions; design documents should anchor the credos back to these three questions so they don't go out of date as specific model APIs come and go.

---

## How to Use This Material Library

1. **Writing a design document** → find the questions for the corresponding credo/domain in `01-Maka-Design-Question-Checklist.md` for requirements clarification; look up knowledge points in the corresponding chapter under `agent-book-knowledge/` for arguments (each knowledge point carries "Maka design implications" and "recommended design document" suggestions).
2. **Doing a design review** → directly use `01-Maka-Design-Question-Checklist.md` (68 questions) as the review checklist.
3. **Planning the next batch of design documents** → look at `02-Maka-Design-Doc-Roadmap.md`, pick topics in P0/P1/P2 order.
4. **Validating Maka's existing designs** (Runtime Event Log, Tool Result pruning, LLM Compaction, Self-check, budget/continuation, eval) → cross-check against each chapter's "Maka design implications" to see whether the book's principles are covered.

> Note: `01` and `02` have been converged to the core of the Agent Harness; `agent-book-knowledge/` retains the book's full set of knowledge points for on-demand reference (including memory/knowledge bases, multimodality, post-training, and other content off the main Harness track).
