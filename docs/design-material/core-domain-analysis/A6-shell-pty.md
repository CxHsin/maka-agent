# Shell/PTY Domain · Maka Code Analysis and Architecture Design

## 1. Code Map

**Core contract layer (`packages/core/src`, browser-safe, no node:* dependencies)**
- `shell-run.ts` — domain core. `ShellRunRecord`/`ShellRunPatch`/`ShellRunStatus` (7-state state machine: `starting→running→(completed|failed|timed_out|cancelled|orphaned)`), `ShellOutput` (pipes|pty discriminated union), `ShellRunStore` interface, invariant validation (`isValidShellRunState`, `nextShellRunRecord` monotonic revision, terminal states immutable, `sandboxExecution`/`sandboxEscalation` structural constraints).
- `shell-run-result.ts` — tool-result contract and the **state-merge engine**: `mergeShellRunState` (revision arbitration, `ref_mismatch`/`same_revision_conflict` invariant diagnostics), `ShellRunUpdateBuffer` (256-entry bounded buffer during hydration), legacy result normalization (`terminal`→`shell_run`, compatible with 3 generations of historical shapes).
- `events.ts` — tool-result and update event types (`ShellRunUpdate`/`ShellRunSnapshotResult`/`SandboxDenialSignal`/`SandboxDenialRecovery`).

**Execution and lifecycle layer (`packages/runtime/src`)**
- `shell-run-contract.ts` — manager I/O contract and constants (`DEFAULT_BASH_TIMEOUT_MS=120s`, `MAX_FOREGROUND_BASH_TIMEOUT_MS=10min`, `MAX_SHELL_RUN_TIMEOUT_MS=24h`, PTY size/input 64KB cap, `maxLiveShellRuns=64`/`maxLivePtyRuns=8`, resource-ref resolution `maka://runtime/background-tasks/<id>`).
- `shell-run-manager.ts` (74KB, domain heart) — `ShellRunProcessManager` implementing `RuntimeResourceReader/BackgroundTaskStopper/PtyControlWriter`: dual-mode launch (pipes/pty), timed flush persistence, termination lifecycle (SIGTERM→SIGKILL escalation + process tree), slot reservation, orphan recovery, session-close lease/epoch.
- `shell-exec.ts` — **single shared execution kernel** (self-described "dumb core"): `runShellWithBoundedTail` memory-bounded tail streaming execution, unifying the built-in Bash and the Harbor/headless executor paths; fixes three old bugs in `execAsync({maxBuffer})` — killing the process on overflow, keeping only the head, and distorted exit codes.
- `shell-detect.ts` — platform shell detection (posix/pwsh/powershell/cmd), `buildShellSpawnPlan`/`buildPtyShellSpawnPlan` (PowerShell explicit spawn + `$LASTEXITCODE` rethrow tail), `bashToolShellGuidance` (dialect guidance telling the model "the choice must be declared").
- `shell-tools.ts` — the three tools Bash/StopBackgroundTask/WriteStdin: `buildManagedBashTool` (foreground/background/pty three states + `required_boundary` pre-check), `buildLocalForegroundBashTool`, `shapeTerminalResult` (secret redaction + truncation + sandboxDenial signal).
- `shell-run-tool-result.ts` — record → model-visible result projection: `terminalContent`/`shellRunContent`/`compactShellRunContent`, PTY 50KB text budget with priority truncation (screen→alternate→scrollback), sandbox-denial detection.
- `pty-process-driver.ts` / `pty-stack.ts` — thin node-pty wrappers (xterm-256color, flowControl off, exit fence invariant) and dynamic loading/validation (`spawn`+`@xterm/headless`+`unicode11`).
- `pty-screen-collector.ts` — **headless xterm terminal emulator**: bounded parse queue (1MB high-water mark, evicts oldest rather than pausing the source), OSC safety boundary (intercepts 0/1/2/7/8/9/52/777), alternate-buffer capture, 500-line scrollback, whole-line secret redaction, RIS reset on input gaps.
- Supporting: `bash-tail-buffer.ts` (line-boundary-safe tail), `pipe-*-driver/collector`, `process-tree-terminator.ts` (POSIX setsid group + ps-snapshot hunting of escaped descendants / Windows `taskkill /T`), `tool-output.ts` (50KB/2000-line head/tail truncation + recovery hint), `bash-model-output.ts`.

