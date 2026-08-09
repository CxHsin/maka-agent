# Goal/Plan 域 · Maka 代码分析与架构设计

## 1. 代码地图

目标/规划域横跨 4 个包、约 37 个文件（核心逻辑 14 个 + 测试/接线），分层清晰：**core 只放纯类型/领域规则 → runtime 放会话内执行 → storage 放持久化 → runtime-host 放进程级协调**。

**packages/core/src（纯领域契约，无副作用）**
| 文件 | 职责 |
|---|---|
| `goal.ts` | Goal 状态枚举（9 态）、condition/reason 文本上限（500 字/1500B） |
| `plan.ts` | Plan 全量模型：Proposal/Execution/Step/Event/Store 接口、上限常量、可承载性校验 |
| `plan-reminders.ts` | PlanReminder 模型：once/recurring/cron 调度、local/bot 投递、输入规范化 |
| `daily-review.ts` | Daily Review 纯投影：本地时区日界、Summary/Totals、1/7/30 天归档契约 |

**packages/runtime/src（会话内自治执行）**
| 文件 | 职责 |
|---|---|
| `goal-state.ts` | `GoalManager`：Goal 状态机、checkpoint/controlLease（ABA 防护）、settleTurn、熔断 |
| `goal-tools.ts` | GoalSet/GoalClear/GoalStatus/GoalPause/GoalResume 五个模型工具 + 拒绝话术 |
| `goal-evaluator.ts` | CC 风格外部裁判：tool-free LLM 单次调用、30s 超时、JSON 判决 |
| `goal-continuation.ts` | `GoalContinuationCoordinator`：按 session FIFO lane 结算、续跑受理、waiting 退避、任务门 |
| `goal-turn-lifecycle.ts` | `SessionActivityRegistry` + `drainGoalTurn`：同步保留空闲会话、防止回合重叠 |
| `goal-session-close-fence.ts` | 归档/删除会话时对 Goal 续跑的一档栅栏（commit/rollback holder） |
| `goal-task-gate-policy.ts` | 每次目标受理时注入"待办未清"提示（每 goal 一次） |
| `plan-mode.ts` | Plan 协作模式：工具白名单过滤 + Plan/中断/执行三段提示词渲染 |
| `plan-tools.ts` | SubmitPlan / update_plan / cancel_plan 工具（幂等 operationId） |

**packages/storage/src**：`plan-store.ts`（SQLite 事件溯源实现）、`plan-authority.ts`、`plan-legacy-projection.ts`、`plan-reminder-store.ts`、`daily-review-authority.ts`（隐式）。
**packages/runtime-host/src/server**：`plan-coordinator.ts`（Host 层用户控制边界，`plan.query/control/turn.start`）、`daily-review-coordinator.ts`（`HostDailyReviewCoordinator`，setInterval 定时执行）。

**packages/headless/src**：**无 goal/plan 文件**。只有平行的评测域机制（`heavy-task-self-check.ts` 的 self_check_plan、`task-ledger-experiment.ts` 的 todo_write、`matrix-resume.ts` 的 planMatrixRetry）——这是 benchmark 框架自身的规划，不是交互式 goal/plan 域。

## 2. 核心数据模型与流程

**Goal（自主长程目标）** — `runtime/src/goal-state.ts`
```
GoalState { id, revision, sessionId, condition, status, iterations, maxIterations(50),
            consecutiveNoProgress, blockCap(8), tokenBudget?, tokensAtStart/Now,
            controlLease, checkpoint(id+revision) }
```
- 生命周期（Codex 启发）：`active → waiting → active → achieved/impossible/cleared/paused → stalled/budget_limited/max_iterations`（终止集见 `TERMINAL_GOAL_STATUSES`）。
- 三重熔断：`blockCap=8` 连续无进展 → stalled；`tokenBudget` 超支 → budget_limited；`maxIterations=50` → max_iterations。
- **显式声明不持久化**："a restart clears every Goal；persisted snapshots deliberately deferred"（goal-state.ts 头注）。

**Goal 自治闭环（每回合）**
```
模型调用 GoalSet(condition) → GoalManager.create(active)
→ 回合完成后 GoalContinuationCoordinator.settleRegisteredTurn（FIFO lane）
→ 外部裁判 goal-evaluator 读最近~5 条消息 → JSON 判决 {met, impossible, progress, waiting, reason}
→ met/impossible 终止；waiting 走退避定时器（5s→5min）；continue 则 admitTurn 受理新回合
→ buildContinuationPrompt(评估理由 + 无进展计数 + 任务提醒) 续跑
```
- **裁判外部化**（区别于 Codex）："The working model never judges its own completion"——防止 agent 自我合理化提前"完成"。
- 评价失败 **fail-open** 续跑，但 `evaluatorFailed` 视为中性（不推进也不重置 stall 计数），防瞬态故障误判。
- 并发防护：每 session 一个 lane，`reserveIfIdle` 同步保留空闲会话防止回合重叠；`controlLease`/`checkpoint`/`revision` 乐观并发 + ABA 防护；Goal 工具的 5 种拒绝原因（`turn_not_registered`/`coordinator_disposed`/`goal_already_armed`/`goal_not_observed`/`goal_changed`）区分"真竞态"与"注定失败"。

