# Shell/PTY 域 · Maka 代码分析与架构设计

## 1. 代码地图

**核心契约层（`packages/core/src`，浏览器安全、无 node:* 依赖）**
- `shell-run.ts` — 领域核心。`ShellRunRecord`/`ShellRunPatch`/`ShellRunStatus`（7 态状态机：`starting→running→(completed|failed|timed_out|cancelled|orphaned)`）、`ShellOutput`（pipes|pty 判别联合）、`ShellRunStore` 接口、不变式校验（`isValidShellRunState`、`nextShellRunRecord` 单调 revision、终结态不可变、`sandboxExecution`/`sandboxEscalation` 结构约束）。
- `shell-run-result.ts` — 工具结果契约与 **状态合并引擎**：`mergeShellRunState`（revision 仲裁、`ref_mismatch`/`same_revision_conflict` 不变量诊断）、`ShellRunUpdateBuffer`（hydration 期间 256 条有界缓冲）、legacy 结果归一化（`terminal`→`shell_run` 兼容 3 代历史形状）。
- `events.ts` — 工具结果与更新事件类型（`ShellRunUpdate`/`ShellRunSnapshotResult`/`SandboxDenialSignal`/`SandboxDenialRecovery`）。

**执行与生命周期层（`packages/runtime/src`）**
- `shell-run-contract.ts` — 管理器 I/O 契约与常量（`DEFAULT_BASH_TIMEOUT_MS=120s`、`MAX_FOREGROUND_BASH_TIMEOUT_MS=10min`、`MAX_SHELL_RUN_TIMEOUT_MS=24h`、PTY 尺寸/输入 64KB 上限、`maxLiveShellRuns=64`/`maxLivePtyRuns=8`、resource ref 解析 `maka://runtime/background-tasks/<id>`）。
- `shell-run-manager.ts`（74KB，域心脏）— `ShellRunProcessManager` 实现 `RuntimeResourceReader/BackgroundTaskStopper/PtyControlWriter`：双模式启动（pipes/pty）、定时 flush 持久化、终止生命周期（SIGTERM→SIGKILL 分级 + 进程树）、slot 预留、孤儿恢复、会话关闭租约/纪元。
- `shell-exec.ts` — **单一共享执行内核**（注释自述"dumb core"）：`runShellWithBoundedTail` 内存有界 tail 流式执行，统一内置 Bash 与 Harbor/headless executor 两条路径，修复了旧 `execAsync({maxBuffer})` 超限即杀进程、只回头部、exit code 失真三个 bug。
- `shell-detect.ts` — 平台 shell 探测（posix/pwsh/powershell/cmd）、`buildShellSpawnPlan`/`buildPtyShellSpawnPlan`（PowerShell 显式 spawn + `$LASTEXITCODE` 重抛尾）、`bashToolShellGuidance`（"选择必须声明"给模型的方言指引）。
- `shell-tools.ts` — Bash/StopBackgroundTask/WriteStdin 三个工具：`buildManagedBashTool`（foreground/background/pty 三态 + `required_boundary` 预检）、`buildLocalForegroundBashTool`、`shapeTerminalResult`（secrets 脱敏 + 截断 + sandboxDenial 信号）。
- `shell-run-tool-result.ts` — 记录→模型可见结果投影：`terminalContent`/`shellRunContent`/`compactShellRunContent`、PTY 50KB 文本预算的优先级截断（screen→alternate→scrollback）、sandbox denial 探测。
- `pty-process-driver.ts` / `pty-stack.ts` — node-pty 薄封装（xterm-256color、flowControl 关闭、exit 栅栏不变量）与动态加载/验证（`spawn`+`@xterm/headless`+`unicode11`）。
- `pty-screen-collector.ts` — **无头 xterm 终端模拟器**：解析队列有界（1MB 高水位，淘汰最旧而非暂停源）、OSC 安全边界（拦截 0/1/2/7/8/9/52/777）、alternate buffer 捕获、scrollback 500 行、整行 secrets 脱敏、输入缺口 RIS 复位。
- 支撑：`bash-tail-buffer.ts`（行边界安全 tail）、`pipe-*-driver/collector`、`process-tree-terminator.ts`（POSIX setsid 组 + ps 快照追杀逃逸后代 / Windows taskkill /T）、`tool-output.ts`（50KB/2000 行 head/tail 截断 + 恢复提示）、`bash-model-output.ts`。

