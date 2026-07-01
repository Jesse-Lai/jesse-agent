# Claude Code 逆向工程学习计划

## 目标
通过逆向 Claude Code 源码，理解生产级 agent 的每个模块，然后在 jesse-agent 中实现简化版。

## 源码地址
https://github.com/tanbiralam/claude-code

---

## 第一轮：理解 Agentic Loop（核心中的核心）

### 学习目标
理解"用户输入 → LLM 思考 → 调工具 → 结果返回 → 继续思考 → 最终回复"的完整循环。

### 要读的文件

| 序号 | 文件 | 读什么 | 关键问题 |
|------|------|--------|----------|
| 1.1 | `src/query.ts` | 主循环入口 | while 循环在哪？退出条件是什么？ |
| 1.2 | `src/services/tools/toolOrchestration.ts` | Tool 执行编排 | 多个 tool call 怎么执行？串行还是并行？ |
| 1.3 | `src/services/tools/toolExecution.ts` | 单个 tool 的执行 | 一个 tool call 从接收到返回结果的全流程 |
| 1.4 | `src/services/tools/StreamingToolExecutor.ts` | 流式执行 | tool 执行过程中怎么实时反馈进度 |

### 阅读方法
1. 先读 `query.ts`，找到主循环（搜索 `while` 或 `loop`）
2. 画一张流程图：用户消息进来 → 经过哪些步骤 → 到 LLM → 回来 → 怎么判断下一步
3. 标注：哪些是"必须有的"，哪些是"生产级优化"

### 完成标准
- [ ] 能画出 Claude Code 的 agentic loop 流程图
- [ ] 能解释：loop 什么时候结束？什么时候继续？
- [ ] 能解释：如果 LLM 同时返回 3 个 tool call，执行顺序是什么？
- [ ] 能区分：哪些逻辑是核心 loop，哪些是错误恢复/优化

### 对应到 jesse-agent
读完后，写 `jesse-agent/src/loop.ts`（简化版，~50行）

---

## 第二轮：理解 Tool 系统

### 学习目标
理解 tool 怎么定义、注册、传给 LLM、执行、返回结果。

### 要读的文件

| 序号 | 文件 | 读什么 | 关键问题 |
|------|------|--------|----------|
| 2.1 | `src/Tool.ts` | Tool 类型定义 | 一个 tool 长什么样？有哪些字段？ |
| 2.2 | `src/tools/BashTool/BashTool.tsx` | 最核心的 tool 实现 | execute 函数怎么写？输入输出格式？ |
| 2.3 | `src/tools/BashTool/prompt.ts` | Tool 的描述/prompt | LLM 怎么知道这个 tool 能干什么？ |
| 2.4 | `src/tools/FileReadTool/FileReadTool.ts` | 简单 tool 示例 | 最简结构是什么？ |
| 2.5 | `src/tools/FileEditTool/FileEditTool.ts` | 文件编辑 tool | 怎么做精准编辑（不是覆盖整个文件）？ |
| 2.6 | `src/tools/GlobTool/GlobTool.ts` | 文件搜索 tool | 怎么在大项目里找文件？ |

### 阅读方法
1. 先读 `Tool.ts` 理解接口定义
2. 再读 `BashTool` 看一个完整实现
3. 对比 `FileReadTool`（简单）vs `BashTool`（复杂），理解 tool 的复杂度谱

### 关注点
- tool 的 `inputSchema`（JSON Schema）怎么定义
- tool 的 `execute` 函数签名
- tool 怎么返回结果给 LLM（成功 vs 失败）
- `isConcurrencySafe` — 怎么判断能不能并行

### 完成标准
- [ ] 能解释 Claude Code 的 tool 接口有哪些必要字段
- [ ] 能解释一个 tool call 从 LLM 返回到执行完毕的数据流
- [ ] 能独立写一个新 tool（不看参考）
- [ ] 理解 tool prompt 怎么影响 LLM 调用 tool 的准确性

### 对应到 jesse-agent
读完后，写 `jesse-agent/src/tools/`（3 个 tool：readFile, runCommand, listFiles）

---

## 第三轮：理解 Context 管理

### 学习目标
理解怎么管理对话上下文：system prompt 怎么组装、对话太长怎么压缩、长期记忆怎么存取。

### 要读的文件

| 序号 | 文件 | 读什么 | 关键问题 |
|------|------|--------|----------|
| 3.1 | `src/QueryEngine.ts` | 上下文组装入口 | system prompt 从哪来？怎么拼的？ |
| 3.2 | `src/utils/queryContext.ts` | system prompt 构建 | prompt 由哪些部分组成？动态还是静态？ |
| 3.3 | `src/services/compact/compact.ts` | 对话压缩 | 对话太长怎么办？压缩逻辑是什么？ |
| 3.4 | `src/services/compact/autoCompact.ts` | 自动触发压缩 | 什么时候触发压缩？阈值是多少？ |
| 3.5 | `src/services/SessionMemory/sessionMemory.ts` | 长期记忆 | 跨 session 怎么记忆？存在哪？ |
| 3.6 | `src/services/extractMemories/extractMemories.ts` | 自动提取记忆 | 怎么从对话中自动提取值得记住的信息？ |
| 3.7 | `src/utils/tokens.ts` | Token 计算 | 怎么估算消息占多少 token？ |

