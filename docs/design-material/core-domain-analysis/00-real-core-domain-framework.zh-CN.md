# Maka 代码分析 · 架构设计 —— 真实核心域框架（从代码归纳）

> 方法论说明：**不**从 README 四信条出发，也**不**预设官方 ARCHITECTURE.md 八章为权威。
> 本框架完全由代码实测归纳（文件规模 + 域间依赖 + 官方文档覆盖度交叉）得出，用于回答：
> "Maka 的真实核心域是哪些？现有文档（README 四信条、ARCHITECTURE.md 八章）够不够？缺什么？"
>
> 数据基准：2026-08-08 · 源码本仓库（`maka-agent`，main 分支）
> 规模：core 221 文件/78k 行 · runtime 486 文件/245k 行 · headless 227 文件/107k 行 · storage 197 文件/83k 行 · runtime-host 254 文件/116k 行（合计约 70 万行 TS）

---

## 一、为什么 README 四信条不是第一性原理

README 的 4 条信条是**面向用户/市场的外显承诺**，不是代码的完整归纳。证据：

| 代码域 | 文件数 | README 四信条 | ARCHITECTURE.md 八章 | 独立架构文档 |
|---|---|---|---|---|
| tool 工具系统 | 115 | 部分（手脚） | 隐式 | ✅ draft |
| graph 执行图调度 | 54 | **未提及** | ✅ 第 7 章 | ✅ draft |
| permission 权限 | 47 | 未提及 | 隐式 | ⚠️ 仅 onboarding 计划 |
| computer-use | 46 | 未提及 | 未提及 | ⚠️ 6 篇契约类 |
| connections 连接 | 42 | 未提及 | 未提及 | ❌ **无** |
| goal/plan 目标规划 | 37 | 未提及 | 未提及 | ❌ **无** |
| memory 记忆 | 32 | 未提及 | 未提及 | ❌ **无** |
| skill 技能 | 31 | 未提及 | 未提及 | ⚠️ 仅 1 篇 policy |
| shell/pty 执行 | 29 | 未提及 | 未提及 | ❌ **无** |
| evidence 事件/证据 | 30 | ✅ 信条 1 | ✅ 第 1/2/8 章 | ✅ draft |
| stream 流式 | 28 | 未提及 | 未提及 | ⚠️ 1 篇 transport |
| automation 自动化/定时 | 19 | 未提及 | 未提及 | ❌ **无** |
| swarm 子代理 | 8 | 未提及 | 未提及 | ⚠️ 1 篇用法 |

**结论**：
1. **四信条只覆盖了 ~4 个域（evidence / compact / recovery / self-check），是真实核心域的一个子集，且已部分过时**（官方八章已把"Feedback is not fact authority"演进为"Self-Check Is Not Self-Trust"，并新增了四信条完全没有的 Graph、AHE 两域）。
2. **官方八章也不够**：它覆盖了系统主干（spine），但 **connections、goal/plan、memory、shell/pty、automation 五个域各有 19–42 个实现文件却没有一篇独立架构文档**；permission（47 文件，第二大域）缺架构级设计。
3. 因此"真实核心域"必须从代码归纳，且应**比 README 四信条更全、比官方八章更完整**。

---

## 二、从代码归纳的真实核心域框架（草案 v0）

按"代码拓扑"而非文档叙事组织。每个域给出：代码位置、规模、现状、缺口。

### A. 执行内核层（Agent 到底怎么跑）

| 域 | 代码锚点 | 规模 | 现状 |
|---|---|---|---|
| A1 事件日志（Runtime Event Log） | `runtime-event-*.ts`, `canonical-runtime-event.ts`, `events.ts`, `runtime-event-store.ts`, `runtime-event-read-model.ts` | ~30 文件 | 有 draft |
| A2 AgentRun 生命周期 | `agent-run.ts`（1902 行） | 大 | 部分 draft |
| A3 模型适配 / 多 Provider | `ai-sdk-backend.ts`, `openai-*`, `model-*`, `provider-*` | 大 | 零散 |
| A4 工具系统 | `builtin-tools.ts`, `tool-catalog.ts`, `tool-*.ts` | 115 文件 | 有 draft |
| A5 权限与沙箱 | `permission*.ts`, `runtime-policy.ts`, `sandbox-boundary.ts` | 47 文件 | ⚠️ 缺架构设计 |
| A6 执行（shell/pty/文件） | `shell-run*.ts`, `pty-*`, `file-*`, `edit-replace.ts` | 29+ 文件 | ❌ 无文档 |

### B. 上下文层（模型看到什么）