**Persistence and authority layer**
- `packages/storage/src/shell-run-store.ts` — SQLite `core_shell_runs` (single-row `record_json` storage, applying `nextShellRunRecord` inside the transaction).
- `packages/storage/src/shell-run-authority.ts` — writable writer facade gated by the `StorageRootLease` lease (`structuredClone` + brand symbol), separating "read model" from "lease-holding writer".
- `packages/headless/src/task-shell-run-store.ts` — per-task in-memory store (benchmark path).

**Permission and sandbox**
- `packages/core/src/permission.ts` — `categorizeBash`: **never returns shell_safe** ("determining the runtime effect of a Turing-complete shell from a static string is undecidable"), only escalates to `shell_unsafe`/`privileged`/`fs_destructive`/`git` to make the confirmation reason more precise.
- `packages/runtime/src/sandbox/{macos-seatbelt,linux-sandbox,types,detect,sandbox-manager}.ts` — Seatbelt `/usr/bin/sandbox-exec` policy generation, `SandboxTransform` (argv rewriting), `isLikelySandboxDenial`.
- `builtin-tools.ts:669 sandboxCommand()` — transforms the permission profile + `required_boundary` into sandboxed execution argv; `sandbox-boundary-declaration.ts` — `preflightDeclaredSandboxBoundary` (noop/conflict/recoverable three states).

**UI (`packages/ui/src`)**
- `tool-activity/*`, `materialize.ts`, `live-turn-projection.ts` — shell_run result panels, WriteStdin operation metadata projection, merge of live chunks with durable results. Note: **`pty-output-view.ts` does not exist**; `shell-controls-copy.ts` is actually the i18n copy for the **app shell (navigation/search)** under `packages/ui`, unrelated to the command-execution domain — a naming collision.

## 2. Core Data Model and Flows

**ShellRun lifecycle (7-state state machine)**
`starting` (store persisted first, `revision=1`) → `running` (set after successful spawn) → terminal states:
- `completed` (exit 0) / `failed` (exit≠0 or failureMessage) / `timed_out` (forced exit 124) / `cancelled` (abort/stop/shutdown, exit 130) / `orphaned` (read as active after restart but no live handle).

State-machine invariants are centralized in `core/shell-run.ts` (`isValidShellRunState` + `isValidShellRunStatusTransition` + `nextShellRunRecord` monotonic revision + terminal states immutable), with a comment stating: "make the second store just a storage-medium swap, not a second copy of the state machine."

**Layering: authority → hydration → store**
1. **Store layer**: the `ShellRunStore` interface (create/update/read/list); the SQLite implementation does atomic single-row JSON updates; headless has an in-memory implementation.
2. **Authority layer**: `shell-run-authority.ts` uses `StorageRootLease` to limit "who can write", with brand symbols against forged writers; the validation functions in `shell-run.ts` are the "storage-independent invariant authority".
3. **Hydration/observation layer**: `ShellRunUpdate` events + `ShellRunUpdateBuffer` (256 bounded, merged/deduped during hydration) + `mergeShellRunState` (revision arbitration; violating an invariant emits a diagnostic rather than overwriting); on the UI side `materialize.ts` folds a background Bash's sub-tools (Read/StopBackgroundTask/WriteStdin) back into the parent shell_run (`shell-run-projection.test.ts`).

**Dual execution modes**
- **pipes**: `PipeProcessDriver` (detached setsid) + `PipeTailCollector` (BashTailBuffer 1MB/stream) + timed flush (1s/64KB threshold).
- **pty**: `PtyProcessDriver` + `PtyScreenCollector` (headless xterm); snapshots are serialized at "parser cut" points (`mutateAtCut` queue); WriteStdin/resize/stop all go through the cut, achieving an atomic "input→snapshot→persist" chain; raw bytes are throttled to the UI for live replay at 16ms/32KB (`ShellRunPtyDataEvent`).

**Cooperation with permission/sandbox**
- Tool surface: Bash is `activityKind:'command'`; permission defaults to `shell_unsafe`→confirmation, never downgraded.
- Sandbox surface: `sandboxCommand()` transforms the profile of `ctx.executionBoundary` into injected Seatbelt/linux argv (`transformCommand`); the command runs inside the sandbox; on the result side `sandboxDenial: {likely, backend}` is recognized by `isLikelySandboxDenial` and returned with the result; escalations are audit-logged (`sandboxEscalation{commandHash, unsandboxed}`).
- Pre-check: `required_boundary` is evaluated via `preflightDeclaredSandboxBoundary`; conflict→`requires_bypass` denial, recoverable→prompt to request boundary expansion.
- **PTY exception**: when `profileRequiresSandbox`, PTY is directly disabled (`pty_sandbox_unavailable`/`requires_bypass`) because node-pty cannot be wrapped in Seatbelt — interactive mode is never sandboxed.