**Plan（受控规划）** — `core/src/plan.ts`
```
PlanProposal { proposalId, revision, supersedesProposalId, sourceExecutionId?, title, overview,
               steps(≤50, 每步 title≤30字, files≤50, complexity), risks(≤20), status }
PlanExecution { executionId, status: active/completed/cancelled/interrupted, steps(状态推进) }
PlanEvent（事件溯源）: plan_submitted → plan_revision_requested → plan_approved
                    → plan_progress_updated → plan_execution_completed/cancelled/interrupted/resumed
```
- 流程：`SubmitPlan`（pending_approval）→ 用户 `approveProposal`（expectedRevision+storeVersion 乐观并发）→ 执行期用 `update_plan` 逐步骤推进（**至多一个 in_progress**）→ completed/cancelled。执行被打断 → 用户重回 Plan 模式，新提案带 `sourceExecutionId` **replan 剩余工作**。
- 约束极其严格：plain text 拒绝 Markdown、16KB 文本上限、60KB 投影上限、`isPlanProposalLifecycleAdmissible` 用最坏情况预检、`operationFingerprint` 幂等重放。
- 执行期**禁止委托 subagent**（plan-mode.ts `renderPlanExecutionPrompt`）。

**PlanReminder / DailyReview（提醒与日程）**
- `PlanReminder`：once/recurring(daily/weekly/monthly)/cron 三型调度，local 或 bot(平台+chatId) 投递；运行记录 `triggered/blocked/failed`（blocked 因 `incognito_active` 或 `bot_delivery_unavailable`）；运行历史上限 10，最大延迟 366 天。
- `DailyReview`：纯投影（本地时区日界、DST 安全）；`HostDailyReviewCoordinator` 按 `executeTime` 定时，生成 summary/gaps/usage/code 四段并归档为 `YYYY-MM-DD-{1|7|30}d`。

**边界（与 AgentRun/TaskRun/Automation）**
- **AgentRun**：goal 回合由 `admitTurn` → `RootTurnCoordinator.startHostedExternalTransition`（runtime-host）托管；普通回合也经 `beginObservedTurn` 注册，settlement 是唯一合法结算路径。Plan 模式经 `selectCollaborationTools`（按 `classifyToolUse` 的 category）把工具集裁剪为只读。
- **TaskLedger**：模型自管的扁平任务列表（`core/task-ledger.ts`，每回合尾部重注入，上限 200）；goal 的任务门只是**advisory 文本提醒**，明确"never overrides files, tests, artifacts, or verifier evidence"。
- **Automation**（`core/automation.ts` + `automation-fire-coordinator`）：Host 级 cron 定时单次调用（可带 collaborationMode），与 Goal 的"会话内连续自治"是两套机制。
- **两套自治并存**：Plan = 工作流式（human-in-the-loop 审批、结构化步骤）；Goal = 自由式自主循环（单条件、自我续跑）。互斥仅靠 `collaborationMode: 'agent'|'plan'`（`core/collaboration.ts`）隐式保证。

## 3. 书中要点对照（《深入理解 AI Agent》）

| 书中要点 | Maka 的体现 | 评价 |
|---|---|---|
| 工作流 vs 自主 Agent | **两者都实现了**：Plan 模式 = 受控工作流（审批/步骤/中断重规划）；Goal = 自主长程 Agent（自我续跑、外部裁判）。同一 session 内互斥切换 | 双模并存，定位清晰；但两套内核未共享 |
| 长程规划与任务分解 | Plan 有显式 steps/files/complexity/risks 分解；Goal 不分解，靠逐轮裁判判断 | Plan 分解到位；Goal 无 subgoal |
| 目标澄清 | Plan 有 pending_approval→revision→abandon 的显式澄清循环；Goal 的 condition 仅 500 字自由文本，**无澄清步骤** | 目标澄清只在受控路径存在 |
| 可检查节点 / 可观测性 | `GoalManager.onChange` 观察者把每次状态迁移推给 UI（"token-burning goal must never run without a visible indicator"）；Plan 全量事件溯源 + storeVersion；GoalState immutable + revision 快照 | 强于一般实现 |
| 防"提前完成"幻觉 | 裁判外部化（CC 反模式修正）；evaluatorFailed 中性处理 | 超越 Codex 设计 |
| 熔断/预算 | blockCap / maxIterations / tokenBudget 三重终止 + waiting 退避 | 自主循环安全网完备 |

## 4. 当前实现分析

