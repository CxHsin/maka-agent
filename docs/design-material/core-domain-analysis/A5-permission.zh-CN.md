# Permission 域 · Maka 代码分析与架构设计

## 1. 代码地图

### `@maka/core` —— 平台无关的"权限语言"与决策载荷

| 文件 | 职责 |
|---|---|
| `packages/core/src/permission.ts` | 传统权限载荷 + 工具分类。`PermissionMode`(`explore/ask/execute/bypass`)、`ToolCategory`(14 类)、**`categorizeBash()` 命令分类**、三类请求载荷 `PermissionRequest / AdditionalPermissionRequest / SandboxEscalationRequest`、`PermissionResponse` |
| `packages/core/src/permission-profile.ts` | **平台无关权限画像**：`FileSystemSandboxPolicy`(restricted/unrestricted/external_sandbox)、特殊路径 `:workspace_roots/:tmpdir/:slash_tmp/:root/:minimal`、受保护元数据 `deny_write`(`.git/.agents/.codex`)、`NetworkSandboxPolicy`、标准画像工厂、纯函数路径匹配 `canReadPath/canWritePath/isDeniedPath` |
| `packages/core/src/permission-profile-compiler.ts` | 传统 mode → 画像编译（`explore→read-only`、`ask/execute→workspace-write`、`bypass→danger-full-access`） |
| `packages/core/src/sandbox-boundary.ts` | **执行边界权威**：`ExecutionBoundary`(managed/bypass/external + revision)、`SandboxBoundaryRequest`(pending/approved/denied/conflict)、**边界扩容** `SandboxBoundaryExpansion`、包含/冲突判定 `assessSandboxBoundaryExpansion`、`executionBoundaryDisplayMode`(#1611) |
| `packages/core/src/runtime-boundary.ts` | 运行时事件前缀 **sha256 摘要链**：`ImmutableRuntimePrefix → RuntimeBoundaryCursor → ContinuationClaim`，崩溃恢复的可信边界 |
| `packages/core/src/additional-permissions.ts` | 附加权限画像校验（≤32 entries、≤4096 字符、64KB 序列化上限） |
| `packages/core/src/interaction-permission-review.ts` | 权限请求 → UI 安全投影：有界字符串、`redactSecrets`、严格 shape 校验、`assertToolSemantics`(工具名/分类/原因/审查形状四者必须自洽) |
| `packages/core/src/interaction.ts` | `InteractionRequest`(permission/question/sandbox_boundary)、决策 outcome 校验、`rememberForTurn` 合法性 |
| `packages/core/src/runtime-event.ts` / `events.ts` | `RuntimeEvent.actions.permissionRequest/permissionDecision`；`PermissionRequestEvent / AdditionalPermissionRequestEvent / SandboxEscalationRequestEvent / SandboxBoundaryRequestEvent / PermissionDecisionAckEvent / PermissionAnswerAckEvent` |
| `packages/core/src/tool-args-identity.ts` | `canonicalToolArgsHash/stableJsonStringify`：**工具调用参数身份**（严格 JSON 规范化，防 `__proto__` 碰撞） |
| `packages/core/src/tool-recovery-fact.ts` | 工具副作用对账事实（reconcile → completed/parked） |
| `packages/core/src/execution-evidence.ts` | 跨账本证据引用 `ExecutionEvidenceRef` |
| `packages/core/src/runtime-policy.ts` | 运行时策略，默认 `chatDefaults.permissionMode: 'ask'` |

### `@maka/runtime` —— 平台沙箱与执行权威

| 文件 | 职责 |
|---|---|
| `packages/runtime/src/sandbox/README.md` | 边界职责划分（"core 定义边界语言，runtime 做平台变换"，enforcement 缺口见 issue #843） |
| `sandbox/types.ts` | `SandboxType`(none/macos-seatbelt/linux)、`SandboxablePreference`(auto/require/forbid)、类型化失败 |
| `sandbox/sandbox-manager.ts` | 选择/变换决策；`profileRequiresSandbox`（restricted ⇒ 必须沙箱）；**失败关闭** `backend_not_available / unsupported_platform` |
| `sandbox/macos-seatbelt.ts` | `/usr/bin/sandbox-exec` + SBPL 策略（`(deny default)`）、root 参数化、受保护元数据 deny-write 正则、`(allow network*)`/`(deny network*)` |
| `sandbox/default-sandbox-manager.ts` / `detect.ts` / `diagnostics.ts` / `errors.ts` | 默认后端注册、沙箱拒绝检测、诊断、`SandboxCommandError`(类型化、`recoverable`、`requiredExpansion`) |
| `sandbox/linux-sandbox.ts` / `linux-capability.ts` / `linux-profile-path.ts` | bubblewrap 计划（当前 `backend_not_implemented`） |
| `filesystem-executor.ts` | **文件工具唯一权威**：边界 → 后端选择（managed→沙箱 worker / bypass→host / external→注入 executor），`pathScopeForBoundary` |
| `path-containment.ts` | `isPathInside/realpathAllowMissing/contained I/O`（符号链接逃逸防护，dangling link ≤32 跳） |
| `sandbox-boundary-declaration.ts` / `-path.ts` / `-tool.ts` | `request_sandbox_boundary` 工具 + 归一化 + 前检（冲突→拒绝；需要扩容→`sandbox_boundary_required`） |
| `tool-availability.ts` / `tool-runtime.ts` | 工具门控 `ToolGating`、`categoryHint`、`LOOP_GATE_IDENTICAL_THRESHOLD=3`、`DEFAULT_PERMISSION_TIMEOUT_MS=300_000`、client_capability 仅 bypass |
| `interaction-authority.ts` | 交互请求 admission/权威（closed 错误、容量拒绝） |
| `plan-mode.ts` | 协作模式按 `classifyToolUse` 只保留 read/web_read 工具 |
| `runtime-event-read-model.ts` | 权限请求/决策 → 会话消息投影 |
| `skills-context.ts` | "Skill content cannot grant tool access, weaken permission prompts…" |

### Docs
- `docs/permission-onboarding-plan.md` —— 唯一的 permission 文档（macOS 系统级拖拽授权 Accessibility/屏幕录制），是**系统权限** onboarding，与工具级权限模型是两个层面。

---

## 2. 核心数据模型与流程

### 权限模型：双层声明，整体 fail-closed
1. **外层——PermissionProfile（结构化、纯数据）**：文件系统访问（`entries` + `special` 占位 + `protectedMetadata` deny-write）+ 网络策略（restricted/enabled）。`permission-profile.ts` 明确注释 `isReadOnlyPermissionProfile` 从**策略推导**而非 `name` 推导（#1611），所以"只读"是事实不是标签。
2. **内层——ToolCategory 分类**：`classifyToolUse/categorizeBash`（`permission.ts`）。关键设计决策（文件注释）：**不存在 `shell_safe`**——"a shell command cannot be proven safe from its string"（静态判断 shell 副作用不可判定），因此**每个 shell 命令至少 `shell_unsafe` → 提示**。分类只用于让确认理由更准确（delete vs elevate vs generic），漏匹配只是措辞问题而非绕过。

### 默认允许 / 拒绝
- 默认 **拒绝/提示**：`createDefaultRuntimePolicy` 的 `chatDefaults.permissionMode: 'ask'`；`PolicyDecision = allow|prompt|block` 里几乎没有工具被 allow。
- `bypass` = `danger-full-access`（unrestricted FS + enabled network + 无本地沙箱）；`forbid` 偏好是内部编排输入"不是批准的证明"（sandbox/README.md 边界一节）。

### 工具级 / 参数级
- **工具级**：内置工具表 `BUILTIN_TOOL_CATEGORY`（Read/Glob/Grep→read，Write/Edit→file_write，Bash→shell_unsafe…）。
- **参数级**：`categorizeBash` 对命令字符串做**分段+规范化+嵌套 shell 递归**扫描（`commandSegments`、`normalizeSegmentHead`、`scanSegments(cmd, depth=2)`、backtick 双扫描），识别 privileged / fs_destructive / git_destructive / shell_unsafe；路径由 `permission-profile` 匹配器 + `path-containment` + 沙箱 worker 三重落地。
- `tool-args-identity.ts` 提供**参数身份哈希**（严格 JSON、防 `__proto__`、防 undefined/bigint/非有限数碰撞）——这是审计与（未来的）参数级决策的关键原语。

### 沙箱边界实现
- macOS：`sandbox-exec` + Seatbelt SBPL，`(deny default)` + 平台默认 + 画像 root 参数化（`-DREADABLE_ROOT_i/WRITABLE_ROOT_i`）+ 受保护元数据 `require-not` 正则 + `(deny network*)`。**进程级隔离，非容器**。
- Linux：bubblewrap 后端已注册但 `backend_not_implemented`（fail-closed：`unsupported_platform`）。
- 网络隔离：仅网络策略二元（restricted→`deny network*` / enabled→`allow network*`），**无域名/端口级网络沙箱**（README 明确列为 non-goal）。
- 文件执行：`filesystem-executor.ts` 是"单一权威"——`managed`→沙箱 worker、`bypass`→host、`external`→注入 executor，工具自身不带策略分支（#2083 修复：bypass 不再被隐式 workspace 规则约束）。

### 权限决策如何进日志（证据）
- 请求：`permission_request` RuntimeEvent（`permissionRequest` payload）。
- 决策：canonical 决策持久化于 **InteractionStore**（`InteractionCanonicalPermissionOutcome`，含 `reviewer: 'user'|'auto_review'`、`committedAt`、可选 `rationale`）；运行时以 **identity-only** 的 `PermissionAnswerAckEvent`/`permissionAnswerAccepted` 事件回执，避免重复/篡改。
- `runtime-boundary.ts` 的 sha256 前缀链把整个事件账本钉死，`runtime-event-backfill.ts` 可在恢复时从工具调用事件反填 `permissionDecision`。
- `session-trace-projection.ts` / `runtime-event-read-model.ts` 把 `permissionDecision` 投影为 `permission_decision` 消息（带 `rememberForTurn`、riskLevel）。

### 与"Feedback is not fact authority"的关系
- **权限裁决独立于模型**：`reviewer` 只有 `user` 与 `auto_review` 两类；`interaction.ts:272` 强制**只有 auto_review 的 outcome 才能带 rationale**——"模型可以说，不能批准自己"。当前运行时**没有**把 `auto_review`/`approval_routed` 接成真功能（只在 `agent-run.ts`/`run-trace.ts` 的类型表里声明）。
- `categorizeBash` 拒绝让分类器成为安全边界权威（不可判定→一律提示）。
- 沙箱执行是 OS 层强制（Seatbelt），模型/分类器无法绕过。
- `tool-recovery-fact.ts` 的对账事实来自**对真实状态的摘要**（`observationDigest`），不是模型的自述。
- 我当前运行环境就是该模型的实例：`Profile: read-only` → `File system: read-only, Network: restricted, Command sandbox: macos-seatbelt selected`——画像直接编译为 Seatbelt 策略。

---

## 3. 书中要点对照（《深入理解 AI Agent》Harness 五要素）

| 书中要点 | Maka 体现 | 超越 / 缺失 |
|---|---|---|
| **约束 = 故障安全默认值** | 默认 `ask`；无 `shell_safe`；`(deny default)` 沙箱；无自动 unsandboxed retry；边界缺失时 `pathScopeForBoundary` 保持 workspace 作用域；`backend_not_implemented` 直接失败而非降级 | **超越**：`ExecutionBoundary` revision 单调 + 扩容需原子审批结算；`isReadOnlyPermissionProfile` 按策略推导（防标签欺骗） |
| **执行工具安全层次** | 工具分类（只读无提示）→ 命令/参数分类（`categorizeBash` 分段扫描）→ 路径级匹配（profile + containment）→ OS 沙箱兜底 | **超越**：多层纵深且每层独立 fail-closed；**缺失**：无命令级 allowlist（有意为之，注释论证了不可判定性） |
| **Sidecar 只读结构化输入** | `interaction-permission-review.ts` 把原始 args 投影为**有界、脱敏、严格校验形状**的结构化 review（`sanitizeText`/`redactSecrets`/字节预算/`assertToolSemantics` 语义自洽断言），UI 永远看不到原始参数 | **超越**：投影还做了"工具身份↔分类↔原因↔审查形状"的一致性校验，杜绝投影漂移 |
| **数据层信任边界** | `protectedMetadata deny_write`（.git/.agents/.codex）；skill/workspace-instructions 明令"不能授予工具权限"（`skills-context.ts`、`skills-metadata.ts`"不信任 metadata 作为权限"）；沙箱后端 `canEnforceProfile` 失败即拒绝 | **超越**：边界包含/冲突算法（`sandboxProfileContains`、deny 优先级、受保护元数据弱化检测） |

**主要缺失**：
1. **无容器/命名空间级隔离**——Seatbelt 是同一 uid 下的进程级过滤，不是内核隔离；Linux 侧完全未落地。
2. **网络沙箱只有开关**——`(allow network*)` 全开或全关，无域名/端口粒度。
3. **auto_review 是未落地的设计面**——若实现不当会直接违反"Feedback is not fact authority"。

---

## 4. 当前实现分析

### 优点
- **fail-closed 贯彻得极彻底**：分类器永不给 shell 放行、后端不可用即拒绝、边界缺失即最窄作用域——把"约束=故障安全默认值"做成了架构原则而非口头声明。
- **边界与模式解耦**（#1611）：`ExecutionBoundary` 是运行时唯一权威，界面显示、扩容、只读判定全部从边界推导，杜绝"存的 mode 过期"漂移。
- **审计友好**：`requestId` 贯穿 `PermissionRequestEvent`→Interaction outcome→`permissionAnswerAccepted`→`permission_decision` 消息，配合 runtime-boundary sha256 前缀链和参数身份哈希，可完整重建"谁批准了什么参数、什么时候、为何"。
- **输入面防御扎实**：权限提示的每个字段都有字节上限 + 脱敏 + 严格 shape + 语义自洽断言，是教科书级的"不可信输入进 UI 前归一化"。
- **权限裁决不信任模型**：决策者是用户（或受限 auto_review），事件账本与 OS 沙箱是最终权威。

### 缺陷 / 风险
1. **越权面**：
   - `rememberForTurn` 按 `toolName+category` 记忆（`interactionRememberForTurnIsEligible`），**未绑定参数身份**——同一轮内同工具的不同危险参数可能被一次放行覆盖（有 `canonicalToolArgsHash` 却未用于决策缓存）。
   - MCP 工具默认 `network_send`（`mcp-tools.ts:77`），每次必提示但也会大量"无差别提示"→ 用户习惯性放行（提示疲劳）。
   - `custom_tool` 无分类提示时退回 `custom_tool`，`client_capability` 只能在 bypass 下执行（`tool-runtime.ts` CLIENT_CAPABILITY_BOUNDARY_MESSAGE）——开放式能力面缺乏参数级白名单。
2. **静默放行**：`bypass` 边界 = host 执行 + 全放开，且 `forbid` 偏好"是内部编排输入、非批准证明"（README 自我承认）；`external` 边界信任外部环境供给隔离而**不叠加本地沙箱**（README 明确）。
3. **可审计性缺口**：canonical 决策在 InteractionStore、runtime event 只存 identity 回执，两份记录靠 `requestId` 关联但**无对账校验**；`permissionDecision` 事件不含参数摘要（防敏与审计之间的平衡偏向防敏）。
4. **可用性 vs 安全**：Linux 上 managed restricted 直接 `backend_not_implemented`（fail-closed 正确但等于不可用）。
5. **Seatbelt 策略维护风险**：`macos-seatbelt.ts` 内置 ~700 行平台默认策略，属"用全量许可对抗 deny default"，新系统组件（mach/extension）可能误伤或需要持续补丁。

---

## 5. 架构设计（目标态）

**目标：把 permission 域从"分散的分类器 + 提示流"演进为"声明式能力授权 + 可审计决策账本 + OS 强制兜底"的三层结构。**

1. **统一决策账本（PermissionDecisionJournal）**：每个决策落一条结构化事件（`requestId + toolName + canonicalToolArgsHash + category + decision + reviewer + riskLevel + rationale + boundaryRevision`），并**与 InteractionStore 做双写对账**（复用 `execution-evidence.ts` 的跨账本引用与 `runtime-boundary` 前缀链）。目标：任何一次放行都可被"反向审计"。
2. **参数级决策缓存**：`rememberForTurn`/"本会话记住"绑定 `canonicalToolArgsHash` 而非仅 `tool+category`；新增"同一参数形状允许/拒绝"缓存层，减少提示疲劳同时避免参数级越权。
3. **声明式能力清单替代纯类别**：`ToolCategory × 路径/URL/命令形状 × 工具身份` 三元的 `PolicyRule`，内置工具与 MCP/自定义工具统一走规则表；MCP 工具引入 `urlScheme/host` 粒度网络规则而非 `network_send` 一刀切。
4. **Linux 沙箱落地或显式降级声明**：bubblewrap + seccomp（`linux-capability.ts` 已探测能力），或对外声明 `unsupported_platform` 并在会话头部显著提示——杜绝"能跑但没沙箱"的隐式状态。
5. **auto_review 规则化落地（守住 Feedback is not fact authority）**：仅允许对 `low` 风险且 `read`/`web_read` 类决策由独立评审模型自动批准，强制写入 `reviewer='auto_review' + rationale + 评审模型版本`，**永不自我批准**（工具调用与评审者分离），用户可一键驳回并回滚已放行项。
6. **权限策略版本化**：把 `ExecutionBoundary.revision` 扩展为"策略族版本"（profile 结构版本 + 分类器版本 + 沙箱后端版本），纳入 `SandboxError`/`runtime-boundary` 摘要，使旧事件的回放可明确"当时的权限语义"。
7. **审计与隐私平衡的显式策略**：generic 工具参数走"摘要 + 脱敏 + 保留哈希"三态（已有 `summarizeGenericToolArguments` 雏形），审计面用哈希 + 摘要而非明文。

---

## 6. 待讨论问题

1. **提示疲劳 vs 默认允许**：是否引入"会话级 deny/allow 学习"？若有，deny 的持久性是否也要参数级绑定、是否可被 skill 内容覆盖（当前明确"不能"）？
2. **auto_review 的信任边界**：评审模型与主模型同供应商时，"独立"如何成立？是否需要强制不同 provider？
3. **bypass 边界的治理**：`danger-full-access` 是否应要求二次确认/冷静期/会话级审计高亮？
4. **网络沙箱粒度**：`deny network*` 与 `allow network*` 之间是否需要"代理白名单"中间态（`runtime-policy` 已有网络代理配置，可复用）？
5. **Linux 优先级**：`backend_not_implemented` 是产品可接受态还是发布阻断项？
6. **权限与协作模式的叠加**：`plan-mode.ts` 按分类过滤只读工具，与 `explore` profile 是否会有语义重叠/漂移？两者谁优先？
7. **受保护元数据范围**：`PROTECTED_METADATA_NAMES = ['.git','.agents','.codex']` 是固定枚举，是否应支持用户扩展（如 `.env`）？

---

*说明：以上引用均来自对 `packages/core/src/permission*.ts`、`sandbox-boundary.ts`、`runtime-boundary.ts`、`interaction-permission-review.ts`、`interaction.ts`、`runtime-event.ts`、`events.ts`、`tool-args-identity.ts`、`tool-recovery-fact.ts`、`runtime-policy.ts`，以及 `packages/runtime/src/sandbox/*`、`filesystem-executor.ts`、`path-containment.ts`、`sandbox-boundary-*.ts`、`tool-availability.ts`、`tool-runtime.ts`、`interaction-authority.ts`、`plan-mode.ts`、`skills-context.ts` 的实际阅读。未修改任何文件。*