**持久化与鉴权层**
- `packages/storage/src/shell-run-store.ts` — SQLite `core_shell_runs`（`record_json` 单行存储、事务内 `nextShellRunRecord` 应用）。
- `packages/storage/src/shell-run-authority.ts` — `StorageRootLease` 租约鉴权的可写 writer 门面（`structuredClone` + 品牌符号），区分"读模型"与"持租约写者"。
- `packages/headless/src/task-shell-run-store.ts` — 单任务内存 store（benchmark 路径）。

**权限与沙箱**
- `packages/core/src/permission.ts` — `categorizeBash`：**永不返回 shell_safe**（"从静态字符串判定图灵完备 shell 的运行效果不可判定"），只做 `shell_unsafe`/`privileged`/`fs_destructive`/`git` 升级来精确化确认理由。
- `packages/runtime/src/sandbox/{macos-seatbelt,linux-sandbox,types,detect,sandbox-manager}.ts` — Seatbelt `/usr/bin/sandbox-exec` 策略生成、`SandboxTransform`（argv 改写）、`isLikelySandboxDenial`。
- `builtin-tools.ts:669 sandboxCommand()` — 把权限 profile + `required_boundary` 变换成沙箱执行 argv；`sandbox-boundary-declaration.ts` — `preflightDeclaredSandboxBoundary`（noop/conflict/recoverable 三态）。

**UI（`packages/ui/src`）**
- `tool-activity/*`、`materialize.ts`、`live-turn-projection.ts` — shell_run 结果面板、WriteStdin 操作元数据投影、live chunk 与 durable 结果的合并。注意：**`pty-output-view.ts` 不存在**；`shell-controls-copy.ts` 实为 `packages/ui` 下**应用壳（导航/搜索）的 i18n 文案**，与命令执行域无关，属命名撞车。

## 2. 核心数据模型与流程

**ShellRun 生命周期（7 态状态机）**
`starting`（store 先落库，`revision=1`）→ `running`（spawn 成功后置）→ 终结态：
- `completed`（exit 0）/ `failed`（exit≠0 或 failureMessage）/ `timed_out`（强制 exit 124）/ `cancelled`（abort/stop/shutdown，exit 130）/ `orphaned`（重启后读到 active 但无 live 句柄）。

状态机不变量集中在 `core/shell-run.ts`（`isValidShellRunState` + `isValidShellRunStatusTransition` + `nextShellRunRecord` 单调 revision + 终结态不可变），注释明言"让第二个 store 只是存储介质更换，而非状态机第二份拷贝"。

**分层：authority → hydration → store**
1. **Store 层**：`ShellRunStore` 接口（create/update/read/list），SQLite 实现单行 JSON 原子更新；headless 内存实现。
2. **Authority 层**：`shell-run-authority.ts` 用 `StorageRootLease` 限定"谁可写"，品牌符号防伪造 writer；`shell-run.ts` 的校验函数是"与存储无关的不变式权威"。
3. **Hydration/观察层**：`ShellRunUpdate` 事件 + `ShellRunUpdateBuffer`（256 有界，hydration 期间合并去重）+ `mergeShellRunState`（revision 仲裁，违反不变量出诊断不覆盖）；UI 侧 `materialize.ts` 把后台 Bash 的子工具（Read/StopBackgroundTask/WriteStdin）折叠回父 shell_run（`shell-run-projection.test.ts`）。

**双执行模式**
- **pipes**：`PipeProcessDriver`（detached setsid）+ `PipeTailCollector`（BashTailBuffer 1MB/流）+ 定时 flush（1s/64KB 阈值）。
- **pty**：`PtyProcessDriver` + `PtyScreenCollector`（无头 xterm），快照在"parser cut"处串行化（`mutateAtCut` 队列），WriteStdin/resize/stop 都经 cut 达成"输入→快照→持久化"原子链；原始字节以 16ms/32KB 节流发布给 UI 实时回放（`ShellRunPtyDataEvent`）。

**与权限/Sandbox 协作**
- 工具面：Bash 属 `activityKind:'command'`，permission 默认 `shell_unsafe`→确认，绝不降级。
- 沙箱面：`sandboxCommand()` 把 `ctx.executionBoundary` 的 profile 变换为 Seatbelt/linux argv 注入（`transformCommand`），命令在沙箱内跑；结果侧 `sandboxDenial: {likely, backend}` 由 `isLikelySandboxDenial` 识别并随结果返回；升级写审计（`sandboxEscalation{commandHash, unsandboxed}`）。
- 预检：`required_boundary` 经 `preflightDeclaredSandboxBoundary` 评估，conflict→`requires_bypass` 拒绝、recoverable→提示申请边界扩展。
- **PTY 例外**：`profileRequiresSandbox` 时 PTY 直接被禁（`pty_sandbox_unavailable`/`requires_bypass`），因为 node-pty 无法套 Seatbelt —— 交互模式永远无沙箱。

