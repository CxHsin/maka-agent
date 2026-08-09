# Computer Use 域 · Maka 代码分析与架构设计

## 1. 代码地图

**契约层（provider-neutral 词汇，@maka/core）**
- `packages/core/src/computer-use.ts`：全域共享词汇表，不含任何执行逻辑。内容：`COMPUTER_USE_ERROR_CODES`（29 个闭集错误码）、`CU_ACTION_TYPES`（坐标动作 17 个）、`CU_SEMANTIC_ACTION_TYPES`（8 个语义动作）、`CU_TOOL_ACTION_TYPES`（wire 全量单一来源，含 `list_apps/launch_app/observe` 三个 opener）、`CU_OBSERVING_ACTION_TYPES`（观察/变更划分，`CU_MUTATING_ACTION_TYPES` 由它派生）、frame/display/window/page identity、`COMPUTER_USE_DISPATCH_TIERS`（`ax/semantic-background/coordinate-background`）、`COMPUTER_USE_EFFECTS`、`COMPUTER_USE_APPROVAL_CLASSES`、`computerUseModelCallArgs`（模型回读脱敏投影）、`computerUseApprovalSummary/ScopeKey`。

**运行时层（平台无关工具面，@maka/runtime）**
- `computer-use-tools.ts`（~140KB，核心）：`maka_computer` 这个 `MakaTool` 的全部：wire schema（`computerWireParams`，`.strict()`）、`buildComputerUseTools(deps)`、session/frame/lease 状态机、调用队列、presentation fence 协调、`permissionArgs`、debug journal、`sessionEvents`、`clearSession`。
- `computer-use-types.ts`：`CuDispatchBackend`（宿主注入的后端接缝）、`CuObservation`、`CuObservedElement`、`CuSemanticAction`、`CuRunContext`、`CuOverlayHook`、`CuPresentationFence`。
- `computer-use-codec.ts`：严格 discriminated-union 解析器 `computerParams`、refinement 消息、冗余 target hint 兼容。
- `computer-use-observation-text.ts`：观察渲染（一元素一行 + 缩进树、header、menu bar 分节、query 过滤、容器折叠）。
- `cua-frame-state.ts`：每 observation 的帧状态机（epoch、claim/confirm/retire、fingerprint 绑定、去重）。
- `cua-session-state.ts`：每 session 状态机（`unobserved/active/intervention_debounce/reobserve_required/screen_locked/blocked_url/user_stopped`）+ generation lease。
- `openai-computer-{actions,codec,loop,policy}.ts`：OpenAI 原生 `computer_call` 的实验性独立 loop（截图续传、动作批、safety check、fail-closed 方言转换）。

**宿主层（原生执行，@maka/computer-use + 桌面 app）**
- `packages/computer-use/src/`：`select-backend.ts`（后端选择，非 darwin 返回 NONE）、`maka-cu-backend.ts`（`CuDispatchBackend` 实现，通过 stdio JSON-RPC 与 Swift 子进程说话，协议 `maka.cu/2`）、`maka-cu-service.ts`（子进程监督）、`maka-cu-protocol.ts`、`stdio-json-rpc.ts`、`display-snapshot.ts`、`frame-budget.ts`（截图预算）、`computer-use-overlay-hook.ts`（光标 overlay 挂钩）。
- `apps/desktop/src/main/computer-use-host.ts`：二进制完整性检查（manifest sha256 + distributionReady）、host 装配。`desktop-native-capability-assembly.ts`：把 cursor overlay / PiP / status item / screen-lock / physical-input guard 与 tools 组装，`applyComputerUseRealModelPolicy` 包 E2E 策略。
- `apps/desktop/src/main/computer-use/`：`cursor-overlay-window.ts`（虚拟光标弹簧动画）、`pip-window.ts` + `pip-{electron,motion,feed}.ts`（动作窗口镜像）、`status-item.ts`、`screen-lock.ts`。
- `docs/computer-use-*.md`：6 篇契约文档（foundation-contract / model-loop-foundation / provider-evidence / evidence-classes / host-events-contract / provenance）。

## 2. 核心数据模型与流程

**感知（Perception）**：`observe` → 后端 `observeApp` 返回 `CuObservation`（AX 元素树 + 可选截图 + window/page identity）→ `registerObservation` 写入 `CuaFrameState`（`frameId+epoch`）→ `renderObservationText` 渲染成模型文本（header 一行 `observation_id/app/pid/window_id/elements` + 每元素一行 `<id> <role> "<label>" ="<value>" [state] @x,y wxh`）。**观察是文本优先的**：`include_screenshot` 默认 false；实测无图 428 tokens，截图约 +500；AX 树是"完整窗口"，截图是可选视觉证据。

