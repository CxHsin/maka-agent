# Automation 域 · Maka 代码分析与架构设计

## 1. 代码地图

Automation 域横跨 4 个包、约 18 个 `*automation*` 文件 + cron 编译器，是 Maka 中"有代码无文档"的成熟功能域。按分层：

| 层 | 文件 | 职责 |
|---|---|---|
| **core（类型/纯函数）** | `packages/core/src/automation.ts` | 领域模型：`AutomationDefinition`、`AutomationPendingFire`、`AutomationExecutionTemplate`、`AutomationAuthoritySnapshot`；文本长度限制（code-units + UTF-8 bytes 双上限）与截断工具 |
| | `packages/core/src/cron-expression.ts` | 5 字段 cron 编译器：`compileCronExpression`（两个兼容 profile）、`nextAfter` 有界分钟扫描、`matchesCronField` 兼容入口 |
| | `packages/core/src/runtime-event.ts` | turn origin 校验：`isTurnOrigin` 支持 `kind:'automation'`（约 L729） |
| **runtime（纯逻辑/工具）** | `packages/runtime/src/automation-state.ts` | `AutomationManager`（CRUD、状态机、jitter、`computeNextCronFire`、重启 reconcile）；导出 `MAX_AUTOMATIONS_PER_SESSION=20`、`MAX_CONSECUTIVE_FAILURES=5`、`DEFAULT_EXPIRY_DAYS=7` |
| | `packages/runtime/src/automation-tools.ts` | 模型侧单一 `Automation` 工具（mode: create/delete/list/pause/resume），zod schema、丰富错误文案 |
| | `packages/runtime/src/automation-can-fire.ts` | 纯函数 fire 门控 `evaluateAutomationCanFire`（kind 感知、incognito、idle 状态集 `HEARTBEAT_IDLE_STATUSES`） |
| | `packages/runtime/src/automation-schedule-policy.ts` | 调度常量：`FIRE_CHECK_INTERVAL_MS=5000`、`DEFER_WINDOW_MS=45min` |
| **runtime-host（编排）** | `server/automation-coordinator.ts` | `HostAutomationCoordinator`：durable 权威（revision 化提交、串行 lane、快照回滚）、模型工具权限、fire 准入/推迟/失败/结算 |
| | `server/automation-fire-coordinator.ts` | `HostAutomationFireCoordinator`：5s tick 调度循环、canFire、fire 启动（cron 会话创建）、与 AgentRun 身份绑定 |
| | `server/automation-errors.ts` | `AutomationAuthorityInvariantError`（不变量违例即崩溃/排水） |
| | `protocol/automation.ts` | `automation.query` / `automation.mutate` 协议（分页、revision 变更检测、投影） |
| | `server/execution-composition.ts` | 装配：`prepareRecovery→recover→start`（L1158-1171）、residency |
| **storage（持久化）** | `storage/automation-authority.ts` | SQLite 权威：revision 乐观并发、原子 commit、关系不变量、品牌化 writer 门禁 |
| | `storage/automation-store.ts` | 旧 facade（loadAll/save/remove/sync，基于 authority 的 4 次重试 CAS） |
| | `storage/sqlite-automation-schema.ts` | 表结构 v1：`automation_authority_state`、`automation_definitions`、`automation_pending_fires` |
| **测试** | `runtime/__tests__/automation.test.ts`、`runtime-host/__tests__/{automation-coordinator,automation-protocol,automation-two-client-uds}.test.ts`、`storage/__tests__/automation-authority.test.ts` | 调度、恢复、并发、多客户端 UDS |
| **UI** | `ui/src/tool-activity/result-projection.ts` | `Automation` 工具卡片专属渲染钩子 |

## 2. 核心数据模型与流程

