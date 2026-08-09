# Swarm 域 · Maka 代码分析与架构设计

## 1. 代码地图

### 1.1 Swarm 域本体（8 个文件）
| 文件 | 角色 |
| --- | --- |
| `packages/core/src/agent-swarm.ts` | **遗留** `agent_swarm` 工具结果的投影（`projectAgentSwarmResult`：状态/启动/完成/失败/取消/artifact/duration 计数）。只读权威在子 AgentRun。 |
| `packages/core/src/swarm-command.ts` | `/swarm` 斜杠命令解析（`status` / `on`→swarm / `off`→default / 其余视为 run_once 任务），拒绝 `/swarming` 等相似词。 |
| `packages/runtime/src/swarm-mode.ts` | `renderSwarmModePrompt()`：注入给主 Agent 的 Swarm 策略提示（何时用异步 swarm、如何分片、禁止轮询、如何替换失败项、如何汇总）。 |
| `packages/runtime/src/agent-swarm-status-tool.ts` | `agent_swarm_status` 工具：把 `AgentGraphClientSnapshot` 投影为紧凑状态表（9 种 item 状态、`running/needs_attention/settled`、注意集、失败阶段）。含 `isAgentSwarmSupervisorCheckpoint` / `shouldWakeAgentSwarmSupervisor` / `renderAgentGraphSupervisorWake`（醒后提示）。 |
| `packages/core/src/__tests__/agent-swarm-result.test.ts` | 遗留结果解码/投影契约。 |
| `packages/core/src/__tests__/swarm-command.test.ts` | 命令解析。 |
| `packages/runtime/src/__tests__/agent-swarm-status-tool.test.ts` | 状态投影。 |
| `packages/runtime/src/__tests__/swarm-orchestration.test.ts` | 编排准入：`yield_agent_graph` 的 `executionSemantics: 'exclusive_step'`（独占 step，结束 turn）。 |

### 1.2 支撑域（Swarm 的真正运行时 = Agent Graph）
- 核心数据契约：`packages/core/src/agent-graph-schedule.ts`（schedule update / work / finish / claim store 接口）、`agent-graph-control.ts`（intent claim 准入）、`agent-graph-topology.ts`（operator provision，单调拓扑扩展）、`agent-graph-supervisor-wake.ts`（wake 记录）、`agent-graph-client-projection.ts`（客户端读侧投影）、`agent-graph-timeline.ts`。
- 运行时：`packages/runtime/src/stream-graph-coordinator.ts`（进程内单飞驱动）、`stream-graph-supervisor-tools.ts`（`view/update/yield_agent_graph` 三个主 Agent 控制工具）、`stream-graph-schedule-reconcile.ts`（调度对账循环）、`stream-graph-dispatch.ts` / `stream-graph-readiness.ts`（算子就绪/派发）、`stream-graph-read-model.ts`（`AgentGraphClientSnapshot`）、`agent-graph-supervisor-wake.ts`（runtime 侧醒 turn 协调器，含上下文溢出恢复）、`graph-mode.ts`。
- 编排模式：`packages/core/src/orchestration.ts`（`default/swarm/graph`，`EffectiveOrchestration`，`agentSwarmAuthorization`）。
- 子代理：`packages/core/src/subagent-settings.ts`（用户批准 preset：`subagent_id`+模型路由）、`subagent-workspace.ts`（implementation 的 git worktree 隔离租约）；`packages/runtime/src/subagent-tools.ts`（`agent_spawn/agent_list/agent_output`）、`subagent-execution.ts`（child_session 迁移兼容句柄）、`child-agent-progress.ts`（有界进度投影）、`child-agent-run-limiter.ts`（全局子运行许可池）、`agent-catalog.ts`（内置 agent 定义与受限工具集）、`configured-subagent-catalog.ts`。
- 编排/执行：`packages/core/src/agent-run.ts`（`RootExecutionDescriptor` 含 `claimed_agent_graph_intent`、`agent_graph_supervisor_wake`）、`packages/core/src/events.ts`（`agent_swarm`/`subagent` 结果 kind）、`packages/runtime/src/ai-sdk-backend.ts`（swarm 模式工具集固定、提示注入、`graph_yield` 停环）。
- 文档：`docs/agent-swarm.md`（偏用法；**描述的是遗留阻塞式 `agent_swarm` 工具**，与当前实现存在漂移，见 §4）。