**思考（Thinking）**：Maka 的 computer use **不是**一个封闭的 provider 循环。默认路径是普通的 AgentRun：模型在 `AiSdkBackend/streamText` 里把 `maka_computer` 当普通 function tool 调。OpenAI 原生 `computer_call` loop（`openai-computer-loop.ts`）是独立的、默认 observation-only 的实验路径。

**行动（Action）**：模型带着 `observation_id + element_id`（语义）或 `coordinate`（坐标）调 `maka_computer`。执行管线（`computer-use-tools.ts` impl）：
1. 解析 strict union → 检查 `withheld_value_replayed`（防模型回放 `<text:18>` 占位符）
2. `withInvocationQueue`（per-session 串行）→ `sessionState` → screen-locked 前置
3. 租约：观察动作取 observation lease，变更动作取 action lease（`CuaSessionState.beforeAction/beforeObservation`，generation 校验）
4. **每动作 TCC 重查**（S12）：`backend.preflight` 每次查 accessibility/screenRecording
5. `claimBoundAction`：fingerprint 绑定 → 帧/epoch/去重校验 → claim
6. `runWithPresentation`：overlay `onActionBegin` → 等 `readyForInteraction`（bounded fail-open，只能延迟）→ `beforeDispatch` 复验 lease → 后端 `runSemantic`/`run` → `onActionEnd`
7. `consumeBoundAction`（invalidate 帧）+ `applyTypedOutcomeState` + **每次 mutation 后 `freshFullObservation` 全量重观察**（成功失败都给，除非 dispatch 什么都没做 → `retireAction` 保帧）
8. 结果双通道：`text`（持久 session log，只留摘要 `persistedObservationText`）/ `modelText`（模型看完整树 + `Fresh observation:` 尾）+ 可选 `screenshot` 走 `toModelOutput` 文件块（不进 session log）

**Grounding（落地）**：三层锚定——语义动作绑 AX element identity（`element_id` 只在产生它的 observation 内有效）；坐标动作绑 capture-local 像素（`sourceBoundsPx`→`windowBounds` 换算，见 `cua-frame-state.ts::bindWindowPoint/presentationScreenPoint`）；Electron page 有独立 identity（`cdpPort/pageTargetId/documentFingerprint`）。`stale_epoch/stale_frame/duplicate_action/retired_action` 三态区分"已发生/已拒绝/帧已过期"，`targetHintConflict` 校验模型冗余的 app/window 提示，`target_mismatch` 是专门错误码。

**权限**：`permissionArgs` 用宿主自己的观察解析 `element_identity` + 填入已确认的 app/window；`computerUseApprovalSummary` 分五类（metadata/screenshot/pointer/keyboard/semantic mutation）；ToolRuntime（`tool-runtime.ts`）把持久与模型回读记录用 `computerUseModelCallArgs` 投影（文档明说：曾用 approval summary 投影导致模型学会发 `approvalClass/windowId` 等 host-only 字段）。

## 3. 书中要点对照（《深入理解 AI Agent》第九章 Computer Use）

| 书中要点 | Maka 体现 | 评价 |
|---|---|---|
| 动作空间设计 | `CU_ACTION_TYPES`（坐标）+ `CU_SEMANTIC_ACTION_TYPES`（语义）+ 三个 opener，观察/变更划分，wire enum 单一来源 | **超越**：不止分坐标/语义，还做 observing/mutating 二元划分驱动租约；语义为主、坐标保留但 fail-closed |
| 视觉定位三路线 SoM/DOM/坐标 | SoM=AX 语义树（默认主路径）；DOM=Electron page identity（`cdpPort/pageTargetId` 保留）；坐标路线有完整 codec+换算但默认关闭 | **体现**：三路线都在，取舍清晰（"没有 pixel fallback 就不许剪枝"） |
| 截图循环（screenshot → model → action） | 默认是 **AX 文本观察循环**；截图可选；每次 mutation 后 fresh observation+截图双通道 | **偏离**：观察重心从像素移到语义树，截图降级为视觉验证，符合"元素动作不需要像素"的实测 |
| AOI 观察接口 | **缺失**：无增量/区域重观察。替代是 `query` 过滤（`matching()` 保留祖先）+ `element_sequence` 逐步重观察 | **缺失**：大窗口全树重读（Finder 1226 元素/14.7k tokens）无 diff |
| 世界模型 | `CuaFrameState`（frameId+epoch）+ `CuaSessionState`（status+generation）+ `obscuringRects`/display snapshot | **侧重一致性而非预测**：保证"模型引用的帧=它看到的帧"，未做跨帧状态预测 |
| 快慢解耦（fast/slow） | 慢=模型回合；快=Swift 执行器（155ms capture）+ 单 call 内 `element_sequence` 宿主逐步执行；presentation（cursor 弹簧）经 `CuPresentationFence` 与 dispatch 解耦 | **体现**：fence 只延迟不阻塞、`onActionEnd` 用 executor-resolved point，失败必 cancel |