**数据模型**（`core/automation.ts`）：
- `AutomationKind = 'heartbeat' | 'cron'`；`AutomationStatus = 'active' | 'paused' | 'completed' | 'expired'`
- `AutomationSchedule = cron(expression) | interval(seconds) | once(delaySeconds)`
- `AutomationDefinition`：除基本字段外有 `nextFireAt / lastFireAt / fireCount / maxFires / expiresAt / lastError / consecutiveFailures / durable / deferredFireCount / execution`
- `AutomationPendingFire`：durable 执行意图（`admitted → running`），携带 `turnId / runId / userMessageId / scheduledFor / execution`，**在 canonical Run 终结时原子移除**
- `AutomationExecutionTemplate`：冻结的执行设置（cwd/projectId/backend/model/thinking/collab/orchestration），保证 cron 在创建者改配置后仍按原样执行

**核心机制**：
1. **Cron 编译**（`cron-expression.ts`）：5 字段、`automation-v1` profile（允许别名、legacy token 强转、Vixie DOM/DOW 仅双受限时 OR 语义、拒绝不可能日期、`nextMinuteRounding:'truncate'`）。搜索上界 `MAX_SEARCH_MINUTES = 8*366 天`（覆盖 2/29 最远 8 年）。**仅在主机本地时区求值**，DST 折叠时用 epoch 分钟推进防重发。
2. **调度/触发判定**：`AutomationManager.computeNextFire`（once 到点即停、interval/cron 推进下一槽位）+ jitter（recurring 延迟 10% 上限 15min；one-shot 若落在 :00/:30 提前最多 90s）。`HostAutomationFireCoordinator` 每 5s tick：`listDueAutomations(now)`（含过期清扫）→ `evaluateAutomationCanFire` → `admitFire` → 启动。
3. **调度策略**：can-fire 门控（incognito 全局阻断；cron 总是可 fire 因其开新会话；heartbeat 要求目标会话存在、非归档、idle∈{active,done,waiting_for_user}）；**45min 推迟窗口**内持续重试，超窗 `skipFire`（once 直接置为 expired）；`maxFires` 是 **attempt 上限**（attemptStarted 即计数，成功与否都算）；7 天过期；每会话 20 条、5 个活跃 heartbeat、50 条终态留存。
4. **状态持久化**（`automation-authority.ts` + schema）：全量 JSON 快照 + 单调 `revision` 乐观并发（commit 校验 expectedRevision，冲突抛不变量错误）；`commitOrRestore` 失败回滚内存态；重启 `registerAll` 调和"中断 fire"（active 且 nextFireAt=null → 预算已花则标 completed 并记录 'Interrupted on restart'，否则重新武装）。
5. **Fire 生命周期**（`automation-fire-coordinator.ts`）：`admitFire`（校验 active/到期/无 pending/推后执行模板回填）→ `ensureFireTarget`（cron 用 `automation_session_` + sha256(fireId) 确定性会话 id + fingerprint 去重）→ `executeRoot({execution:{kind:'automation'}})` → `sendMessage`（`durability:'required'`、origin=automation）→ 终态 Run 时 `settleFire` 并 `attemptSucceeded/Failed`。`assertFireRunIdentity` 强校验 Run 与会话/turn/runId/execution 一致。

**与 AgentRun/TaskRun/事件循环的边界**：Automation **不是独立执行引擎**，而是"调度器 + 消息注入器"——每次 fire 都是向现有/新建会话注入一个带 `origin:{kind:'automation'}` 的普通 UserMessage，走标准 RootTurnAdmission（`execution.kind==='automation'`）与标准 AgentRun 生命周期；结算完全依赖该 Run 的终态（completed/failed/cancelled）。协调器用单条 promise lane（`#exclusive`）串行化所有状态变更，副作用（timer、会话创建、Run 启动）全部收敛在 fire coordinator 内，两者通过窄 port `AutomationFireStateAuthority` 交互。

## 3. 书中要点对照（《深入理解 AI Agent》第四章）

