# Maka Code Analysis · Architecture Design — Real Core Domain Framework (Induced from Code)

> Methodology note: this framework deliberately does **not** start from the README's four credos, nor does it treat the official ARCHITECTURE.md eight chapters as authoritative.
> It is induced entirely from measured code facts (file counts + inter-domain dependencies + official documentation coverage, cross-checked) to answer:
> "What are Maka's real core domains? Are the existing documents (README four credos, ARCHITECTURE.md eight chapters) sufficient? What is missing?"
>
> Data baseline: 2026-08-08 · source: this repository (`maka-agent`, main branch)
> Scale: core 221 files/78k lines · runtime 486 files/245k lines · headless 227 files/107k lines · storage 197 files/83k lines · runtime-host 254 files/116k lines (~700k lines of TS in total)

---

## I. Why the README Four Credos Are Not First Principles

The README's four credos are **user/market-facing outward promises**, not a complete induction of the code. Evidence:

| Code domain | File count | README four credos | ARCHITECTURE.md eight chapters | Independent architecture doc |
|---|---|---|---|---|
| tool system | 115 | Partial (hands and feet) | Implicit | Yes — draft |
| graph execution scheduling | 54 | **Not mentioned** | Yes — Chapter 7 | Yes — draft |
| permission | 47 | Not mentioned | Implicit | ⚠️ onboarding plan only |
| computer-use | 46 | Not mentioned | Not mentioned | ⚠️ 6 contract-style docs |
| connections | 42 | Not mentioned | Not mentioned | ❌ **None** |
| goal/plan | 37 | Not mentioned | Not mentioned | ❌ **None** |
| memory | 32 | Not mentioned | Not mentioned | ❌ **None** |
| skill | 31 | Not mentioned | Not mentioned | ⚠️ 1 policy doc only |
| shell/pty execution | 29 | Not mentioned | Not mentioned | ❌ **None** |
| evidence events | 30 | Yes — credo 1 | Yes — Chapters 1/2/8 | Yes — draft |
| stream | 28 | Not mentioned | Not mentioned | ⚠️ 1 transport doc |
| automation/scheduling | 19 | Not mentioned | Not mentioned | ❌ **None** |
| swarm subagents | 8 | Not mentioned | Not mentioned | ⚠️ 1 usage doc |

**Conclusion**:
1. **The four credos cover only ~4 domains (evidence / compact / recovery / self-check) — a subset of the real core domains, and already partly outdated** (the official eight chapters have evolved "Feedback is not fact authority" into "Self-Check Is Not Self-Trust" and added two domains — Graph and AHE — that the four credos never mention).
2. **The official eight chapters are also insufficient**: they cover the system spine, but **five domains — connections, goal/plan, memory, shell/pty, automation — each have 19–42 implementation files yet not a single independent architecture document**; permission (47 files, the second-largest domain) lacks architecture-level design.
3. Therefore the "real core domains" must be induced from the code, and should be **more complete than the README's four credos and more complete than the official eight chapters**.

---

## II. Real Core Domain Framework Induced from Code (draft v0)

Organized by "code topology" rather than by documentation narrative. Each domain gives: code location, scale, current state, gap.

### A. Execution Kernel Layer (how an Agent actually runs)

| Domain | Code anchors | Scale | Current state |
|---|---|---|---|
| A1 Runtime Event Log | `runtime-event-*.ts`, `canonical-runtime-event.ts`, `events.ts`, `runtime-event-store.ts`, `runtime-event-read-model.ts` | ~30 files | Has draft |
| A2 AgentRun lifecycle | `agent-run.ts` (1902 lines) | Large | Partial draft |
| A3 Model adaptation / multi-provider | `ai-sdk-backend.ts`, `openai-*`, `model-*`, `provider-*` | Large | Scattered |
| A4 Tool system | `builtin-tools.ts`, `tool-catalog.ts`, `tool-*.ts` | 115 files | Has draft |
| A5 Permission and sandbox | `permission*.ts`, `runtime-policy.ts`, `sandbox-boundary.ts` | 47 files | ⚠️ Missing architecture design |
| A6 Execution (shell/pty/file) | `shell-run*.ts`, `pty-*`, `file-*`, `edit-replace.ts` | 29+ files | ❌ No docs |

### B. Context Layer (what the model sees)

| Domain | Code anchors | Scale | Current state |
|---|---|---|---|
| B1 Context budget | `context-budget*.ts` | ~10 files | Partial |
| B2 Tool-result pruning (evidence before compaction) | `active-tool-result-prune.ts`, `tool-result-archive*.ts` | ~8 files | Yes — draft |
| B3 Compaction as projection | `ai-sdk-compaction*.ts`, `active-full-compact*.ts` | ~12 files | Yes — draft |
| B4 Status bar / context injection | `system-prompt/`, `status-*` | To verify | To verify |