## 4. 当前实现分析

**优点**
1. **一致性/fail-closed 纪律是全域最高优先级**：frame+epoch binding、fingerprint、claim/confirm/retire、`withheld_value_replayed` 防回放、每动作 TCC 重查、`preservePartialDelivery`（部分送达→outcome_unknown 而非重放）。每个错误码都有"下一步做什么"的恢复句（`SESSION_BLOCK_RECOVERY`/`BINDING_FAILURE_RECOVERY`）。
2. **隐私工程化**：typed/screen-derived 值只留 shape（`<text:18>`/`<point>`），`messageIsAppTextFree` 显式门控错误句，持久 log 与模型面分离（`text` vs `modelText`），base64 帧永进 session log。
3. **观测渲染是真正的工程成果**：一元素一行+缩进、默认状态不写、`collapseStructuralWrappers`/`dropSeparators` 有实测依据（保留了 1023 个无名可操作元素）、`truncated=true` 明说"可能存在但未列出"、query 过滤保留祖先。
4. **防分叉的测试文化**：`computer-use-schema-parity.test.ts` 锁 wire enum↔schema↔approval 三方一致（历史教训：`window_action` 曾以"加进 union 但没进 wire schema"的方式藏了整个开发期）；frame-survival/refusal-text/screen-lock-gate 等专项测试。
5. **presentation 隔离**：overlay 只能读坐标不能改坐标，`readyForInteraction` 只能延迟（producer 自报 `readyTimeoutMs` 为最大、backstop 不得小于它），`finished` 不阻塞 native dispatch。
6. **可验证的 provider 证据分级**：`real-runtime / fault-injection / hermetic-protocol / static-contract`，真实模型 E2E（OpenAI gpt-5.4 跑通 observe+click_element，语义点击 1445ms）。

**缺陷/风险**
1. **截图体积/分辨率无策略**：只有字节预算（`FRAME_COMPRESS_THRESHOLD_BYTES` 1.5MB 重编码 JPEG82，`FRAME_MAX_BYTES` 8MB），无目标分辨率/尺寸上限、无感知哈希、无变化区域裁剪；每次 mutation 后全量 recapture。
2. **延迟与往返是主成本**（代码反复实测）：AX 树行走慢（Finder 175ms、System Settings 684ms、跨进程 open/save 面板 1500 元素 35s 撞 20s 死线）；多轮中 42% 调用是观察；每动作前后 preflight+全量 fresh observation。
3. **macOS 单平台 + 坐标/键盘 fail-closed**：`selectComputerUseBackend` 非 darwin 直接 NONE；坐标路径默认关闭意味着 Windows/Linux 没有 dispatch 路径，多 provider 的坐标方言无法落地执行。
4. **两条 provider 路线并存，无统一编排**：主路径是 function tool（AiSdkBackend），OpenAI 原生 `computer_call` loop 是独立实验路径（`openai-computer-loop.ts`，截图续传/safety check/动作批），两者动作空间都收敛到 CuAction 但没有一个统一 Loop 抽象收口。
5. **多 provider 差异未封闭**：OpenAI strict schema 要求全部 required+nullable（`model-loop-foundation.md` 记录了 5 步适配），Anthropic 实测会漏 `observation_id`（靠 typed error 恢复而非宿主兜底）；方言转换 fail-closed（scroll delta、drag path>2、key chord 都不可无损转换）。
6. **与文本 Agent 的桥接弱**：只有一个巨型工具 `maka_computer`，观察/行动/等待不拆分；只有提示"不要用 osascript/AppleScript 绕路"，没有编排级集成；无跨回合元素记忆（每步全量重观察）。
7. **状态机仍有 FAIL 项被记录在案**（foundation-contract 矩阵：physical intervention/lock、approval semantics、privacy/telemetry 曾被标 FAIL——多数已在后续接线修复），双执行器分叉（`hostWalkTree` vs `HostAXBindingProbe`）教训说明"两端各写一份必分叉"。

## 5. 架构设计（目标态）