**与 Bash 工具的关系**：一个 `Bash` 名、三条实现（本地内置、托管管理器、executor/harbor），共享 `shell-exec.ts` 内核与 `shell-detect.ts` 方言选择；"声明选择"（tool description 注入 shell 方言 + 会话环境片段）防 Windows 方言猜错。

## 3. 书中要点对照

| 书中要点 | Maka 体现 | 超越 / 缺失 |
|---|---|---|
| 执行工具安全层次 | 三层：permission 确认（shell_unsafe 永不下放）→ Seatbelt/linux 沙箱 → `required_boundary` 边界扩展预检 | **超越**：承认静态分类不可判定（`permission.ts` 注释），只把分类当"确认理由"而非安全边界；沙箱+提示双层。**缺失**：PTY 与部分后端（headless executor）无沙箱可套 |
| 持久化终端会话 | ShellRunStore SQLite 持久、revision 单调、孤儿恢复（`recoverOrphanedSession`→`markOrphaned`）、会话关闭租约/纪元防迟到写入 | **超越**：终结态不可变 + 双写冲突诊断（`same_revision_conflict`）+ UI 折叠投影 |
| 命令输出截断+持久化 | 三层：1MB/流 tail 保留（BashTailBuffer）→ 模型 50KB 预算截断（tail 优先，含恢复提示）→ `truncated`/`redacted` 标志持久化 | **超越**：行边界安全截断防 secrets 断行泄露；unsafe-drop 标记防"看似无输出"；截断不杀进程。**缺失**：见 §4 |
| 快速失败 | spawn 前 abort 检查、`assertStartAllowed` 会话纪元栅栏、slot 预留、sandbox transform 预检、WriteStdin 全量校验后提交 | **超越**：启动 fence（`startupSettled`）+ 双阶段会话关闭（`terminateSession`/`commitSessionClose`）防竞态 |
| 故障恢复 | 超时 SIGTERM→grace 2s→SIGKILL 分级 + ps 快照追杀逃逸后代；integrityFailure→failed；`safeFailureMessage` 截断脱敏；持久化重试（`persistChain`） | **超越**：node-pty exit 后 data 栅栏不变量；PTY 解析失败即整链 fail 闭源（fail-closed）。**缺口自认**："快照后的新 daemonize 是 best-effort" |
| 预检-确认 | `required_boundary` 声明 + 评估三态（noop/conflict/recoverable）；`preflightDeclaredSandboxBoundary` | **超越**：boundary 先于 spawn 评估、失败带 `recoverable` 标记供 UI 转提示 |

## 4. 当前实现分析

**优点**
1. 领域模型极其严谨：状态机/不变式/校验全部下沉到 `@maka/core`，store 只换介质；merge 引擎带诊断而非静默覆盖——本地优先 + 多观察者下的一致性好于多数同类工具。
2. 输出安全是纵深设计：内存 tail（行边界）→ 模型预算（tail 优先）→ 脱敏（整行整 buffer）三层，且"截断不杀进程、保留可恢复尾部"直接修复了 benchmark 路径杀死进程/错误 exit code 的问题（`shell-exec.ts` 头注释）。
3. 会话泄漏防护扎实：session 纪元 + 关闭租约 + 双轮 terminate、slot 上限（64/8）、orphan 恢复、逃逸后代追杀。
4. PTY 模拟器 fail-closed：OSC 危险序列拦截、解析预算用"淘汰最旧"而非暂停（防 exit 后 socket 栅栏卡死）、输入缺口 RIS 复位、协议应答 1MB 上限。