## 2. 核心数据模型与流程

### 2.1 三个"编排模式"不是一个执行运行时
`orchestration.ts` 定义 `default | swarm | graph`。关键论断在 `agent-swarm-status-tool.ts` 的注释里：

> *"Supervisor wake admission is always Graph orchestration; Swarm remains the durable graph identity and presentation policy, not a second runtime."*

即：**Swarm 不是第二个执行引擎，而是 Graph 之上的一套"呈现策略 + 授权"**。`resolveEffectiveOrchestration()` 给出 `agentSwarmAuthorization: session_mode | turn_override | none`，控制主 Agent 是否被允许走异步 fan-out。

### 2.2 数据模型（全部落 SQLite，以幂等/指纹/版本为轴）
- **Schedule update**：`AgentGraphScheduleUpdateRequest`（`updateId`+`updateFingerprint`+`graphId`+`source(session/run/turn/toolCallId)`+`addWork[]+stop[]+finish?`），提交后带 `revision` 单调递增。`addWork≤32`、`instruction≤60k`、`inputIds≤64`、`resultIds≤64`。
- **Work item**：`AgentGraphScheduledWork { workId, target(agent|preset|operator), instruction, inputIds[], replaces? }`。`inputIds` 是显式输入前沿（上游 committed record id），`replaces` 用于替换失败项（`replacement_mode=replace`）。
- **Intent claim**：`AgentGraphIntentClaimRequest`（`claimId`+`intentId`+`intentFingerprint`+`readinessContextFingerprint`+`targetOperatorId/SessionId/TurnId/RunId`），在调度 revision 上条件化线性化（`claimAgentGraphIntentAtScheduleRevision`）。turn/run id 预先分配 → 重试看到同一激活而非二次启动。
- **Operator provision**：`AgentGraphOperatorProvisionRequest`（`provisionId`+`graphId`+`workId`+`agentId`+`operatorId`+`edges`），子 Session 与拓扑行同事务提交；拓扑只允许单调扩展（加 work/加边），**无删边/改线/环**。
- **Supervisor wake 记录**：`AgentGraphSupervisorWakeRecord`（`pending/running/waiting_permission/delivered/superseded/retryable_failed`，含 `attemptCount`、`currentTurnId`）。
- **客户端投影**：`AgentGraphClientProjectionStore`（graph + operator 双投影 + terminal activities + 增量投递幂等），让 UI 不重放 JSONL。`AgentGraphClientSnapshot` 携带 `orchestrationMode: 'graph'|'swarm'`。
- **状态投影（agent_swarm_status）**：`queued/running/blocked/completed/failed/aborted/cancelled/stopped/superseded`；注意集 `blocked/failed/aborted/cancelled` → `needs_attention`；全终态 → `settled`；`status!=='running'` 即 supervisor checkpoint。