**优点**
1. **状态机工程严谨**：Goal 9 态 + 终止集 + checkpoint/revision/controlLease 乐观并发与 ABA 防护；Plan 事件溯源 + storeVersion + 幂等指纹——罕见的"生产级"自主循环实现。
2. **裁判外部化 + 失败语义细分**：工作模型不自评；超时/乱码按中性处理，防 stall 误判；fail-open 保续跑。
3. **Plan 边界约束严格**：plain-text 校验、双层字节上限、最坏情况投影预检、重规划（interrupted→sourceExecutionId→supersedes）。
4. **层次清晰**：core 纯契约 / runtime 执行 / storage 持久化 / runtime-host 协调，边界可测（每文件配套单测，含双客户端 UDS 测试）。
5. **安全网完整**：不重叠回合（SessionActivityRegistry）、会话关闭栅栏、存档回滚后自动 pause。

**缺陷 / 风险**
1. **Goal 无持久化**：重启即清空（goal-state.ts 明确自述为 deferred）——与 local-first 工作台"数据在本地、随时恢复"的定位**直接矛盾**，是最大单点缺口。
2. **Goal 无目标澄清/分解**：单层自由文本条件，无与 Task/Plan 的结构化归因；评估只读"最近~5 条消息"，长会话上下文漂移会导致裁判失准。
3. **评价质量单一来源**：一次 LLM 判断决定终止，无确定性验证交叉；evaluatorFailed 时 fail-open 继续烧 token。
4. **两套自治循环未统一**：Goal 与 Plan 执行是不同实现，`selectCollaborationTools` 依赖 `classifyToolUse` 的启发式分类，自定义工具可能被误裁。
5. **Goal↔Task↔Plan 无正式关联模型**：task-gate 只是文本注入，goal 不持有 plan/execution/task 引用；waiting 的外部事件无法由 PlanReminder/Automation 驱动唤醒，只能轮询退避（烧 token）。
6. **成本模型粗糙**：每次续跑 = 1 次工作调用 + 1 次裁判调用，仅有顶层 tokenBudget，无每轮成本监控/仪表盘。

## 5. 架构设计（目标态）

1. **Goal 持久化与恢复**：将 GoalState 改为事件溯源（GoalEvent：set/settle/pause/resume/clear…），落地 storage；复用 `goal-session-close-fence` 的 holder 模式扩展为 restart fence；重启后 snapshot+log 恢复续跑。
2. **统一自治内核**：提炼 `AutonomousLoop` 抽象（evaluator + settlement + 熔断 + 受理），Plan 执行与 Goal 都走同一内核——Plan = 有步骤约束的自治，Goal = 无约束自治，消灭两套循环。
3. **目标澄清与归因**：Goal 增加澄清步骤（condition→确认→GoalClarify 工具）；goal 持有 `taskKeys[]/planExecutionId` 引用，task-gate 从"文本提醒"升级为结构对齐（未完成任务数参与裁判上下文）。
4. **裁判升级**：多信号评估（确定性验证器结果 + 模型判断 + 证据检查）；`evaluatorFailed` 默认降级为 pause（而非 fail-open）；裁判输出写入审计事件供复盘。
5. **统一事件总线**：GoalEvent/PlanEvent/TaskLedgerChangedEvent 汇聚进 runtime-event store，供 session-recap 与 DailyReview 聚合"今日目标/计划完成度"。
6. **联动唤醒**：Goal `waiting` 状态挂接 Automation/PlanReminder 触发（外部事件到达→`wakeWaiting`），用事件驱动替代轮询退避。
7. **成本可观测**：Goal 续跑接入 usage-ledger，提供每轮成本、累计预算、剩余配额的面板（tokensAtStart 基线已具备）。

## 6. 待讨论问题

- **持久化优先级**：local-first 定位下"Goal 重启即失"是否可接受？若不可，GoalEvent 与 PlanEvent 的存储统一还是分表？
- **合一 vs 双模**：Goal 与 Plan 是否应合并为"自治谱系"（mode 参数），还是保持两套（工作流审批 vs 自由自主）以匹配不同用户心智？
- **裁判成本**：每续跑一次 LLM 判断的性价比；是否按"证据变化量"降频（无文件/测试变化则跳过裁判）？
- **评价隐私**：裁判读取"最近 5 条消息"并外发到 session 模型，是否需脱敏/本地化选项？
- **多目标资源治理**：多 session 并行 Goal 时的全局 token/成本配额（现只有单 session 的 tokenBudget）。
- **域归属**：PlanReminder / DailyReview 应归入 goal/plan 域，还是独立的 scheduling/telemetry 域？（当前分散在 core+runtime-host，文档空白面更大）

---

**核心引用锚点**：`runtime/src/goal-state.ts`（状态机/不持久化声明）、`runtime/src/goal-continuation.ts`（FIFO 结算/受理）、`runtime/src/goal-evaluator.ts`（外部裁判/中性失败）、`core/src/plan.ts`（Plan 模型/事件溯源）、`core/src/plan-reminders.ts` 与 `core/src/daily-review.ts`（提醒/日程）、`core/src/task-ledger.ts`（边界）、`runtime/src/plan-mode.ts`（工具裁剪/提示词）、`storage/src/plan-store.ts` 与 `runtime-host/src/server/plan-coordinator.ts`（持久化与 Host 协调）。
