# Computer Use Domain · Maka Code Analysis and Architecture Design

## 1. Code Map

**Contract layer (provider-neutral vocabulary, @maka/core)**
- `packages/core/src/computer-use.ts`: the whole-domain shared vocabulary, containing no execution logic. Contents: `COMPUTER_USE_ERROR_CODES` (29 closed-set error codes), `CU_ACTION_TYPES` (17 coordinate actions), `CU_SEMANTIC_ACTION_TYPES` (8 semantic actions), `CU_TOOL_ACTION_TYPES` (single source for the full wire set, incl. the three openers `list_apps/launch_app/observe`), `CU_OBSERVING_ACTION_TYPES` (observe/mutate split; `CU_MUTATING_ACTION_TYPES` derived from it), frame/display/window/page identity, `COMPUTER_USE_DISPATCH_TIERS` (`ax/semantic-background/coordinate-background`), `COMPUTER_USE_EFFECTS`, `COMPUTER_USE_APPROVAL_CLASSES`, `computerUseModelCallArgs` (model-readback redacted projection), `computerUseApprovalSummary/ScopeKey`.

**Runtime layer (platform-neutral tool surface, @maka/runtime)**
- `computer-use-tools.ts` (~140KB, core): everything about the `maka_computer` `MakaTool`: wire schema (`computerWireParams`, `.strict()`), `buildComputerUseTools(deps)`, session/frame/lease state machines, invocation queue, presentation-fence coordination, `permissionArgs`, debug journal, `sessionEvents`, `clearSession`.
- `computer-use-types.ts`: `CuDispatchBackend` (host-injected backend seam), `CuObservation`, `CuObservedElement`, `CuSemanticAction`, `CuRunContext`, `CuOverlayHook`, `CuPresentationFence`.
- `computer-use-codec.ts`: strict discriminated-union parser `computerParams`, refinement messages, redundant target-hint compatibility.
- `computer-use-observation-text.ts`: observation rendering (one element per line + indentation tree, header, menu-bar sections, query filtering, container folding).
- `cua-frame-state.ts`: per-observation frame state machine (epoch, claim/confirm/retire, fingerprint binding, dedupe).
- `cua-session-state.ts`: per-session state machine (`unobserved/active/intervention_debounce/reobserve_required/screen_locked/blocked_url/user_stopped`) + generation lease.
- `openai-computer-{actions,codec,loop,policy}.ts`: experimental independent loop for OpenAI's native `computer_call` (screenshot continuation, action batching, safety check, fail-closed dialect conversion).

**Host layer (native execution, @maka/computer-use + desktop app)**
- `packages/computer-use/src/`: `select-backend.ts` (backend selection, returns NONE on non-darwin), `maka-cu-backend.ts` (`CuDispatchBackend` implementation speaking to a Swift subprocess over stdio JSON-RPC, protocol `maka.cu/2`), `maka-cu-service.ts` (subprocess supervision), `maka-cu-protocol.ts`, `stdio-json-rpc.ts`, `display-snapshot.ts`, `frame-budget.ts` (screenshot budget), `computer-use-overlay-hook.ts` (cursor overlay hook).
- `apps/desktop/src/main/computer-use-host.ts`: binary integrity check (manifest sha256 + distributionReady), host assembly. `desktop-native-capability-assembly.ts`: assembles cursor overlay / PiP / status item / screen-lock / physical-input guard with the tools, `applyComputerUseRealModelPolicy` wraps the E2E policy.
- `apps/desktop/src/main/computer-use/`: `cursor-overlay-window.ts` (virtual cursor spring animation), `pip-window.ts` + `pip-{electron,motion,feed}.ts` (action-window mirroring), `status-item.ts`, `screen-lock.ts`.
- `docs/computer-use-*.md`: 6 contract docs (foundation-contract / model-loop-foundation / provider-evidence / evidence-classes / host-events-contract / provenance).

## 2. Core Data Model and Flows

**Perception**: `observe` → backend `observeApp` returns `CuObservation` (AX element tree + optional screenshot + window/page identity) → `registerObservation` writes `CuaFrameState` (`frameId+epoch`) → `renderObservationText` renders model text (a header line `observation_id/app/pid/window_id/elements` + one line per element `<id> <role> "<label>" ="<value>" [state] @x,y wxh`). **Observation is text-first**: `include_screenshot` defaults to false; measured no-image 428 tokens, screenshot ≈ +500; the AX tree is the "full window", the screenshot is optional visual evidence.