| 书中概念 | Maka 对应物 | 体现/超越 |
|---|---|---|
| **事件触发工具 set_timer** | `Automation` 工具（cron/interval/once） | 直接对应：模型用单一工具参数化建定时任务；Maka 更进一步做到 **durable**（SQLite 持久化、跨重启、revision 并发）、**attempt/success 分离语义**、身份绑定 |
| **事件触发工具 monitor_shell** | `heartbeat` kind（resume 进当前会话） | 对应"会话内监控轮询"；注入 prompt 文本 `[Automation: name]\n\n...` 替代"用户在下一个消息触发" |
| **事件触发工具 connect_channel** | （无直接等价物） | Maka 侧以 turn `origin` 表达外部事件源（automation/goal/agent_graph，见 `runtime-event.ts` isTurnOrigin）；automation 是三种事件源之一，统一进入事件循环 |
| **安全点消费事件** | `HEARTBEAT_IDLE_STATUSES` + can-fire gate + 45min 推迟窗口 | **教科书式体现**：heartbeat 只在会话 `active/done/waiting_for_user` 等"安全点"注入，绝不打断 running/审查/阻塞/归档中的 turn；忙时延后而非丢弃，超窗才跳过 |
| （书中未覆盖） | 单 host 调度 + residency | **超越点**：pending/scheduled 时持有 runtime residency，宿主不会空转退出 |
| （书中未覆盖） | 事件驱动补充 | **超越点**：定时器并非逐事件驱动，而是"下次到点 + 5s 轮询"混合；`assertFireRunIdentity` + 确定性会话指纹使重启后可安全续跑，杜绝重复 fire |

一句话：Maka 把书中的"事件驱动异步 Agent + 安全点消费"落成了**事务化、可恢复、并发安全的持久化调度器**，并显式承认"事件源统一进事件循环"这一架构思想（origin 判别）。

## 4. 当前实现分析

**优点**：
- 分层极干净：core 纯类型/编译器 → runtime 纯逻辑 → storage 持久化 → runtime-host 编排，单向依赖。
- 状态与副作用分离：`AutomationManager`/authority 是可注入、可单测的纯状态机；timer/网络/会话副作用全部在 fire coordinator，测试里注入 fake timer/root 即可验证全生命周期（见 `automation-coordinator.test.ts`）。
- 一致性设计硬：revision 乐观并发 + `AutomationAuthorityInvariantError`（"发现矛盾就停"）、commit 失败回滚、`assertSnapshotRelationships` 在存储层强制 fire↔definition 不变量、fire 与 Run 身份双绑。
- 幂等与恢复路径完备：确定性 cron 会话 id、`createStableSession` 指纹去重、`registerAll` 调和中断 fire、recover 时先恢复 pending fire 再 start。
- 边界/配额/过期/失败预算均显式化（20/5/50/7 天/5 连败），语义在注释与测试中钉死。

**缺陷 / 风险**：
1. **时区**：无 per-automation IANA 时区，全部锚定主机本地时区；进程跨时区迁移会重锚定（源码注释明确"out of scope"）。`cron-expression.ts` 的 DST 处理（epoch 推进防 re-fire）说明作者意识到了但只解决了一半。
2. **休眠/唤醒**：local-first 单机场景下宿主进程睡眠/退出即停摆；到期的 fire 只能等重启后由 `nextFireAt<=now` 补跑（`listDueAutomations` 会一次性把所有积压都当成 due），可能突发"追回轰炸"，且无每 automation 的补跑策略（全补 vs 跳 vs 只补最近一次）。
3. **失败重试**：`consecutiveFailures>=5 → paused`，无指数退避/退避时长与重试分类（LLM 限流 vs 环境失败）；45min 推迟窗内只重试不记退避；失败即依赖下一 schedule，无告警/重试超时策略。
4. **精度**：5s 轮询 + 整分对齐 + 非负 jitter → cron 实际触发最多滞后约 5s+15min；对秒级任务不适用（interval 也限 ≥10s）。
5. **双协议并存**：`automation-store.ts`（旧 facade）与 `automation-authority.ts`（新权威）共存，`automation-store` 的 mutate 与权威的 fire 语义可能产生隐性竞争；属技术债。
6. **审批/权限**：cron 新会话 `permissionMode:'explore'`，无人工审批注入点；durable cron 依赖 creator 会话的 execution 模板，creator 会话被删/归档时只能"暂停+记错"，无迁移路径。
7. **可观测性**：`deferredFireCount` 只是计数；无 missed-fire、defer 时长、fire↔run 关联的审计视图。
8. 配额常量硬编码（`automation-state.ts`），无法按 host/用户配置。

