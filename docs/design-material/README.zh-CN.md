# Maka 设计文档素材库 —— 源自《深入理解 AI Agent》

> 用途：把开源书 **《深入理解 AI Agent：设计原理与工程实践》**（bojieli/ai-agent-book，Apache-2.0）的精华提取为 **知识点 + 设计点 + 可讨论问题 + 建议设计文档**，用于完善 Maka（local-first AI Agent 工作台）的文档与设计文档体系。
>
> 提取方式：agent_swarm 并行提取（11 个只读 worker 分章精读，逐页读全书正文），再经本目录组织成可直接复用的素材。
>
> 数据日期：2026-08-08 · 来源书籍：[bojieli/ai-agent-book](https://github.com/bojieli/ai-agent-book)（Apache-2.0，main 分支）

---

## 目录

| 文件 | 内容 |
|---|---|
| `agent-book-knowledge/` | 分章知识点（11 个文件，每个知识点含：核心 / 设计要点 / Maka 启示 / 可讨论问题 / 建议设计文档，并附本章金句、配套实验、思考题）。作为设计文档的论据库 |
| `01-Maka-Design-Question-Checklist.zh-CN.md` | **精华版**：只收与 Agent Harness 本身相关的 68 个核心设计问题，按 Maka 四信条组织，可直接用于评审与需求澄清 |
| `02-Maka-Design-Doc-Roadmap.zh-CN.md` | **精华版**：只收 Harness 核心的设计文档（64 篇），含 P0/P1/P2 优先级与执行顺序 |
| `README.zh-CN.md` | 本索引 + 全书脉络 + 与 Maka 四信条的映射（中文版） |

---

## 全书脉络（10 章 + 引言 + 后记）

**核心公式：Agent = LLM + 上下文 + 工具**（大脑 + 眼睛 + 手脚；Policy + Observation Space + Action Space）。

全书四层结构：
1. **构建**（第 1-5 章）：基础知识 → 上下文工程 → 记忆与知识库 → 工具 → Coding Agent/代码生成
2. **评估与进化**（第 6-8 章）：评估 → 模型后训练 → 持续进化
3. **交互与协作**（第 9-10 章）：多模态与实时交互 → 多 Agent 协作
4. **后记**：两朵乌云（实时流式交互、从成败中持续积累经验）+ 模型与 Agent 共同演进

---

## Maka 四信条 ←→ 全书核心原则映射（可直接写进 Maka 设计文档引言）

| Maka 信条 | 书中对应原则 | 最强支撑章节 |
|---|---|---|
| **Log is the Runtime**（模型消息/工具调用/结果/终止事实入日志，会话/UI/上下文/恢复都是日志投影） | ReAct 循环的"轨迹"、事件驱动架构的事件流、WAL+检查点、可重放轨迹日志 | 第 1、2、4、6、7、10 章 |
| **Context is not history**（剪枝/Compaction 改变"下一次推理看到什么"，不丢已记录证据） | 静态前缀 + 轨迹；压缩是"把需思考的结论变成可检索知识"；"保留已记录证据、只改变投影"；隔离优于压缩 | 第 2、3、5、8 章 |
| **A task may outlive a Turn**（TaskRun/预算/continuation 支撑持久任务） | 事件循环在安全点恢复、异步打断五规则、快慢解耦、WAL+幂等键恢复 | 第 4、9、10 章 |
| **Feedback is not fact authority**（自检产生证据+一次有界修复机会，不自动成为系统事实） | "模型可以提出'完成'，但不能批准自己的'完成'"；承诺—行动一致性；RLVP"奖励结果、约束过程"；世界模型"预测≠事实"；拜占庭故障视角 | 第 1、5、6、7、8、9、10 章 |

---

## 三问锚点（后记，永不过时）

**看到什么、能做什么、如何验证做得对不对** —— 这三个问题描述的是智能系统与世界交互的基本方式，而非某个模型的用法。Maka 的四信条正是这三问的工程化回答；设计文档应把信条挂回这三问，使其不随具体模型 API 翻篇。

---

## 如何用这份素材库

1. **写某一篇设计文档** → 在 `01-Maka-Design-Question-Checklist.zh-CN.md` 找到对应信条/域的问题做需求澄清；在 `agent-book-knowledge/` 对应章找知识点做论据（每个知识点都带"Maka 设计启示"与"可写设计文档"建议）。
2. **做设计评审** → 直接拿 `01-Maka-Design-Question-Checklist.zh-CN.md`（68 题）当评审 checklist。
3. **规划下一批设计文档** → 看 `02-Maka-Design-Doc-Roadmap.zh-CN.md`，按 P0/P1/P2 顺序挑主题。
4. **验证 Maka 已有设计**（Runtime Event Log、Tool Result 剪枝、LLM Compaction、Self-check、预算/continuation、eval）→ 对照各章"Maka 设计启示"，看是否覆盖书中原则。

> 说明：`01`、`02` 已收敛为 Agent Harness 核心；`agent-book-knowledge/` 保留全书知识点，供按需查阅（含记忆知识库、多模态、后训练等非 Harness 主线的内容）。