**Thinking**: Maka's computer use is **not** a closed provider loop. The default path is an ordinary AgentRun: the model calls `maka_computer` as a normal function tool inside `AiSdkBackend/streamText`. The OpenAI-native `computer_call` loop (`openai-computer-loop.ts`) is an independent, default-observation-only experimental path.

**Action**: the model calls `maka_computer` with `observation_id + element_id` (semantic) or `coordinate`. The execution pipeline (`computer-use-tools.ts` impl):
1. parse the strict union → check `withheld_value_replayed` (prevents the model replaying `<text:18>` placeholders)
2. `withInvocationQueue` (per-session serial) → `sessionState` → screen-locked gate
3. lease: observation actions take an observation lease, mutation actions an action lease (`CuaSessionState.beforeAction/beforeObservation`, generation validation)
4. **per-action TCC recheck** (S12): `backend.preflight` checks accessibility/screenRecording every time
5. `claimBoundAction`: fingerprint binding → frame/epoch/dedupe validation → claim
6. `runWithPresentation`: overlay `onActionBegin` → wait for `readyForInteraction` (bounded fail-open, can only delay) → `beforeDispatch` re-validates the lease → backend `runSemantic`/`run` → `onActionEnd`
7. `consumeBoundAction` (invalidates the frame) + `applyTypedOutcomeState` + **full re-observe after every mutation** (`freshFullObservation`; success and failure both, unless dispatch did nothing → `retireAction` keeps the frame)
8. dual result channels: `text` (persistent session log, only the summary `persistedObservationText`) / `modelText` (the model sees the full tree + `Fresh observation:` tail) + optional `screenshot` going through `toModelOutput` file blocks (not in the session log)

**Grounding**: three-layer anchoring — semantic actions bind to AX element identity (`element_id` is only valid within the observation that produced it); coordinate actions bind to capture-local pixels (`sourceBoundsPx`→`windowBounds` conversion, see `cua-frame-state.ts::bindWindowPoint/presentationScreenPoint`); Electron pages have independent identity (`cdpPort/pageTargetId/documentFingerprint`). The three states `stale_epoch/stale_frame/duplicate_action/retired_action` distinguish "already happened / already rejected / frame expired"; `targetHintConflict` validates the model's redundant app/window hints; `target_mismatch` is a dedicated error code.

**Permission**: `permissionArgs` uses the host's own observation to resolve `element_identity` and fills in the confirmed app/window; `computerUseApprovalSummary` splits into five classes (metadata/screenshot/pointer/keyboard/semantic mutation); `ToolRuntime` (`tool-runtime.ts`) projects the durable and model-readback records through `computerUseModelCallArgs` (the docs note: previously using the approval summary for projection taught the model to emit host-only fields like `approvalClass/windowId`).

## 3. Mapping to the Book's Key Points (Chapter 9 · Computer Use)

| Book key point | Maka manifestation | Assessment |
|---|---|---|
| Action-space design | `CU_ACTION_TYPES` (coordinate) + `CU_SEMANTIC_ACTION_TYPES` (semantic) + three openers, observing/mutating split, wire enum as single source | **Beyond**: not just coordinate-vs-semantic; also an observing/mutating binary split driving leases; semantic-first, coordinates kept but fail-closed |
| Three visual-grounding routes SoM/DOM/coordinate | SoM = AX semantic tree (default main path); DOM = Electron page identity (`cdpPort/pageTargetId` retained); the coordinate route has a full codec + conversion but is off by default | **Manifests**: all three routes exist, with a clear trade-off ("no pruning without a pixel fallback") |
| Screenshot loop (screenshot → model → action) | Default is an **AX text observation loop**; screenshots optional; fresh observation + screenshot dual channel after every mutation | **Diverges**: the observation center of gravity moved from pixels to the semantic tree, screenshots demoted to visual verification, consistent with the measured "element actions don't need pixels" |
| AOI observation interface | **Missing**: no incremental/region re-observation. The substitute is `query` filtering (`matching()` keeps ancestors) + `element_sequence` stepwise re-observation | **Missing**: large windows re-read the whole tree (Finder 1226 elements/14.7k tokens) with no diff |
| World model | `CuaFrameState` (frameId+epoch) + `CuaSessionState` (status+generation) + `obscuringRects`/display snapshot | **Emphasizes consistency over prediction**: guarantees "the frame the model references = the frame it saw", with no cross-frame state prediction |
| Fast/slow decoupling | slow = model turns; fast = Swift executor (155ms capture) + in-call `element_sequence` host stepwise execution; presentation (cursor spring) decoupled from dispatch via `CuPresentationFence` | **Manifests**: the fence only delays, never blocks; `onActionEnd` uses executor-resolved points; failure always cancels |