| 域 | 代码锚点 | 规模 | 现状 |
|---|---|---|---|
| B1 上下文预算 | `context-budget*.ts` | ~10 文件 | 部分 |
| B2 工具结果剪枝（证据先于压缩） | `active-tool-result-prune.ts`, `tool-result-archive*.ts` | ~8 文件 | ✅ draft |
| B3 压缩即投影 | `ai-sdk-compaction*.ts`, `active-full-compact*.ts` | ~12 文件 | ✅ draft |
| B4 状态栏 / 上下文注入 | `system-prompt/`, `status-*` | 待核实 | 待核实 |

### C. 持久与恢复层（任务超越 Turn）

| 域 | 代码锚点 | 规模 | 现状 |
|---|---|---|---|
| C1 持久任务循环 | `autonomous-agent-loop.ts`, `task-runner*` | 大 | ✅ draft |
| C2 崩溃恢复/续跑 | `agent-run-recovery.ts`, `continuation-*.ts`, `runtime-recovery*` | ~20 文件 | ✅ draft |
| C3 幂等 / 副作用恢复 | `tool-recovery-*.ts`, `tool-recovery-fact.ts` | ~6 文件 | 部分 |
| C4 工作区/产物 | `workspace*.ts`, `artifacts.ts` | 中等 | 部分 |

### D. 自我验证与进化层

| 域 | 代码锚点 | 规模 | 现状 |
|---|---|---|---|
| D1 Self-Check | `heavy-task-self-check*.ts`, `task-self-check-evidence.ts` | ~8 文件 | ✅ draft |
| D2 AHE 外环进化 | `ahe-target-protocol.ts`, `ahe-evidence-export.ts` | 中等 | ✅ draft |
| D3 目标/规划（goal） | `goal*.ts`, `plan*.ts` | 37 文件 | ❌ 无文档 |

### E. 接入与协作层（Maka 与世界的接口）

| 域 | 代码锚点 | 规模 | 现状 |
|---|---|---|---|
| E1 connections 连接 | `connections.ts`, `connection-*.ts`, `web-search*.ts`, `mcp*.ts` | 42 文件 | ❌ 无文档 |
| E2 Agent Graph 调度 | `agent-graph-*.ts`（core+runtime） | 54 文件 | ✅ draft |
| E3 Swarm/子代理 | `agent-swarm*.ts`, `child-agent-*`, `subagent-*` | ~20 文件 | ⚠️ 用法文档 |
| E4 Computer Use | `computer-use*.ts`, `cua-*` | 46 文件 | ⚠️ 契约类 |
| E5 记忆（memory） | `memory*.ts`, `local-memory.ts`, `long-term-memory.ts` | 32 文件 | ❌ 无文档 |
| E6 自动化/定时 | `automation*.ts`, `cron-expression.ts` | 19 文件 | ❌ 无文档 |
| E7 Skill 技能 | `skill*.ts`, `bundled-skill-catalog*` | 31 文件 | ⚠️ 仅 policy |
| E8 流式 | `stream-*` | 28 文件 | ⚠️ 1 篇 transport |

### F. 横切关注点

- 遥测/用量：`telemetry/`, `usage-*`, `model-call-usage-*`
- 会话/UI 投影：`session*.ts`, `session-send-projection.ts`, UI read models
- 隐私/脱敏：`redaction.ts`, `display-redaction.ts`, `incognito.ts`, `text-sanitize.ts`
- 沙箱/隔离边界：`sandbox*.ts`, `runtime-boundary.ts`, `sandbox-boundary.ts`

---

## 三、结论：现有架构文档 "不够" 的实证

1. **README 四信条**：只覆盖 A1/A2/B2/B3/C1/C2/D1，且表述过时（无 Graph、无 AHE、无 connections/memory/goal/automation）。
2. **ARCHITECTURE.md 八章**：比四信条全（补了 Graph、AHE），但仍缺：
   - **connections（42 文件）**——Maka 的"眼睛/接入"层，无任何架构文档
   - **goal/plan（37 文件）**——无文档
   - **memory（32 文件）**——无文档
   - **shell/pty 执行（29 文件）**——无文档
   - **automation（19 文件）**——无文档
   - **permission（47 文件）**——只有 onboarding 计划，无架构级权限模型/沙箱设计
   - **computer-use（46 文件）**——有 6 篇契约但无整体架构
3. **这 6-7 个"有代码无文档"的域，正是 Maka 架构设计的真实空白**，也是本次分析+设计工作的重点。

---

## 四、下一步

按此框架逐域产出 `domains/<Dx-域>/*.md`：
1. **代码地图**：该域所有实现文件 + 关键导出符号 + 依赖
2. **书中要点对照**：Agent Book 对应知识点（KP-xx）如何在此域体现/被超越
3. **当前实现分析**：架构模式、优点、已知缺陷
4. **架构设计**：目标态设计、与现状的 gap、改进建议

首期优先 A5（权限）、E1（connections）、E5（memory）、D3（goal）、E6（automation）——即"有代码无文档"的空白域。