**Relationship to the Bash tool**: one `Bash` name, three implementations (local built-in, managed manager, executor/harbor), sharing the `shell-exec.ts` kernel and `shell-detect.ts` dialect selection; "declared selection" (tool description injects the shell dialect + session-environment snippet) prevents Windows dialect guessing errors.

## 3. Mapping to the Book's Key Points

| Book key point | Maka manifestation | Beyond / Missing |
|---|---|---|
| Execution-tool security hierarchy | Three layers: permission confirmation (`shell_unsafe` never delegated down) → Seatbelt/linux sandbox → `required_boundary` boundary-expansion pre-check | **Beyond**: admits static classification is undecidable (`permission.ts` comment), uses classification only as a "confirmation reason" rather than a security boundary; sandbox + prompt as two layers. **Missing**: PTY and some backends (headless executor) have no sandbox to wrap |
| Persistent terminal sessions | ShellRunStore SQLite persistence, monotonic revision, orphan recovery (`recoverOrphanedSession`→`markOrphaned`), session-close lease/epoch against late writes | **Beyond**: terminal states immutable + dual-write conflict diagnostics (`same_revision_conflict`) + UI fold projection |
| Command-output truncation + persistence | Three layers: 1MB/stream tail retention (BashTailBuffer) → model 50KB budget truncation (tail-first, with recovery hint) → `truncated`/`redacted` flags persisted | **Beyond**: line-boundary-safe truncation prevents secret line-break leaks; unsafe-drop markers prevent "looks like no output"; truncation does not kill the process. **Missing**: see §4 |
| Fail fast | pre-spawn abort check, `assertStartAllowed` session-epoch fence, slot reservation, sandbox-transform pre-check, WriteStdin fully validated before commit | **Beyond**: startup fence (`startupSettled`) + two-phase session close (`terminateSession`/`commitSessionClose`) against races |
| Failure recovery | timeout SIGTERM→grace 2s→SIGKILL escalation + ps-snapshot hunting of escaped descendants; integrityFailure→failed; `safeFailureMessage` truncation/redaction; persistence retry (`persistChain`) | **Beyond**: node-pty data-fence invariant after exit; PTY parse failure fails the whole chain (fail-closed). **Self-admitted gap**: "post-snapshot new daemonize is best-effort" |
| Pre-check–confirm | `required_boundary` declaration + three-state evaluation (noop/conflict/recoverable); `preflightDeclaredSandboxBoundary` | **Beyond**: boundary evaluated before spawn, failures carry a `recoverable` marker for the UI to convert into a prompt |

## 4. Current Implementation Analysis

**Strengths**
1. Extremely rigorous domain model: state machine/invariants/validation all sink into `@maka/core`; the store only swaps the medium; the merge engine carries diagnostics rather than silently overwriting — under local-first + multiple observers, consistency is better than most comparable tools.
2. Output safety is defense in depth: memory tail (line-boundary) → model budget (tail-first) → redaction (whole-line/whole-buffer) in three layers, and "truncation does not kill the process, keeps the recoverable tail" directly fixes the benchmark path's kill-process/wrong-exit-code problems (`shell-exec.ts` header comment).
3. Solid session-leak protection: session epoch + close lease + two-round terminate, slot caps (64/8), orphan recovery, escaped-descendant hunting.
4. PTY emulator is fail-closed: dangerous OSC sequences intercepted, parse budget uses "evict oldest" rather than pausing (prevents the socket fence deadlocking after exit), RIS reset on input gaps, protocol answers capped at 1MB.