### 2.3 主 Agent 调度与结果汇总流程（Swarm Mode 下的时序）
1. 用户请求进入带 `mode: 'swarm'` 的 turn，`ai-sdk-backend.ts:1592` 注入 `renderSwarmModePrompt()`；`ai-sdk-backend.ts:1456` 固定工具集 `{agent_list, update_agent_graph, yield_agent_graph, agent_swarm_status, agent_output}`（且 `agent_swarm` 已被移除，测试断言 `agent_swarm stays removed`）。
2. 主 Agent `agent_list` → 选用户批准的 `subagent_id` → 一条 `update_agent_graph(operation=add_work, add_work:[{target_kind:new_preset, subagent_id, instruction, input_ids, replacement_mode:none}])` 提交全部独立项。
3. `yield_agent_graph`（`executionSemantics:'exclusive_step'`，`recoveryMode:'replay_safe'`）：校验 schedule 未关闭、有 pending work、有在飞算子或可产生未来 checkpoint 的 reconcile，返回 `agent_graph_yielded`；`ai-sdk-backend.ts` 的 `handleAgentGraphYieldToolResult` 设 `loopStopReason='graph_yield'` 停环。**不轮询**。
4. `AgentGraphCoordinator`（`stream-graph-coordinator.ts`）单飞 reconcile：`reconcileAgentGraphSchedule` 读全部 schedule update → 计算就绪（`map`/`all_settled` 策略）→ 派生 runnable intent → 条件 claim → 派发 `runClaimedAgentGraphIntent`（`agent-run.ts` 的 `claimed_agent_graph_intent` 执行描述符）→ 子 Session 作为 **graph operator** 运行受限工具集（local_read=Read/Glob/Grep，web_research=WebSearch，implementation=Read/Glob/Grep/Write/Edit/Bash + worktree 隔离）。子 Session 永不获得 `update_agent_graph/yield/agent_swarm_status` 控制面 → **批次不可嵌套**。
5. 子运行产生 committed RuntimeEvents → 客户端投影增量推进 → 到达 swarm checkpoint（`agent-swarm-status-tool.ts` 的 `isAgentSwarmSupervisorCheckpoint`）→ `AgentGraphSupervisorWakeCoordinator`（runtime 版 `agent-graph-supervisor-wake.ts`）在 SQLite 落 wake、起 `agent_graph_supervisor_wake` 新 supervisor turn（带 `startTurn` 活动租约、3 次投递尝试、上下文溢出时 `recoverAgentGraphSupervisorContextOverflow`）。
6. 醒来的 supervisor 只准用 `agent_swarm_status` 看紧凑状态，用 `agent_output(view=result)` 读 committed 终结果；失败项用 `update_agent_graph(replaces=<failed workId>, replacement_mode=replace)` 替换，不让 swarm 停在 `needs_attention`；全部有用工作 settled 后 `update_agent_graph(finish, result_ids=[committed record ids])`（`assertFinishResultsCommitted` 强制 result 必须是已提交记录），主 Agent 去重、校验、语义综合后向用户汇报。

### 2.4 与协作工具（agent_spawn / agent_swarm / Agent Team / Rive）的边界
`docs/agent-swarm.md` 的选型表给出了官方边界：
- 小任务/紧耦合 → 主 Agent 直做；单专家结果/依赖前序 → `agent_spawn` 顺序；多个有限独立项+一次综合 → **swarm**；需持久所有权/任务认领/worker 通信 → **Agent Team**（角色+信箱+Task Ledger）；根会话监督的动态依赖子工作 → **Agent Graph**；需显式工作流恢复/分布式 → **Rive**。
- 子代理工具链共享 `ChildAgentRunLimiter`（`child-agent-run-limiter.ts`）的**同一真实子运行预算池**：`agent_spawn` 与 swarm 都从同一许可池取"真实执行"，且与"工具准入（model 一次能开几个子代理调用）"和"批内本地并发（swarm 默认 3、上限 32）"构成三层可观测并发边界。
- `agent_spawn` 是**阻塞前台**单子任务（结果含 `summary`+artifact 引用，`child-agent-progress.ts` 做有界进度投影）；Agent Graph/swarm 是**异步持久**调度。两者共享子 Session 执行底座（`subagent-execution.ts` 的 `child_session` 句柄）与 preset 解析（`subagent-settings.ts` + `configured-subagent-catalog.ts`）。

## 3. 书中要点对照

### 3.1 上下文共享 vs 不共享 —— **强烈不共享 + 结构化前沿（体现并超越）**
- 书中：共享上下文降低重复但放大干扰与成本；不共享保真但需显式传递。Maka 选择了"**不共享 + 显式前沿**"的极端：内置 agent 契约 `context: AGENT_CONTEXT_ISOLATED`（`agent-catalog.ts`），子 Session 完全独立。
- 超越点：跨工作共享不是"把上一份总结粘进下一条指令"，而是 **committed record id 前沿**（`input_ids` → `hydrateAgentGraphInputHandoffs` 生成带源链接的 operator handoff），消息是结构化记录而非自由文本。

