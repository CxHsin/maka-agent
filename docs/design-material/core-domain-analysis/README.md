# Maka Real Core Domain Analysis — Induced from Code

> Purpose: this directory is the **bottom-up complement** to the rest of the design-material library. The other files here are distilled **top-down from the book** *《深入理解 AI Agent》(Deep Understanding of AI Agents)*; this directory is **induced from Maka's actual code** (file counts + cross-domain dependencies + official documentation coverage) to answer: *"What are Maka's real core domains? Are the existing docs (README four credos, ARCHITECTURE.md eight chapters) enough? What is missing?"*
>
> Methodology: **not** starting from the README four credos, **not** treating the official ARCHITECTURE.md eight chapters as authoritative. The framework and every domain analysis are derived from measured code facts on the `maka-agent` repository (main branch, 2026-08-08; ~700k lines of TS across core/runtime/headless/storage/runtime-host).
>
> Domain analyses follow a unified six-section structure: **1. Code Map → 2. Core Data Model and Flows → 3. Mapping to the Book's Key Points → 4. Current Implementation Analysis → 5. Target Architecture → 6. Open Questions**. Each file is bilingual (`*.md` = English, `*.zh-CN.md` = Chinese).
>
> Relationship to the four credos / official chapters: these analyses are **more complete** than both. The README four credos cover only ~4 domains (evidence/compact/recovery/self-check); the official eight chapters cover the system spine but still miss the "has-code-but-no-docs" blank domains that are the focus here.

---

## Table of Contents

| File | Domain | Scale | Doc status before this analysis |
|---|---|---|---|
| `00-real-core-domain-framework.md` | **Framework**: which domains Maka really has, induced from code; proof that the four credos and eight chapters are incomplete | — | — |
| `A5-permission.md` | Permission & sandbox (permission profiles, execution boundary, decision ledger) | 47 files | ⚠️ onboarding plan only |
| `A6-shell-pty.md` | Shell/PTY execution (7-state state machine, headless xterm, process-tree termination) | 29+ files | ❌ none |
| `D3-goal-plan.md` | Goal/Plan (autonomous long-horizon Goal loop with external judge; controlled Plan workflow) | 37 files | ❌ none |
| `E1-connections.md` | Connections (LLM provider catalog, credential vault, bounded network effects, MCP/WebSearch) | 42 files | ❌ none |
| `E3-swarm.md` | Swarm / subagents (Swarm Mode = Agent Graph presentation policy + authorization) | ~20 files | ⚠️ usage doc |
| `E4-computer-use.md` | Computer Use (AX semantic tree, frame/epoch grounding, presentation fence) | 46 files | ⚠️ contract-style |
| `E5-memory.md` | Memory (MEMORY.md local + long-term item store, evidence projection) | 32 files | ❌ none |
| `E6-automation.md` | Automation / scheduling (durable cron + heartbeat scheduler, safe-point firing) | 19 files | ❌ none |
| `E7-skill.md` | Skill (SKILL.md catalog, progressive disclosure, trust framework) | 31 files | ⚠️ policy only |

---

## How to Use

1. **Entering a domain for the first time** → read that domain's Code Map (§1) for the file inventory, key exported symbols, and layer boundaries.
2. **Auditing an existing design** → read Mapping to the Book's Key Points (§3) to see where Maka already exceeds the book's principles and where it lags.
3. **Planning changes** → read Current Implementation Analysis (§4) and Target Architecture (§5); the Deficiencies/Risks and Open Questions (§6) double as a review checklist.
4. **Cross-referencing** → the framework (`00`) maps each domain to the four credos / official chapters; the `agent-book-knowledge/` directory holds the per-chapter knowledge-point argument bank.

> Scope note: A1–A4, B1–B4, C1–C4, D1–D2, E2, E8 and the cross-cutting concerns in the framework already have official drafts (Runtime Event Log, context pruning/compaction, recovery/resume, self-check, agent graph, streaming) and are therefore listed in the framework but **not** re-analyzed as separate domain files here. The nine domain files cover precisely the "has-code-but-no-docs" gaps.