## 4. Current Implementation Analysis

**Strengths**
1. **Consistency/fail-closed discipline is the whole domain's top priority**: frame+epoch binding, fingerprints, claim/confirm/retire, `withheld_value_replayed` anti-replay, per-action TCC rechecks, `preservePartialDelivery` (partial delivery → outcome_unknown rather than replay). Every error code has a "what to do next" recovery phrase (`SESSION_BLOCK_RECOVERY`/`BINDING_FAILURE_RECOVERY`).
2. **Privacy engineered in**: typed/screen-derived values keep only shapes (`<text:18>`/`<point>`), `messageIsAppTextFree` explicitly gates error phrases, the persistent log and the model surface are separated (`text` vs `modelText`), base64 frames never enter the session log.
3. **Observation rendering is a real engineering achievement**: one element per line + indentation, default states unwritten, `collapseStructuralWrappers`/`dropSeparators` with measured justification (preserves 1023 unnamed operable elements), `truncated=true` explicitly says "may exist but not listed", query filtering keeps ancestors.
4. **Anti-fork test culture**: `computer-use-schema-parity.test.ts` locks wire-enum↔schema↔approval three-way consistency (historical lesson: `window_action` hid for an entire dev cycle by being "added to the union but not the wire schema"); frame-survival/refusal-text/screen-lock-gate dedicated tests.
5. **Presentation isolation**: the overlay can read coordinates but not change them; `readyForInteraction` can only delay (the producer self-reports `readyTimeoutMs` as the max, and the backstop cannot be smaller); `finished` does not block native dispatch.
6. **Verifiable provider-evidence grading**: `real-runtime / fault-injection / hermetic-protocol / static-contract`, with real-model E2E (OpenAI gpt-5.4 running observe+click_element, semantic click 1445ms).

**Deficiencies / Risks**
1. **No screenshot size/resolution policy**: only byte budgets (`FRAME_COMPRESS_THRESHOLD_BYTES` 1.5MB re-encode JPEG82, `FRAME_MAX_BYTES` 8MB); no target resolution/size caps, no perceptual hash, no changed-region cropping; full recapture after every mutation.
2. **Latency and round-trips are the dominant cost** (repeatedly measured in code): AX tree walking is slow (Finder 175ms, System Settings 684ms, cross-process open/save panels 1500 elements/35s hitting the 20s deadline); in multi-turn sessions 42% of calls are observations; preflight + full fresh observation before/after every action.
3. **macOS-only + coordinate/keyboard fail-closed**: `selectComputerUseBackend` returns NONE on non-darwin; the coordinate path being off by default means Windows/Linux have no dispatch path, so multi-provider coordinate dialects cannot land in execution.
4. **Two provider routes coexist with no unified orchestration**: the main path is a function tool (AiSdkBackend); the OpenAI-native `computer_call` loop is an independent experimental path (`openai-computer-loop.ts`, screenshot continuation/safety check/action batching); both converge their action spaces onto CuAction, but there is no single Loop abstraction to close the gap.
5. **Multi-provider differences not sealed**: OpenAI's strict schema requires everything required+nullable (`model-loop-foundation.md` records 5 adaptation steps); Anthropic has been measured dropping `observation_id` (recovered via typed errors rather than host backstop); dialect conversion is fail-closed (scroll deltas, drag paths >2, key chords are all lossless-unconvertible).
6. **Weak bridge to the text Agent**: a single giant `maka_computer` tool, observation/action/wait not split; only a hint "don't detour via osascript/AppleScript", no orchestration-level integration; no cross-turn element memory (full re-observe every step).
7. **The state machine still has FAIL items on record** (foundation-contract matrix: physical intervention/lock, approval semantics, privacy/telemetry were once marked FAIL — most later fixed in wiring); the dual-executor fork (`hostWalkTree` vs `HostAXBindingProbe`) is a lesson that "writing one copy at each end always forks".

## 5. Target Architecture