### 3.2 对等 / 管理者 / 去中心化拓扑 —— **严格"管理者(旁路) + 确定性调度"**
- 书中：三种拓扑各有取舍（对等=鲁棒但难收敛，管理者=清晰但单点，去中心化=可扩展但难审计）。Maka 是**管理者拓扑的硬化版**：主 Agent 是"**beside the data path**"的 supervisor（`stream-graph-dispatch.ts`：observer 回调"the driver never awaits these callbacks … supervision stays beside the graph instead of becoming a data-path gate"）。
- 特点：算子之间**没有对等信箱**（那是 Agent Team 的职责）；工作流转完全由调度器用 map/all_settled 就绪策略驱动；拓扑单调扩展禁止环。这解决了管理者拓扑的"不可审计/不可重放"弱点，但牺牲了对等拓扑的弹性（见 §4）。

### 3.3 结构化摘要 vs 全量轨迹 —— **贯穿全链路的"有界摘要投影"（超越）**
- 书中：为省上下文应传摘要而非全量轨迹。Maka 把它做成了**系统不变量**而非提示词建议：`agent_swarm_status`"omits child logs, tool activity, reasoning, and partial output"；`agent_output view=result` 只读 committed 终结果；`child-agent-progress` 事件/字符双预算（64/8k，批 128/16k）；文档断言"presentation never copies child prompts, tool arguments, or raw child tool output"。UI/CLI 都只有聚合计数 + 有界行。

### 3.4 预算感知 —— **多维度（部分体现/部分超越）**
- 超越：共享子运行许可池（`ChildAgentRunLimiter`，abort-aware FIFO）、批内并发上限 32、provider 速率限制自适应退避（5 项起步 +700ms 补位 + 3/6/12s 重试 + 容量阶梯恢复）、工具结果归档与列表截断（`AGENT_LIST_MAX_RESPONSE_CHARS`）、进度/事件/字符预算、supervisor **上下文溢出恢复**（`recoverAgentGraphSupervisorContextOverflow` 激进压缩）。
- 缺失：**没有全局 token/花费/预算/截止时间**；限速是"batch-local & reactive"，文档明确它不是 provider 全局 RPM/TPM 控制器，也不跨会话/进程协调（`child-agent-run-limiter` 是进程内对象）。即"资源预算"局部化，"财务/时间预算"不存在。

### 3.5 级联终止 —— **结构化并发式取消（体现且严谨）**
- 书中：一个子任务失败/取消应在拓扑上传播，避免孤儿。Maka：父取消会"signal active children, prevent locally queued items from starting, join active work, return explicit cancelled rows for started and never-started items"（`docs/agent-swarm.md`）；swarm 状态含 `aborted/cancelled/stopped/superseded`；Graph `stop()` 递归停已知算子并收集 `stopGeneration`/`driveGeneration` 竞态；限速重试在父取消下仍由共享许可池兜底。
- 值得注意：`yield_agent_graph` 的"级联"方向相反——**supervisor 自愿挂起**，靠持久 wake 记录在进程重启后恢复（`recoverAgentGraphSupervisorWakes`），这是书里较少展开的"异步级联唤醒"。

### 3.6 错误放大 —— **隔离 + 明确替换协议（体现，但综合环节仍依赖提示纪律）**
- 书中：多智能体让错误沿链路放大，需隔离、可追溯、人工/自校验。Maka：部分子项失败**不抹掉成功兄弟**（partial settled）；每个 work 有 `failurePhase: schedule|topology|stop|render|dispatch` + `failureReason`；`reconciliationFailures` 进入 `needs_attention` 并触发 supervisor wake；失败项用 `replaces` 显式替换（`replacement_mode=replace`），替换后 `superseded` 终结旧项。
- 缺口：**替换是"监督者手动决定"，没有自动 retry-with-cap/降级协议**（遗留 `agent_swarm` 文档里的 RateLimit 自动重试，在 Graph 版里由谁做？当前 Graph 派发失败落在 `reconciliationFailures` 等 supervisor 决策）。且最终"去重/校验/综合"完全依赖 prompt 里的"finish 前语义综合"，无强校验步骤（只有 result_ids 必须指向 committed record 这一条硬约束）。