### C. Persistence and Recovery Layer (a task may outlive a Turn)

| Domain | Code anchors | Scale | Current state |
|---|---|---|---|
| C1 Persistent task loop | `autonomous-agent-loop.ts`, `task-runner*` | Large | Yes — draft |
| C2 Crash recovery / resumption | `agent-run-recovery.ts`, `continuation-*.ts`, `runtime-recovery*` | ~20 files | Yes — draft |
| C3 Idempotency / side-effect recovery | `tool-recovery-*.ts`, `tool-recovery-fact.ts` | ~6 files | Partial |
| C4 Workspace / artifacts | `workspace*.ts`, `artifacts.ts` | Medium | Partial |

### D. Self-Verification and Evolution Layer

| Domain | Code anchors | Scale | Current state |
|---|---|---|---|
| D1 Self-Check | `heavy-task-self-check*.ts`, `task-self-check-evidence.ts` | ~8 files | Yes — draft |
| D2 AHE outer-loop evolution | `ahe-target-protocol.ts`, `ahe-evidence-export.ts` | Medium | Yes — draft |
| D3 Goal / planning | `goal*.ts`, `plan*.ts` | 37 files | ❌ No docs |

### E. Access and Collaboration Layer (Maka's interfaces with the world)

| Domain | Code anchors | Scale | Current state |
|---|---|---|---|
| E1 Connections | `connections.ts`, `connection-*.ts`, `web-search*.ts`, `mcp*.ts` | 42 files | ❌ No docs |
| E2 Agent Graph scheduling | `agent-graph-*.ts` (core + runtime) | 54 files | Yes — draft |
| E3 Swarm / subagents | `agent-swarm*.ts`, `child-agent-*`, `subagent-*` | ~20 files | ⚠️ Usage doc |
| E4 Computer Use | `computer-use*.ts`, `cua-*` | 46 files | ⚠️ Contract-style |
| E5 Memory | `memory*.ts`, `local-memory.ts`, `long-term-memory.ts` | 32 files | ❌ No docs |
| E6 Automation / scheduling | `automation*.ts`, `cron-expression.ts` | 19 files | ❌ No docs |
| E7 Skill | `skill*.ts`, `bundled-skill-catalog*` | 31 files | ⚠️ Policy only |
| E8 Streaming | `stream-*` | 28 files | ⚠️ 1 transport doc |

### F. Cross-Cutting Concerns

- Telemetry / usage: `telemetry/`, `usage-*`, `model-call-usage-*`
- Session / UI projection: `session*.ts`, `session-send-projection.ts`, UI read models
- Privacy / redaction: `redaction.ts`, `display-redaction.ts`, `incognito.ts`, `text-sanitize.ts`
- Sandbox / isolation boundary: `sandbox*.ts`, `runtime-boundary.ts`, `sandbox-boundary.ts`

---

## III. Conclusion: Evidence That the Existing Architecture Docs Are "Insufficient"

1. **README four credos**: cover only A1/A2/B2/B3/C1/C2/D1, and the wording is outdated (no Graph, no AHE, no connections/memory/goal/automation).
2. **ARCHITECTURE.md eight chapters**: more complete than the four credos (adds Graph and AHE), but still missing:
   - **connections (42 files)** — Maka's "eyes/access" layer, no architecture document at all
   - **goal/plan (37 files)** — no documentation
   - **memory (32 files)** — no documentation
   - **shell/pty execution (29 files)** — no documentation
   - **automation (19 files)** — no documentation
   - **permission (47 files)** — only an onboarding plan, no architecture-level permission model / sandbox design
   - **computer-use (46 files)** — 6 contract docs but no overall architecture
3. **These 6–7 "has-code-but-no-docs" domains are precisely Maka's real architecture-design gaps**, and the focus of this analysis + design work.

---

## IV. Next Steps

Per this framework, produce `domains/<Dx-domain>/*.md` domain by domain:
1. **Code map**: all implementation files of the domain + key exported symbols + dependencies
2. **Mapping to the book's key points**: how the Agent Book's corresponding knowledge points (KP-xx) manifest or are exceeded in this domain
3. **Current implementation analysis**: architecture patterns, strengths, known defects
4. **Architecture design**: target-state design, gap vs. current state, improvement suggestions

First wave prioritizes A5 (permission), E1 (connections), E5 (memory), D3 (goal), E6 (automation) — the "has-code-but-no-docs" blank domains.
