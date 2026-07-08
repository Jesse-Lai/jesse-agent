/**
 * types.ts —— 工具契约（Tool contract）
 *
 * 解决什么问题：
 *   给"什么是一个工具"定一个统一模板。不管是读文件、跑命令还是看目录，
 *   都按这个模子填。有了统一契约，loop 就能对所有工具一视同仁地调用，
 *   不用关心每个工具内部的细节——这就是解耦。
 *
 * 对应 Claude Code：
 *   对应 src/Tool.ts:362 的 Tool 类型。它有十几个字段（checkPermissions、
 *   isConcurrencySafe、maxResultSizeChars…），我们先取最核心的 4 个 +
 *   预留 isReadOnly，后续 Phase 逐步往上加。
 */

// ============================================================================
// 一、工具契约
// ============================================================================

/**
 * 一个工具（Tool）就是符合这个接口的对象。
 *
 * 4 个核心字段 + 1 个预留字段：
 * - name        工具名。模型用这个名字来调用它（如 "read_file"）。
 * - description 给【模型】看的说明书。模型靠它判断"何时/如何用这个工具"。
 *               这段文字质量，直接决定模型用得对不对——是工具最重要的部分。
 * - parameters  参数格式，用 JSON Schema 描述（模型据此生成正确的参数）。
 * - execute     真正干活的函数：收到参数 → 执行 → 返回一段文本结果。
 * - isReadOnly  预留字段：这个工具是"只读"(true) 还是"会改动东西"(false)。
 *               Step 6.5 的权限确认要用它：只读的直接放行，会改的先问用户。
 */
export interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  /** 执行工具。参数是模型给的（已按 parameters 解析成对象），返回文本结果。 */
  execute: (args: Record<string, unknown>) => Promise<string>
  /** 是否只读。true=安全（读/看），false=有副作用（写/删/跑命令）。 */
  isReadOnly: boolean
}

/**
 * JSON Schema 的极简类型。
 * 我们只用到"描述一个参数对象"这一种形态：type:'object' + 各参数属性。
 * 这正是 OpenAI 工具调用要求的参数格式。
 */
export interface JSONSchema {
  type: 'object'
  properties: Record<string, JSONSchemaProperty>
  required?: string[]
  // 索引签名：让 JSONSchema 兼容 llm.ts 里更宽松的 Record<string, unknown>，
  // 这样工具定义能直接传给 callLLM，不用做类型转换。
  [key: string]: unknown
}

/** 单个参数的描述：类型 + 给模型看的说明。 */
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
}

// ============================================================================
// 二、契约 → OpenAI 工具格式 的转换
// ============================================================================

/**
 * 把我们的 Tool 转成 OpenAI API 要求的工具定义格式。
 *
 * 为什么需要这一步：
 *   我们的 Tool 是"自己用着顺手"的形状（带 execute 这种函数，API 不认）。
 *   但发给模型时，必须转成 OpenAI 规定的 { type:'function', function:{...} }
 *   格式——只保留模型需要知道的部分（名字、说明、参数），不含 execute。
 *
 * 对应 llm.ts 里的 ToolDefinition 类型，callLLM 的 tools 参数就吃这个。
 */
export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

/** 单个工具 → OpenAI 格式。 */
export function toOpenAITool(tool: Tool): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** 一批工具 → OpenAI 格式数组（发给 callLLM 时用）。 */
export function toOpenAITools(tools: Tool[]): OpenAIToolDefinition[] {
  return tools.map(toOpenAITool)
}