1. **观察分级 + AOI/增量**：L0 快照元数据 → L1 摘要树 → L2 全树 → L3 截图。引入帧 diff（AX 变更事件/CDP DOM 事件驱动），只重渲染变化子树；`element_sequence` 的"每步全量重观察"改为"按需 diff 重观察"。复用现有 `matching`/`collapse` 机制，勿新写第二份渲染策略（防分叉教训）。
2. **截图管线策略化**：目标分辨率/尺寸上限（按 DIP 2x 封顶）、感知哈希去重、只上传变化区域；延续"上传前验证模型 vision capability"（已在 foundation-contract §7），把 `frame-budget.ts` 从字节预算升级为分辨率+内容预算。
3. **统一 ComputerUseLoop 抽象**：把 function-tool 路径与 `openai-computer-loop` 收敛到同一 `ScreenshotProvider/Executor/Transport` 三接口（`openai-computer-loop.ts` 已具备雏形），provider 适配器只做方言编解码，动作语义收敛到 CuAction/CuSemanticAction 单一语义；补 Anthropic 原生 computer_use 适配。
4. **世界模型从"一致性"升级到"预测"**：维护元素身份跨帧稳定（`identity.token`，已在 `CuObservedElement.identity` 预留）、事件驱动的 reobserve 触发器、target 的 `page/documentFingerprint` 稳定（contract 中 PARTIAL 项）。
5. **与文本 Agent 桥接**：把 `maka_computer` 拆成可组合工具面（`computer_observe/computer_act/computer_wait/computer_find`），或给 AgentRun 一个"computer use 子 loop"委托能力，让文本 Agent 把 GUI 任务交给独立 loop，避免把全树+截图灌进主上下文。
6. **执行再快**：TCC 短时缓存 + 监听权限变更事件（保留每次动作重查的安全底线，但消除 preflight 往返）；AX 行走加缓存与增量 walk（`NSWorkspace` 缓存教训）；后台 dispatch 与 observation 解耦。
7. **验证自动化**：把 provider-evidence 的 fixture oracle 机制推广为生产 postcondition 检查（业务结果 ≠ transport success 已有 `verified/effect` 契约，补齐 readback 覆盖面）。
8. **安全保持 fail-closed 并加敏感目标分级**：延续"不填 AXSecureTextField、不抢前台、背景窗口坐标即遮挡"的纪律，增加敏感应用/页面（银行、登录）自动降级与更高审批类。

## 6. 待讨论问题

1. **"观察即文本"是否要长期坚持**？AX 树在跨进程/大窗口下会撞时间与 token 上限；是否引入截图为默认、AX 为可选，或混合（书中截图循环路线）？目前决策是反过来的，依据充分（截图不产生坐标能力、成本高），但值得每轮模型能力演进时重估。
2. **坐标动作要不要恢复**？当前 fail-closed 使"把窗口挪到左边"这类任务**无解**（foundation-contract 明确记录），且 Windows/Linux 执行器无法落地。恢复坐标需要先解决遮挡（背景窗口必然被压 z-order）与真实鼠标占用的冲突。
3. **多 provider 策略**：OpenAI 原生 `computer_call` 走 observation-only 是否永远成立？其截图续传 loop 与主 function-tool 路径是否合并为一个产品（用户可感知的工具面差异）？
4. **AOI/增量观察的收益边界**：对 1200 元素的 Finder/VS Code 窗口，diff 重观察的省 token 上限是什么？需要先量（`scripts/cu-prune-eval.mjs` 已有离线回放基线，可扩展）。
5. **状态机的 FAIL 遗留项**（foundation-contract 矩阵）当前哪些仍 open：intervention debounce 无可信 deadline（代码注释明说"驱动无可靠 debounce 截止，直接 reobserve"）、approval 分级 lease 是否已全量落地、`element_identity` 的 token 稳定性。
6. **截图隐私边界**：base64 不进 session log 是对的，但截图仍会进模型上下文（file block）——敏感窗口（邮件、密码管理器）是否需要 per-app 截图拦截层？目前只有 AXSecureTextField 文本层拦截，无像素层拦截。

关键文件引用：`packages/core/src/computer-use.ts`、`packages/runtime/src/computer-use-tools.ts`、`computer-use-types.ts`、`computer-use-observation-text.ts`、`cua-frame-state.ts`、`cua-session-state.ts`、`openai-computer-loop.ts`、`openai-computer-actions.ts`、`packages/computer-use/src/select-backend.ts`、`maka-cu-backend.ts`、`frame-budget.ts`、`apps/desktop/src/main/desktop-native-capability-assembly.ts`、`computer-use-host.ts`、`packages/runtime/src/tool-runtime.ts`、`docs/computer-use-foundation-contract.md`、`docs/computer-use-model-loop-foundation.md`、`docs/computer-use-provider-evidence.md`。