1. **Observation grading + AOI/incremental**: L0 snapshot metadata → L1 summary tree → L2 full tree → L3 screenshot. Introduce frame diffs (AX change events / CDP DOM events), re-rendering only the changed subtrees; change `element_sequence`'s "full re-observe each step" into "on-demand diff re-observe". Reuse the existing `matching`/`collapse` machinery; do not write a second rendering policy (the anti-fork lesson).
2. **Screenshot-pipeline strategy-ization**: target resolution/size caps (capped at DIP 2x), perceptual-hash dedupe, upload only changed regions; continue "validate the model's vision capability before upload" (already in foundation-contract §7), upgrading `frame-budget.ts` from byte budget to resolution + content budget.
3. **Unified ComputerUseLoop abstraction**: converge the function-tool path and `openai-computer-loop` onto the same `ScreenshotProvider/Executor/Transport` three interfaces (`openai-computer-loop.ts` already has the prototype); provider adapters only do dialect codec; action semantics converge onto the single CuAction/CuSemanticAction semantics; add an Anthropic-native computer_use adapter.
4. **World model upgraded from "consistency" to "prediction"**: maintain cross-frame stable element identity (`identity.token`, already reserved in `CuObservedElement.identity`), event-driven reobserve triggers, stable `page/documentFingerprint` for targets (the PARTIAL item in the contract).
5. **Bridge to the text Agent**: split `maka_computer` into composable tool surfaces (`computer_observe/computer_act/computer_wait/computer_find`), or give AgentRun a "computer-use sub-loop" delegation capability so the text Agent hands GUI tasks to an independent loop, avoiding flooding the main context with full trees + screenshots.
6. **Make execution faster**: TCC short-term caching + permission-change event listening (keep the per-action recheck safety floor, but eliminate preflight round-trips); AX walking with caching and incremental walk (the `NSWorkspace` cache lesson); decouple background dispatch from observation.
7. **Automated validation**: generalize provider-evidence's fixture-oracle mechanism into production postcondition checks (business result ≠ transport success already has a `verified/effect` contract; fill in readback coverage).
8. **Keep security fail-closed and add sensitive-target grading**: continue the "don't fill AXSecureTextField, don't steal foreground, background-window coordinates count as obscured" discipline; add automatic downgrade and higher approval classes for sensitive apps/pages (banking, login).

## 6. Open Questions

1. **Should "observation-as-text" hold long-term?** AX trees hit time and token caps under cross-process/large windows; should screenshots become the default with AX optional, or a mix (the book's screenshot-loop route)? The current decision is the reverse and is well justified (screenshots produce no coordinate capability and are expensive), but it is worth re-evaluating as model capabilities evolve each round.
2. **Should coordinate actions come back?** The current fail-closed makes tasks like "move the window to the left" **unsolvable** (explicitly recorded in foundation-contract), and Windows/Linux executors cannot land. Restoring coordinates first requires resolving occlusion (background windows inevitably lose z-order) and the conflict with real-mouse occupancy.
3. **Multi-provider strategy**: should OpenAI-native `computer_call` stay observation-only forever? Should its screenshot-continuation loop and the main function-tool path merge into one product (user-visible tool-surface differences)?
4. **AOI/incremental observation benefit boundary**: for 1200-element Finder/VS Code windows, what is the upper token-saving limit of diff re-observation? Needs measurement first (`scripts/cu-prune-eval.mjs` already has an offline replay baseline, extendable).
5. **Which FAIL legacy items of the state machine are still open** (foundation-contract matrix): intervention debounce has no trusted deadline (code comments say "the driver has no reliable debounce deadline, reobserve directly"), is the approval-class lease fully landed, and `element_identity` token stability.
6. **Screenshot privacy boundary**: base64 not entering the session log is right, but screenshots still enter the model context (file block) — do sensitive windows (email, password managers) need a per-app screenshot interception layer? Currently only the AXSecureTextField text layer is intercepted, no pixel-layer interception.

Key file references: `packages/core/src/computer-use.ts`, `packages/runtime/src/computer-use-tools.ts`, `computer-use-types.ts`, `computer-use-observation-text.ts`, `cua-frame-state.ts`, `cua-session-state.ts`, `openai-computer-loop.ts`, `openai-computer-actions.ts`, `packages/computer-use/src/select-backend.ts`, `maka-cu-backend.ts`, `frame-budget.ts`, `apps/desktop/src/main/desktop-native-capability-assembly.ts`, `computer-use-host.ts`, `packages/runtime/src/tool-runtime.ts`, `docs/computer-use-foundation-contract.md`, `docs/computer-use-model-loop-foundation.md`, `docs/computer-use-provider-evidence.md`.