## 4. 当前实现分析

### 4.1 优点
1. **持久性把"监督"变成可恢复状态机**：schedule/claim/provision/wake 全部 SQLite + 指纹幂等 + revision 线性化；coordinator 是"无状态单飞驱动器"，进程重建安全（`AgentGraphCoordinator` 注释：durable rows remain the recovery authority）。
2. **职责分离干净**：Graph=持久调度权威，AgentRun/RuntimeEvent=子生命周期权威，client projection=呈现权威；`agent_swarm_status`/`agent_swarm` 都只是"有界投影"，不复制权威数据。
3. **控制面与数据面解耦**：supervisor observer 永不成为数据路径门；`update_agent_graph` 只写 intent，reconciler 才动 runtime；主 Agent"旁路"不会阻塞子执行。
4. **安全默认值**：子 Session 拿不到图控制面（不可嵌套）、preset 必须用户批准、`subagent_id` 冻结连接/模型/thinking 到子 Session、root-supervisor 归属校验（`assertScheduleOwnedByRoot`）、worktree 隔离（implementation 写不出主工作区）。
5. **异步收益落地**：yield→wake 闭环（`exclusive_step` + 持久 wake + 投递重试 + 上下文溢出恢复）让长尾任务不占前台。

### 4.2 缺陷 / 风险
1. **文档与实现漂移（最直接）**：`docs/agent-swarm.md` 通篇描述遗留阻塞式 `agent_swarm` 工具（`agent_swarm({items, max_concurrency})`、resume_run_ids、provider backpressure），而当前运行时已移除该工具（`deferred-tools-backend.test.ts` 断言 `agent_swarm removed`），现役是"Swarm Mode = Graph + 呈现策略"。`events.ts`/`agent-swarm.ts`/conversation-copy 仍保留 `agent_swarm` 结果 kind 作兼容投影。两套心智模型并存。
2. **体量/复杂度陡峭**：Graph 域 15+ 个 stream-graph 文件 + 大量 schema 版本与指纹校验；为"有界呈现"付出的架构税很高，新人入门成本大；8 个"swarm 文件"其实只是冰山一角。
3. **supervisor 上下文随唤醒次数线性增长**：每个 wake 都是同一根 Session 的一个新 turn，虽然 `agent_swarm_status` 紧凑、且 context overflow 有恢复，但**没有"跨 wake 的监督简报压缩"**——大量已 settled 子结果会长期占用根会话上下文。
4. **错误放大在"综合"环节仍靠提示纪律**：失败替换（replaces）、去重、语义综合都是 prompt 建议，不是强制流程；模型若不遵守"不读子日志、不轮询"，运行时没有硬性阻断（只有工具能力边界）。
5. **无全局预算**：缺整个 swarm 的 token/花费/步数/截止时间硬预算；共享子运行许可池是进程内单机，跨会话/跨进程无协调。
6. **拓扑表达能力受限**：单调扩展、无任意删边/改线/环，遇到"依赖方向判断错误需重排"只能靠 replace + 新 work 的补偿路径，容易产生重复执行与膨胀的 work 列表。
7. **swarm 与 graph 语义边界模糊**：`orchestrationMode` 在 `swarm` 与 `graph` 间切换时，`requiredOrchestrationTools` 只差 `agent_list` 与 `view_agent_graph`，其余完全一致；"swarm 到底是不是 graph 的别名"没有一个清晰文档化的分界判据。

## 5. 架构设计（目标态）

**总原则：把"Swarm"收敛为"Agent Graph 的一个受控呈现/授权策略"，消灭双模型，并把目前靠提示纪律保证的部分变成可验证的机制。**

1. **统一文档与模型**：`docs/agent-swarm.md` 重写为基于 `update_agent_graph / yield_agent_graph / agent_swarm_status` 的现役协议；`agent_swarm` 结果 kind 降级为只读兼容投影并在 v2 移除；明确一份判定表：何时 `swarm`、何时 `graph`、何时直接做。