## 5. 架构设计（目标态）

1. **时区**：`AutomationDefinition.timezone?: string`（IANA），cron 编译器按 zone 求值（候选实例用 `Intl`/TZ 投影），默认仍为本机时区；DST 跳变/折叠时给出"跳过或补跑"的确定性语义。
2. **唤醒式调度**：由 5s 轮询改为"精确到点 timer + 轮询兜底"；宿主侧接入 OS 级保持唤醒（macOS `beginActivity` / 桌面端注入），避免休眠丢点；可选 launchd 用户代理常驻。
3. **catch-up 策略**：`AutomationDefinition.catchUp?: 'run' | 'skip' | 'latest-only'`，重启/唤醒后按策略处理积压；缺省 `latest-only` 防轰炸。
4. **重试与告警**：失败分类 + 指数退避（上限对齐 DEFER_WINDOW）+ 退避期结束的显式通知/暂停；暴露 `missedFireCount`、`deferHistogram` 给 UI。
5. **审批/权限继承**：cron fire 复用创建会话的 permission policy 快照，或新增 `approval:'required'` 触发审批注入后再执行。
6. **收敛存储**：废弃 `automation-store.ts` facade，统一到 `automation-authority` API；把 `registerAll` 调和逻辑提升为权威层 `recover()` 的一部分。
7. **多实例预案**：以 SQLite revision CAS 为基础演进为"单写者租约 + 心跳续租"，使多 host 场景（桌面+CLI）可安全共写（当前 `writerByLease` 已是按租约品牌化，方向正确）。
8. **可观测性闭环**：fire↔AgentRun 关联审计表、UI 显示 pending/running fire、automation 运行历史页；`AutomationProjection` 已含 `firePending`，继续扩展。
9. **配置化配额**：将 20/5/50/7 天等提升为 runtime policy 可调项。

## 6. 待讨论问题

1. **时区边界**：是否需要 per-automation IANA 时区？还是维持"跟随主机"并只在文档/UI 明示？（影响 `AutomationSchedule` 类型与所有调用方，改动面大）
2. **休眠语义**：断电/睡眠后的积压 fire 采用 `run / skip / latest-only` 哪种？一次性补跑是否符合用户预期（如"每晚备份"醒来后连跑 N 次）？
3. **单写者假设**：runtime-host 在当前产品里是否保证单实例（桌面与 CLI 同开的情况）？多 host 并发写入是否要在本版本内解决？
4. **重试粒度**：LLM 临时失败与环境失败是否应走不同策略？`attemptFailed` 的 `consecutiveFailures>=5` 阈值是否需要退避而非硬停？
5. **审批注入**：cron 自动执行的 prompt 可能触发危险操作（删除/网络），是否需要在 fire 前引入人工审批/策略检查层？
6. **6 字段 cron/秒级任务**：现有 interval ≥10s 下限与 5s tick 是否满足监控场景？要不要支持秒字段 cron？
7. **heartbeat 长期会话**：`waiting_for_user` 是安全点（#639），但长期驻留的 heartbeat 是否应有生命周期上限（除 7 天过期外）？
8. **双协议清理**：`automation-store.ts` 是否有仍在消费的调用方？可安全删除还是需保留兼容？
