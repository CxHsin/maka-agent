# Maka 真实核心域分析 —— 从代码实测归纳

> 用途：本目录是对 design-material 素材库其余部分的**自底向上补充**。库里其他文件是从书籍 **《深入理解 AI Agent：设计原理与工程实践》**（Deep Understanding of AI Agents）**自顶向下**提炼的；本目录则**完全从 Maka 实际代码归纳**（文件规模 + 域间依赖 + 官方文档覆盖度交叉），用于回答：*"Maka 的真实核心域是哪些？现有文档（README 四信条、ARCHITECTURE.md 八章）够不够？缺什么？"*
>
> 方法论：**不**从 README 四信条出发，也**不**预设官方 ARCHITECTURE.md 八章为权威。框架与每份域分析均由 `maka-agent` 仓库（main 分支，2026-08-08；core/runtime/headless/storage/runtime-host 合计约 70 万行 TS）的代码实测得出。
>
> 域分析统一采用六节结构：**1. 代码地图 → 2. 核心数据模型与流程 → 3. 书中要点对照 → 4. 当前实现分析 → 5. 架构设计（目标态）→ 6. 待讨论问题**。每个文件双语成对（`*.md` = 英文，`*.zh-CN.md` = 中文）。
>
> 与四信条/官方八章的关系：本套分析**比两者都全**。README 四信条只覆盖约 4 个域（evidence/compact/recovery/self-check）；官方八章覆盖系统主干，但仍缺本目录重点的"有代码无文档"空白域。

---

## 目录

| 文件 | 域 | 规模 | 分析前文档现状 |
|---|---|---|---|
| `00-real-core-domain-framework.md` | **框架**：Maka 真实有哪些核心域（从代码归纳），并实证四信条与八章都不完整 | — | — |
| `A5-permission.md` | 权限与沙箱（权限画像、执行边界、决策账本） | 47 文件 | ⚠️ 仅 onboarding 计划 |
| `A6-shell-pty.md` | Shell/PTY 执行（7 态状态机、无头 xterm、进程树终止） | 29+ 文件 | ❌ 无 |
| `D3-goal-plan.md` | Goal/Plan（带外部裁判的自主长程 Goal 循环；受控 Plan 工作流） | 37 文件 | ❌ 无 |
| `E1-connections.md` | Connections（LLM 提供商目录、凭据库、有界网络效果、MCP/WebSearch） | 42 文件 | ❌ 无 |
| `E3-swarm.md` | Swarm/子代理（Swarm Mode = Agent Graph 呈现策略 + 授权） | ~20 文件 | ⚠️ 用法文档 |
| `E4-computer-use.md` | Computer Use（AX 语义树、帧/纪元锚定、presentation fence） | 46 文件 | ⚠️ 契约类 |
| `E5-memory.md` | 记忆（MEMORY.md 本地 + 长期 item store、证据投影） | 32 文件 | ❌ 无 |
| `E6-automation.md` | 自动化/定时（durable cron + heartbeat 调度器、安全点触发） | 19 文件 | ❌ 无 |
| `E7-skill.md` | Skill（SKILL.md 目录、渐进式披露、信任框架） | 31 文件 | ⚠️ 仅 policy |

---

## 使用方法

1. **首次进入某域** → 读该域的代码地图（§1），获取文件清单、关键导出符号与分层边界。
2. **审计既有设计** → 读书中要点对照（§3），看 Maka 哪里已超越书中原则、哪里仍滞后。
3. **规划改动** → 读当前实现分析（§4）与架构设计（§5）；缺陷/风险与待讨论问题（§6）可直接当评审 checklist。
4. **交叉引用** → 框架（`00`）把每个域映射到四信条/官方八章；`agent-book-knowledge/` 目录保存分章知识点论据库。

> 范围说明：框架中的 A1–A4、B1–B4、C1–C4、D1–D2、E2、E8 及横切关注点（Runtime Event Log、上下文剪枝/压缩、恢复/续跑、Self-Check、Agent Graph、流式等）已有官方 draft，因此在框架中列出但**不**作为独立域文件重复分析。本目录 9 份域文件恰好覆盖"有代码无文档"的空白。