2. **监督简报（supervisor briefing）机制**：为每个 wake 生成一个**持久化、幂等的"swarm 简报记录"**（聚合计数 + 每个 settled 项的 `recordId` + 需注意项列表 + 上次简报以来的增量），新 wake turn 只注入简报而非整段历史；把 `agent_swarm_status` 的紧凑性升级为**跨 turn 上下文压缩策略**（配合现有 `recoverAgentGraphSupervisorContextOverflow`）。

3. **硬预算层**：在 `AgentGraphCoordinator` 增加 swarm 级 `budget { maxTokenEstimate | maxSteps | maxCost | deadline }`，随 `update_agent_graph` 传入、随 snapshot 暴露；超限时自动进入 `stopped` 并醒 supervisor 决策（继续/降级/失败），不再依赖模型自觉。

4. **错误恢复协议化**：把"失败项处置"从提示词升级为确定性决策：`reconciliationFailures` 带上建议动作（`retry_once` / `replace` / `fallback_profile` / `stop_branch`）；提供 `recover_agent_graph` 工具或让 `update_agent_graph` 的 `replaces` 支持 `replacement_mode: retry`（保留失败 run 为证据、生成 `retriedFromRunId` 链，复用遗留 agent_swarm 的限速重试逻辑）。

5. **综合校验闭环**：`finish` 前增加可选 `verification` 阶段——要求 result_ids 对应的记录满足一组断言（如 cross-check 项）或由 supervisor 显式声明 `verified: false` 时走 `replaces`；把"去重/校验/综合"变成带状态的 graph 阶段而非纯自由文本。

6. **拓扑增强（渐进）**：允许在受限语义下添加"反向依赖修正"（supervisor 显式 `supersede` 一组 work 并原子 `add_work` 替代，重排不产生孤儿）；为对等协作需求预留 operator→operator 的**记录级消息边**（复用现有 handoff，不引入信箱运行时），使 Maka 可覆盖书中"对等拓扑"类场景而不丢失审计。

7. **可观测性**：为每次 wake/reconcile/替换/恢复输出结构化诊断（已有 `AgentGraphSupervisorWakeDiagnostic` 雏形），加"收敛度量"（每轮增量 settled 数、attention 停留时长、替换次数），让 swarm 是否空转可被监测与告警。

## 6. 待讨论问题

1. **Swarm 的定位**：应明确"Swarm = Graph 呈现策略 + 授权"这一论断是否长期成立，还是未来给 Swarm 一个独立（更薄）的执行模型？（当前代码注释已倾向前者）
2. **遗留 `agent_swarm` 工具**：是彻底移除（含 `events.ts` kind 与 UI 投影），还是保留为"阻塞前台小批量"的轻量快捷方式？两套契约（阻塞 vs 异步）并存是否有价值？
3. **supervisor 长时运行**：多次 wake 的根会话上下文增长如何治理——是"简报注入"，还是"监督会话定期快照/归档子结果"？权限等待（`waiting_permission`）跨 turn 的用户响应流如何与 wake 共存？
4. **预算与授权**：异步 fan-out 的成本失控边界在哪？`agentSwarmAuthorization: turn_override` 的语义粒度是否够（按会话/按请求/按金额）？
5. **模型纪律 vs 强制**：对"不轮询、不读子日志、不制造重复工作"，哪些该用能力边界硬性阻断（如 `yield` 后同 turn 禁止再调 `view_agent_graph`），哪些只能靠 prompt？（当前只有 `exclusive_step` 一个硬点）
6. **跨进程/跨会话协调**：`ChildAgentRunLimiter` 与限速退避都是进程内局部；多窗口/多进程共享算力时是否需要集中式许可/配额服务？
7. **错误恢复策略**：失败项的自动重试（带退避）应放哪一层——Graph reconciler（确定性）还是 supervisor（智能决策）？二者如何分工避免"错误放大"与"死等"？
8. **拓扑自由度**：单调扩展的限制是刻意简化还是临时约束？多轮依赖修正（重排 DAG）是否值得引入更丰富的拓扑操作，代价是对账复杂度上升。
