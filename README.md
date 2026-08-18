# Hermit（小寄）— 基于 DSH 的多模态交互中枢

> 实现地基：DeepSeek Harness（DSH）插件组合。方向见 `23-基于DSH重构方案`，执行计划见 `24-基于DSH重构的执行计划`（均在 Knowledge vault `Research/Output/Hermit/`）。

## 定位

常驻用户侧的多模态交互中枢：PC 桌宠 + 移动端语音助手，**前台永不阻塞**、异步执行、自然插入汇报。寄居蟹住在壳里——**DSH 就是壳**。

## 包分解（对应 24 §3.1）

| 包 | 职责 |
|---|---|
| hermit-persona | 人格段（角色卡 + 措辞铁律 + 记忆渲染 SystemPrompt.section） |
| hermit-core | Director/Arbiter/Task 状态机 + dispatch_task tool |
| hermit-budget | BudgetService（credit 双闸 + tokenMeter + ledger） |
| hermit-permission | PermissionService（五级 + 确认链 + audit） |
| hermit-memory | MemoryHub（M0~M5 + storage.domain） |
| hermit-executors | tool：llama.cpp 本地 / DeepSeek·Kimi 云端 / 外部框架 CLI |
| hermit-client-pet | client：dsh-pet 人格化扩展 |

## 状态

**D0 骨架日**——目录与 bundle 契约就位，逐包实现见 24 §三。