### 阅读方法
1. 从 `QueryEngine.ts` 开始，找到 system prompt 构建的地方
2. 跟着调用链看 `queryContext.ts` 怎么拼 prompt
3. 读 compact 相关，理解"对话太长"的应对策略
4. 读 SessionMemory，理解持久化记忆

### 关注点
- System prompt = 静态部分（身份）+ 动态部分（项目上下文、文件内容）
- Compact 的策略：摘要 vs 截断 vs 滑动窗口
- 记忆的读写时机：什么时候读记忆？什么时候写记忆？
- Token 预算：怎么确保不超 context window

### 完成标准
- [ ] 能画出 Claude Code 的 context 组装流程（哪些内容进入 system prompt）
- [ ] 能解释 auto-compact 的触发条件和执行逻辑
- [ ] 能解释 SessionMemory 的存储格式和检索方式
- [ ] 能解释 token 估算的方法

### 对应到 jesse-agent
读完后：
- 写 `jesse-agent/src/prompt.ts`（system prompt）
- 实现简单的 context window 管理（截断策略）
- 实现文件级记忆（类似 MEMORY.md）

---

## 第四轮：理解安全 & 权限

### 学习目标
理解生产级 agent 怎么防止危险操作、怎么让用户确认、怎么做权限控制。

### 要读的文件

| 序号 | 文件 | 读什么 | 关键问题 |
|------|------|--------|----------|
| 4.1 | `src/tools/BashTool/bashPermissions.ts` | Bash 权限 | 哪些命令需要确认？怎么判断？ |
| 4.2 | `src/tools/BashTool/bashSecurity.ts` | Bash 安全 | 什么命令会被拒绝？规则是什么？ |
| 4.3 | `src/tools/BashTool/destructiveCommandWarning.ts` | 危险命令检测 | 怎么检测 rm -rf 这类命令？ |
| 4.4 | `src/tools/BashTool/pathValidation.ts` | 路径校验 | 怎么防止读写不该碰的文件？ |
| 4.5 | `src/types/permissions.ts` | 权限类型定义 | 权限模式有哪几种？ |
| 4.6 | `src/utils/permissions/denialTracking.ts` | 拒绝追踪 | 用户拒绝了某操作后怎么处理？ |

### 阅读方法
1. 从 `permissions.ts` 看权限模型的整体设计
2. 读 `bashPermissions.ts` 看实际怎么判断"需不需要问用户"
3. 读 `bashSecurity.ts` 看哪些操作被硬性禁止

### 关注点
- 权限三级：自动允许 / 需要确认 / 完全禁止
- 确认机制：怎么暂停 loop 等用户确认，确认后怎么恢复
- Allowlist / Blocklist 的设计
- 沙箱（sandbox）机制

### 完成标准
- [ ] 能列出 Claude Code 的权限模式（至少 3 种）
- [ ] 能解释一个命令从"LLM 想执行"到"实际执行"经过哪些安全检查
- [ ] 能解释用户拒绝后，信息怎么反馈给 LLM
- [ ] 能设计 jesse-agent 的简单权限系统

### 对应到 jesse-agent
读完后：
- 给 `runCommand` tool 加确认机制
- 实现基本的 allowlist/blocklist
- 加 max-iterations 防无限循环

---

## 整体时间表

| 轮次 | 预计时间 | 输出 |
|------|----------|------|
| 第一轮 Loop | 2-3 小时 | 流程图 + jesse-agent 的 loop.ts |
| 第二轮 Tools | 2-3 小时 | jesse-agent 的 3 个 tool |
| 第三轮 Context | 3-4 小时 | prompt.ts + 简单 memory |
| 第四轮 Security | 2-3 小时 | 权限确认机制 |
| **总计** | **~12 小时** | 理解 Claude Code + 能跑的 jesse-agent |

---

## 学习方法建议

### 每个模块的阅读 SOP
1. **快速浏览**：看文件开头的 import 和 export，理解它依赖谁、被谁依赖
2. **找核心函数**：一般是 export 出去的主函数
3. **画调用链**：这个函数调了什么 → 那个又调了什么 → 数据怎么流动
4. **区分核心 vs 优化**：生产代码里 80% 是 edge case 处理，20% 是核心逻辑
5. **写笔记**：用自己的话总结"这个模块解决什么问题、怎么解决的"

### 区分"必须懂"vs"了解即可"
- **必须懂：** loop 的退出条件、tool 的执行流程、context 的组装顺序
- **了解即可：** streaming 细节、React/Ink UI 组件、analytics 追踪

### 边学边写
每读完一个模块，立刻在 jesse-agent 里写简化版。不要等全部读完再写。理解 ≠ 能写出来，写的时候会发现理解的漏洞。

---

## 最终验证

全部完成后，你应该能：
1. **画出** Claude Code 的完整架构图（模块间怎么连接）
2. **解释** 一条用户消息从输入到回复经过哪些步骤
3. **跑通** jesse-agent：在终端对话，agent 能自主调工具完成任务
4. **扩展** jesse-agent：独立加一个新 tool，不需要参考别人代码
5. **给别人讲** agent harness 的四层结构，每层解决什么问题