**缺陷 / 风险**
1. **输出上限的信息损失**：PTY 模型预算仅 50KB 且 tail 优先——长滚动输出的**开头**（如编译错误、测试名）会先丢；UI 原始回放仅 16K 字符。pipes 同理只留 1MB tail。命令只打一行超大文本会被整行丢弃（有 marker，但内容不可恢复）。
2. **后台/PTY 默认无超时**：`run_in_background=true` 时 `timeoutMs` 缺省即无限（仅上限 24h）；PTY 亦如此。模型忘停 + `StopBackgroundTask` 不在子代理工具白名单（`shell-run-manager.ts` slot 拒绝文案里自述）→ 靠全局 64 槽兜底，仍有"占坑到会话关闭"的泄漏面。
3. **PTY 永远无沙箱**：`sandboxCommand` 对 PTY 直接抛错，等于把最强交互面（可键入、可 Ctrl-C、可重放）放在裸权限提示保护下；`WriteStdin` 文档自认"ordinary audited tool-call data, not a secure secret channel"，且无终端流量控制（`handleFlowControl:false`）。
4. **目录逃逸**：cwd 仅 `canonicalExistingPath` 校验；命令可任意 `cd`/读写——pipes 靠沙箱兜底，但 headless/executor 路径与 PTY 路径无沙箱；升级到 unsandboxed 只记录审计（`sandboxEscalation`）不阻断。
5. **持久化无保留策略**：SQLite 单行 `record_json` 永久保留全部终结 run，无 TTL/裁剪（`shell-run-store.ts` 无 DELETE/prune）；1MB×2 输出随会话数线性膨胀。
6. **状态机启动竞态复杂度高**：`pendingStops`/`CompletionLatch`/`sessionEpoch`/`flushInFlight` 交织，74KB 单文件可读性差；`finalizeLive` 里 bestEffort 持久化失败时 `finished.reject` 与 `notifyCompletionOwner` 的 finally 路径（`notifyCompletionOwner(live,false)` 无条件执行）有轻微"重复通知"语义风险，靠 `completionNotified` 幂等兜底。

## 5. 架构设计

**目标态（建议）**
1. **分离"执行内核"与"任务编排"**：把 `shell-run-manager.ts` 按职责拆为 `ShellRunRegistry`（存活表/slot/孤儿恢复）、`ShellRunLifecycle`（启动/终结/finalize）、`PtyControl`（WriteStdin/resize 的 cut 链）三模块，复用 `shell-exec.ts` 的"dumb core"哲学——当前单文件是唯一未遵循该哲学的例外。
2. **输出策略三档化**：pipes 增"head+tail 双窗"（如 opencode 式），PTY 预算改为"screen 全保 + scrollback tail"；给 model-facing 输出加 `truncatedAt:'head'|'tail'|'middle'` 元数据；对>1MB 后台输出提供显式 spill 到工作区文件 + Read 指引（工具描述已允许，但 `tool-output.ts` 注释刻意不用——需按场景决策）。
3. **后台任务默认超时/心跳**：后台 Bash 给宽松默认（如 30min）+ 可选 `keepalive` 心跳续期；PTY 加"空闲超时"与"最长寿命"双上限，并把 `StopBackgroundTask`/`WriteStdin` 加入子代理默认白名单。
4. **PTY 安全升级**：拒绝在 PTY 启动命令中嵌入高危险 OCS/输入（已拦截 OSC 52 等，可扩展拦截 `\x1b]` 子集）；把"PTY 会话内"权限降为"会话启动时 profile 快照 + 后续 WriteStdin 按同一 profile 复核"；对未来支持 conpty/seatbelt 组合的后端预留 `sandboxType` 透传（当前 `start()` 硬拒 argv+fdInputs+PTY）。
5. **持久化保留策略**：终结 run 设 TTL（如 7 天）或"仅保留 metadata + 末次快照"，输出大值移出 `record_json` 走独立 blob 表，避免单行 JSON 膨胀拖慢事务。
6. **可观测性**：把 `ShellRunMergeDiagnostic`、slot 拒绝、escape-descendant 追杀结果上报为结构化遥测（当前仅 `console.warn`），供"故障恢复"复盘。

## 6. 待讨论问题
- PTY 无沙箱是否为可接受的产品取舍（本地桌面 app 语境）？还是应当禁止 PTY 访问非工作区路径？
- 50KB/1MB 截断的默认值是否适配"长构建日志"场景；是否给 `Read(ref)` 增加"窗口内偏移读取"而非整快照？
- 后台无默认超时与"子代理无 stop 工具"的组合：是否应改为默认限时，靠 Read 续观察？
- `record_json` 无限增长是否构成本地存储红线；孤儿记录（`observedAt` 缺失）是否需要 GC？
- `shell-controls-copy.ts`（app 壳 i18n）与 shell 域同名但无关联——命名上是否应当重命名为 `app-shell-controls-copy` 以免误导后续维护者？
