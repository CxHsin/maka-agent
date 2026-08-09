# Permission Domain · Maka Code Analysis and Architecture Design

## 1. Code Map

### `@maka/core` — platform-neutral "permission language" and decision payloads

| File | Responsibility |
|---|---|
| `packages/core/src/permission.ts` | Legacy permission payloads + tool classification. `PermissionMode` (`explore/ask/execute/bypass`), `ToolCategory` (14 categories), **`categorizeBash()` command classification**, three request payloads `PermissionRequest / AdditionalPermissionRequest / SandboxEscalationRequest`, `PermissionResponse` |
| `packages/core/src/permission-profile.ts` | **Platform-neutral permission profile**: `FileSystemSandboxPolicy` (restricted/unrestricted/external_sandbox), special paths `:workspace_roots/:tmpdir/:slash_tmp/:root/:minimal`, protected metadata `deny_write` (`.git/.agents/.codex`), `NetworkSandboxPolicy`, standard profile factories, pure-function path matching `canReadPath/canWritePath/isDeniedPath` |
| `packages/core/src/permission-profile-compiler.ts` | Legacy mode → profile compilation (`explore→read-only`, `ask/execute→workspace-write`, `bypass→danger-full-access`) |
| `packages/core/src/sandbox-boundary.ts` | **Execution-boundary authority**: `ExecutionBoundary` (managed/bypass/external + revision), `SandboxBoundaryRequest` (pending/approved/denied/conflict), **boundary expansion** `SandboxBoundaryExpansion`, containment/conflict assessment `assessSandboxBoundaryExpansion`, `executionBoundaryDisplayMode` (#1611) |
| `packages/core/src/runtime-boundary.ts` | Runtime-event prefix **sha256 digest chain**: `ImmutableRuntimePrefix → RuntimeBoundaryCursor → ContinuationClaim`, the trusted boundary for crash recovery |
| `packages/core/src/additional-permissions.ts` | Additional permission-profile validation (≤32 entries, ≤4096 chars, 64KB serialization cap) |
| `packages/core/src/interaction-permission-review.ts` | Permission request → UI-safe projection: bounded strings, `redactSecrets`, strict shape validation, `assertToolSemantics` (tool name / category / reason / review shape must be self-consistent) |
| `packages/core/src/interaction.ts` | `InteractionRequest` (permission/question/sandbox_boundary), decision-outcome validation, `rememberForTurn` legitimacy |
| `packages/core/src/runtime-event.ts` / `events.ts` | `RuntimeEvent.actions.permissionRequest/permissionDecision`; `PermissionRequestEvent / AdditionalPermissionRequestEvent / SandboxEscalationRequestEvent / SandboxBoundaryRequestEvent / PermissionDecisionAckEvent / PermissionAnswerAckEvent` |
| `packages/core/src/tool-args-identity.ts` | `canonicalToolArgsHash/stableJsonStringify`: **tool-call argument identity** (strict JSON normalization, `__proto__`-collision safe) |
| `packages/core/src/tool-recovery-fact.ts` | Tool side-effect reconciliation facts (reconcile → completed/parked) |
| `packages/core/src/execution-evidence.ts` | Cross-ledger evidence references `ExecutionEvidenceRef` |
| `packages/core/src/runtime-policy.ts` | Runtime policy, default `chatDefaults.permissionMode: 'ask'` |

### `@maka/runtime` — platform sandbox and execution authority

| File | Responsibility |
|---|---|
| `packages/runtime/src/sandbox/README.md` | Boundary responsibility split ("core defines the boundary language, runtime performs platform transformations"; enforcement gap in issue #843) |
| `sandbox/types.ts` | `SandboxType` (none/macos-seatbelt/linux), `SandboxablePreference` (auto/require/forbid), typed failures |
| `sandbox/sandbox-manager.ts` | Selection/transformation decisions; `profileRequiresSandbox` (restricted ⇒ sandbox mandatory); **fail-closed** `backend_not_available / unsupported_platform` |
| `sandbox/macos-seatbelt.ts` | `/usr/bin/sandbox-exec` + SBPL policy (`(deny default)`), parameterized root, protected-metadata deny-write regexes, `(allow network*)`/`(deny network*)` |
| `sandbox/default-sandbox-manager.ts` / `detect.ts` / `diagnostics.ts` / `errors.ts` | Default backend registration, sandbox-denial detection, diagnostics, `SandboxCommandError` (typed, `recoverable`, `requiredExpansion`) |
| `sandbox/linux-sandbox.ts` / `linux-capability.ts` / `linux-profile-path.ts` | bubblewrap plan (currently `backend_not_implemented`) |
| `filesystem-executor.ts` | **Sole authority for file tools**: boundary → backend selection (managed→sandboxed worker / bypass→host / external→injected executor), `pathScopeForBoundary` |
| `path-containment.ts` | `isPathInside/realpathAllowMissing/contained` I/O (symlink-escape protection, dangling links ≤32 hops) |
| `sandbox-boundary-declaration.ts` / `-path.ts` / `-tool.ts` | `request_sandbox_boundary` tool + normalization + pre-check (conflict→deny; expansion needed→`sandbox_boundary_required`) |
| `tool-availability.ts` / `tool-runtime.ts` | Tool gating `ToolGating`, `categoryHint`, `LOOP_GATE_IDENTICAL_THRESHOLD=3`, `DEFAULT_PERMISSION_TIMEOUT_MS=300_000`, client_capability only under bypass |
| `interaction-authority.ts` | Interaction-request admission/authority (closed errors, capacity denial) |
| `plan-mode.ts` | Collaboration mode keeps only read/web_read tools per `classifyToolUse` |
| `runtime-event-read-model.ts` | Permission request/decision → session-message projection |
| `skills-context.ts` | "Skill content cannot grant tool access, weaken permission prompts…" |

### Docs
- `docs/permission-onboarding-plan.md` — the only permission doc (macOS system-level drag-and-drop authorization for Accessibility/Screen Recording); it is **system-permission** onboarding, a different layer from the tool-level permission model.

---

## 2. Core Data Model and Flows

### Permission model: two-layer declaration, fail-closed overall
1. **Outer layer — PermissionProfile (structured, pure data)**: file-system access (`entries` + `special` placeholders + `protectedMetadata` deny-write) + network policy (restricted/enabled). `permission-profile.ts` explicitly comments that `isReadOnlyPermissionProfile` is **derived from policy** rather than from `name` (#1611), so "read-only" is a fact, not a label.
2. **Inner layer — ToolCategory classification**: `classifyToolUse/categorizeBash` (`permission.ts`). Key design decision (file comment): **there is no `shell_safe`** — "a shell command cannot be proven safe from its string" (statically determining shell side effects is undecidable), therefore **every shell command is at least `shell_unsafe` → prompts**. Classification only makes the confirmation reason more accurate (delete vs elevate vs generic); a missed match is a wording issue, never a bypass.

### Default allow / deny
- Default **deny/prompt**: `createDefaultRuntimePolicy` has `chatDefaults.permissionMode: 'ask'`; within `PolicyDecision = allow|prompt|block` almost no tool is allowed.
- `bypass` = `danger-full-access` (unrestricted FS + enabled network + no local sandbox); the `forbid` preference is internal orchestration input "not proof of approval" (sandbox/README.md, boundary section).

### Tool-level / parameter-level
- **Tool level**: built-in tool table `BUILTIN_TOOL_CATEGORY` (Read/Glob/Grep→read, Write/Edit→file_write, Bash→shell_unsafe…).
- **Parameter level**: `categorizeBash` runs **segmentation + normalization + nested-shell recursion** over the command string (`commandSegments`, `normalizeSegmentHead`, `scanSegments(cmd, depth=2)`, double backtick scan), recognizing privileged / fs_destructive / git_destructive / shell_unsafe; paths are landed threefold via the `permission-profile` matcher + `path-containment` + sandbox worker.
- `tool-args-identity.ts` provides the **argument-identity hash** (strict JSON, `__proto__`-safe, `undefined`/bigint/non-finite-number safe) — a key primitive for audit and (future) parameter-level decisions.

### Sandbox-boundary implementation
- macOS: `sandbox-exec` + Seatbelt SBPL, `(deny default)` + platform defaults + profile root parameterization (`-DREADABLE_ROOT_i/WRITABLE_ROOT_i`) + protected-metadata `require-not` regexes + `(deny network*)`. **Process-level isolation, not a container.**
- Linux: bubblewrap backend registered but `backend_not_implemented` (fail-closed: `unsupported_platform`).
- Network isolation: only a binary network policy (restricted→`deny network*` / enabled→`allow network*`), **no domain/port-level network sandbox** (the README explicitly lists it as a non-goal).
- File execution: `filesystem-executor.ts` is the "single authority" — `managed`→sandboxed worker, `bypass`→host, `external`→injected executor; tools carry no policy branches of their own (#2083 fix: bypass is no longer implicitly constrained by workspace rules).

### How permission decisions enter the log (evidence)
- Request: `permission_request` RuntimeEvent (`permissionRequest` payload).
- Decision: the canonical decision is persisted in the **InteractionStore** (`InteractionCanonicalPermissionOutcome`, with `reviewer: 'user'|'auto_review'`, `committedAt`, optional `rationale`); the runtime acknowledges with **identity-only** `PermissionAnswerAckEvent`/`permissionAnswerAccepted` events, avoiding duplication/tampering.
- The sha256 prefix chain in `runtime-boundary.ts` pins the entire event ledger; `runtime-event-backfill.ts` can backfill `permissionDecision` from tool-call events during recovery.
- `session-trace-projection.ts` / `runtime-event-read-model.ts` project `permissionDecision` into `permission_decision` messages (with `rememberForTurn`, `riskLevel`).

### Relationship with "Feedback is not fact authority"
- **Permission adjudication is independent of the model**: `reviewer` has only two classes, `user` and `auto_review`; `interaction.ts:272` enforces that **only auto_review outcomes may carry a rationale** — "a model can say, it cannot approve itself". The runtime currently does **not** wire `auto_review`/`approval_routed` into a real feature (only declared in the type tables of `agent-run.ts`/`run-trace.ts`).
- `categorizeBash` refuses to let a classifier become a security-boundary authority (undecidable → always prompt).
- Sandbox execution is enforced at the OS layer (Seatbelt); the model/classifier cannot bypass it.
- The reconciliation facts in `tool-recovery-fact.ts` come from **a digest of real state** (`observationDigest`), not from the model's self-report.
- The current running environment is an instance of this model: `Profile: read-only` → `File system: read-only, Network: restricted, Command sandbox: macos-seatbelt selected` — the profile compiles directly into a Seatbelt policy.

---

## 3. Mapping to the Book's Key Points (Harness five elements)

| Book key point | Maka manifestation | Beyond / Missing |
|---|---|---|
| **Constraints = fail-safe defaults** | Default `ask`; no `shell_safe`; `(deny default)` sandbox; no automatic unsandboxed retry; `pathScopeForBoundary` keeps workspace scope when a boundary is missing; `backend_not_implemented` fails rather than degrading | **Beyond**: `ExecutionBoundary` revision is monotonic + expansion requires atomic approval settlement; `isReadOnlyPermissionProfile` is derived from policy (anti label-spoofing) |
| **Execution-tool security hierarchy** | Tool classification (read-only, no prompt) → command/argument classification (`categorizeBash` segment scan) → path-level matching (profile + containment) → OS sandbox as backstop | **Beyond**: multiple layers of depth, each independently fail-closed; **Missing**: no command-level allowlist (intentional; the comments argue undecidability) |
| **Sidecar read-only structured input** | `interaction-permission-review.ts` projects raw args into a **bounded, redacted, strictly-shape-validated** structured review (`sanitizeText`/`redactSecrets`/byte budgets/`assertToolSemantics` semantic self-consistency assertions); the UI never sees raw arguments | **Beyond**: the projection also runs "tool identity ↔ category ↔ reason ↔ review shape" consistency checks, eliminating projection drift |
| **Data-layer trust boundary** | `protectedMetadata deny_write` (.git/.agents/.codex); skill/workspace-instructions explicitly "cannot grant tool access" (`skills-context.ts`, `skills-metadata.ts` "does not trust metadata as permission"); sandbox backend refuses when `canEnforceProfile` fails | **Beyond**: boundary containment/conflict algorithms (`sandboxProfileContains`, deny precedence, protected-metadata weakening detection) |

**Main gaps**:
1. **No container/namespace-level isolation** — Seatbelt is process-level filtering under the same uid, not kernel isolation; the Linux side is entirely unimplemented.
2. **Network sandbox is only an on/off switch** — `(allow network*)` is all-open or all-closed, no domain/port granularity.
3. **auto_review is an unimplemented design surface** — if implemented carelessly it would directly violate "Feedback is not fact authority".

---

## 4. Current Implementation Analysis

### Strengths
- **Fail-closed is enforced extremely thoroughly**: the classifier never grants shell passage, unavailable backends are refused, missing boundaries collapse to the narrowest scope — "constraints = fail-safe defaults" is an architecture principle, not a slogan.
- **Boundary decoupled from mode** (#1611): `ExecutionBoundary` is the runtime's sole authority; display, expansion, and read-only determination are all derived from the boundary, eliminating "stale stored mode" drift.
- **Audit-friendly**: `requestId` threads through `PermissionRequestEvent` → Interaction outcome → `permissionAnswerAccepted` → `permission_decision` message; combined with the runtime-boundary sha256 prefix chain and argument-identity hashing, "who approved which arguments, when, and why" can be fully reconstructed.
- **Solid input-surface defense**: every field of the permission prompt has a byte cap + redaction + strict shape + semantic self-consistency assertion — textbook "normalize untrusted input before it reaches the UI".
- **Permission adjudication does not trust the model**: the decision-maker is the user (or constrained auto_review); the event ledger and OS sandbox are the final authorities.

### Deficiencies / Risks
1. **Over-authorization surface**:
   - `rememberForTurn` remembers by `toolName+category` (`interactionRememberForTurnIsEligible`), **not bound to argument identity** — within the same turn, different dangerous arguments of the same tool can be covered by a single approval (`canonicalToolArgsHash` exists but is not used for the decision cache).
   - MCP tools default to `network_send` (`mcp-tools.ts:77`), prompting every time yet also producing large volumes of "indiscriminate prompts" → user prompt fatigue.
   - `custom_tool` falls back to `custom_tool` without a category prompt, and `client_capability` can only run under bypass (`tool-runtime.ts` CLIENT_CAPABILITY_BOUNDARY_MESSAGE) — the open-ended capability surface lacks a parameter-level allowlist.
2. **Silent allow**: the `bypass` boundary = host execution + fully open; the `forbid` preference "is internal orchestration input, not proof of approval" (the README admits this); the `external` boundary trusts the external environment to supply isolation and **does not layer a local sandbox on top** (explicit in the README).
3. **Auditability gap**: the canonical decision lives in the InteractionStore while the runtime event stores only an identity ack; the two records are linked by `requestId` but **there is no reconciliation check**; the `permissionDecision` event contains no argument summary (the balance between secrecy and audit leans toward secrecy).
4. **Usability vs security**: on Linux, managed restricted directly hits `backend_not_implemented` (fail-closed is correct but effectively unusable).
5. **Seatbelt policy maintenance risk**: `macos-seatbelt.ts` embeds ~700 lines of platform-default policy — "fighting deny-default with a blanket allow"; new system components (mach/extension) can be broken by mistake or require continuous patching.

---

## 5. Target Architecture

**Goal: evolve the permission domain from "scattered classifiers + prompt flows" into a three-layer structure of "declarative capability authorization + auditable decision ledger + OS-enforced backstop."**

1. **Unified decision ledger (PermissionDecisionJournal)**: every decision lands as a structured event (`requestId + toolName + canonicalToolArgsHash + category + decision + reviewer + riskLevel + rationale + boundaryRevision`), **with dual-write reconciliation against the InteractionStore** (reusing `execution-evidence.ts` cross-ledger references and the `runtime-boundary` prefix chain). Goal: any grant can be "reverse-audited".
2. **Parameter-level decision cache**: bind `rememberForTurn`/"remember for this session" to `canonicalToolArgsHash` rather than only `tool+category`; add an "allow/deny same argument shape" cache layer, reducing prompt fatigue while preventing argument-level over-authorization.
3. **Declarative capability list replaces bare categories**: a `PolicyRule` over the triple `ToolCategory × path/URL/command shape × tool identity`; built-in tools and MCP/custom tools all go through the rule table; MCP tools get `urlScheme/host`-granularity network rules instead of blanket `network_send`.
4. **Linux sandbox landing or explicit degradation declaration**: bubblewrap + seccomp (`linux-capability.ts` already probes capabilities), or officially declare `unsupported_platform` with a prominent session-header notice — eliminating the implicit "runs but has no sandbox" state.
5. **auto_review formalized (guarding Feedback is not fact authority)**: only `low`-risk `read`/`web_read` decisions may be auto-approved by a separate review model, forcing `reviewer='auto_review' + rationale + review-model version`; **never self-approval** (tool call and reviewer separated); the user can one-click reject and roll back granted items.
6. **Permission policy versioning**: extend `ExecutionBoundary.revision` into a "policy-family version" (profile structure version + classifier version + sandbox backend version), included in `SandboxError`/`runtime-boundary` digests, so replaying old events makes the "permission semantics of the time" explicit.
7. **Explicit audit-vs-privacy balance policy**: generic tool arguments go through a three-state "summary + redaction + hash retention" (`summarizeGenericToolArguments` already exists as a prototype); the audit surface uses hash + summary rather than plaintext.

---

## 6. Open Questions

1. **Prompt fatigue vs default-allow**: should a session-level deny/allow learning be introduced? If so, should deny persistence also be argument-level bound, and can it be overridden by skill content (currently explicitly "cannot")?
2. **auto_review's trust boundary**: when the review model and the main model are from the same provider, how does "independence" hold? Should a different provider be mandatory?
3. **Governance of the bypass boundary**: should `danger-full-access` require a second confirmation / cooling-off period / session-level audit highlighting?
4. **Network-sandbox granularity**: between `deny network*` and `allow network*`, is an intermediate "proxy allowlist" state needed (`runtime-policy` already has network-proxy configuration, which could be reused)?
5. **Linux priority**: is `backend_not_implemented` an acceptable product state or a release blocker?
6. **Permission × collaboration-mode stacking**: `plan-mode.ts` filters to read-only tools by category; does it semantically overlap/drift with the `explore` profile? Which takes precedence?
7. **Protected-metadata scope**: `PROTECTED_METADATA_NAMES = ['.git','.agents','.codex']` is a fixed enum; should users be able to extend it (e.g. `.env`)?

---

*Note: all references above come from `packages/co…` (source files in this repository; verified 2026-08-08).*