**Deficiencies / Risks**
1. **Information loss from output caps**: the PTY model budget is only 50KB and tail-first — the **head** of long scrolling output (e.g. compile errors, test names) is dropped first; UI raw replay is only 16K chars. Pipes likewise keep only a 1MB tail. A command printing one huge line loses the whole line (has a marker, but content is unrecoverable).
2. **No default timeout for background/PTY**: with `run_in_background=true`, `timeoutMs` defaults to unlimited (only a 24h cap); PTY is the same. If the model forgets to stop and `StopBackgroundTask` is not in the subagent tool allowlist (self-described in the `shell-run-manager.ts` slot-rejection copy), the global 64 slots are the only backstop — there is still a "holds a slot until session close" leak surface.
3. **PTY is never sandboxed**: `sandboxCommand` throws directly for PTY, effectively leaving the strongest interactive surface (can type, Ctrl-C, replay) protected only by a bare permission prompt; `WriteStdin` docs admit "ordinary audited tool-call data, not a secure secret channel", and there is no terminal flow control (`handleFlowControl:false`).
4. **Directory escape**: cwd only passes `canonicalExistingPath` validation; the command can freely `cd`/read/write — pipes rely on the sandbox as backstop, but the headless/executor path and the PTY path have no sandbox; escalation to unsandboxed only records an audit (`sandboxEscalation`) without blocking.
5. **No retention policy for persistence**: SQLite single-row `record_json` keeps every terminal run forever, no TTL/prune (`shell-run-store.ts` has no DELETE/prune); 1MB×2 output grows linearly with session count.
6. **High complexity in the state-machine startup race**: `pendingStops`/`CompletionLatch`/`sessionEpoch`/`flushInFlight` intertwine; the 74KB single file is hard to read; in `finalizeLive`, when best-effort persistence fails, the `finished.reject` and the `notifyCompletionOwner` finally path (`notifyCompletionOwner(live,false)` runs unconditionally) carry a mild "duplicate notification" semantic risk, backstopped by the `completionNotified` idempotency.

## 5. Target Architecture

**Target state (recommended)**
1. **Separate "execution kernel" from "task orchestration"**: split `shell-run-manager.ts` by responsibility into `ShellRunRegistry` (live table/slots/orphan recovery), `ShellRunLifecycle` (start/terminate/finalize), and `PtyControl` (WriteStdin/resize cut chain), reusing the `shell-exec.ts` "dumb core" philosophy — the current single file is the only exception that does not follow it.
2. **Three-tier output policy**: pipes gain a "head+tail dual window" (opencode-style); the PTY budget becomes "screen fully preserved + scrollback tail"; model-facing output gets a `truncatedAt:'head'|'tail'|'middle'` metadata; for >1MB background output, offer explicit spill to a workspace file + Read guidance (the tool description already allows it, but `tool-output.ts` deliberately avoids it in a comment — needs a per-scenario decision).
3. **Default timeout/heartbeat for background tasks**: background Bash gets a generous default (e.g. 30min) + optional `keepalive` heartbeat renewal; PTY gets both an "idle timeout" and a "maximum lifetime" cap, and `StopBackgroundTask`/`WriteStdin` are added to the subagent default allowlist.
4. **PTY security upgrade**: refuse embedding high-risk OCS/input in the PTY launch command (OSC 52 etc. already intercepted; extendable to intercept a `\x1b]` subset); downgrade "in-PTY-session" permissions to "profile snapshot at session start + re-validate subsequent WriteStdin against the same profile"; reserve a `sandboxType` passthrough for future backends supporting conpty/seatbelt combinations (the current `start()` hard-refuses argv+fdInputs+PTY).
5. **Persistence retention policy**: terminal runs get a TTL (e.g. 7 days) or "metadata + last snapshot only"; large output values move out of `record_json` into a separate blob table, avoiding single-row JSON bloat slowing transactions.
6. **Observability**: report `ShellRunMergeDiagnostic`, slot denials, and escaped-descendant hunt results as structured telemetry (currently only `console.warn`), for "failure recovery" postmortems.

## 6. Open Questions

- Is "PTY without sandbox" an acceptable product trade-off (in a local desktop-app context)? Or should PTY be forbidden from accessing non-workspace paths?
- Do the 50KB/1MB truncation defaults fit "long build log" scenarios? Should `Read(ref)` gain "offset read within the window" rather than a whole snapshot?
- The combination of "no default timeout for background" + "subagents have no stop tool": should it become a default time limit, with continued observation via Read?
- Does unbounded `record_json` growth constitute a local-storage red line? Do orphan records (missing `observedAt`) need GC?
- `shell-controls-copy.ts` (app-shell i18n) shares the shell domain name but is unrelated — should it be renamed to `app-shell-controls-copy` to avoid misleading future maintainers?
