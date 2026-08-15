import { randomUUID } from 'node:crypto'
import { generateImage, streamLLM, streamVisualPrompt, type Message } from './llm.js'

export type QuickTaskAction = 'ask' | 'polish' | 'translate' | 'summarize' | 'screenshot' | 'image'

export interface QuickTaskInput {
  action: QuickTaskAction
  instruction?: string
  selectedText?: string
  sourceApp?: string
  imageDataURL?: string
}

export interface QuickTaskSummary {
  id: string
  action: QuickTaskAction
  title: string
  state: 'running' | 'completed' | 'failed'
  text: string
  sourceApp?: string
  createdAt: string
  completedAt?: string
  error?: string
}

export type QuickTaskEvent =
  | { type: 'task'; task: QuickTaskSummary }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; imageDataURL?: string; task: QuickTaskSummary }
  | { type: 'error'; error: string; task: QuickTaskSummary }

const MAX_RECENT_TASKS = 30
const tasks = new Map<string, QuickTaskSummary>()

export function parseQuickTaskInput(value: unknown): QuickTaskInput {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const action = readAction(body.action)
  const selectedText = readOptionalString(body.selectedText, 50_000)
  const instruction = readOptionalString(body.instruction, 4_000)
  const sourceApp = readOptionalString(body.sourceApp, 200)
  const imageDataURL = readOptionalString(body.imageDataURL, 16 * 1024 * 1024)

  if (['polish', 'translate', 'image'].includes(action) && !selectedText) {
    throw new Error(`${action} requires selectedText`)
  }
  if (action === 'summarize' && !selectedText && !imageDataURL) {
    throw new Error('summarize requires selectedText or imageDataURL')
  }
  if (action === 'screenshot' && !imageDataURL) throw new Error('screenshot requires imageDataURL')
  if (imageDataURL && !/^data:image\/(png|jpeg|webp);base64,/i.test(imageDataURL)) {
    throw new Error('imageDataURL must be a PNG, JPEG, or WebP data URL')
  }

  return { action, instruction, selectedText, sourceApp, imageDataURL }
}

export function listQuickTasks(): QuickTaskSummary[] {
  return [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function* runQuickTask(input: QuickTaskInput): AsyncGenerator<QuickTaskEvent> {
  const task: QuickTaskSummary = {
    id: randomUUID(),
    action: input.action,
    title: actionTitle(input.action),
    state: 'running',
    text: '',
    sourceApp: input.sourceApp,
    createdAt: new Date().toISOString(),
  }
  tasks.set(task.id, task)
  trimTasks()
  yield { type: 'task', task: { ...task } }

  try {
    if (input.action === 'image') {
      const image = await generateImage({ prompt: buildImagePrompt(input) })
      task.text = '配图已生成'
      task.state = 'completed'
      task.completedAt = new Date().toISOString()
      yield { type: 'done', text: task.text, imageDataURL: image.dataURL, task: { ...task } }
      return
    }

    const prompt = buildPrompt(input)
    const stream = input.imageDataURL
      ? streamVisualPrompt({
          systemPrompt: QUICK_TASK_SYSTEM_PROMPT,
          prompt,
          imageDataURL: input.imageDataURL,
        })
      : streamTextPrompt(prompt)

    for await (const text of stream) {
      task.text += text
      yield { type: 'delta', text }
    }
    if (!task.text.trim()) throw new Error('模型没有返回内容，请重试。')
    task.state = 'completed'
    task.completedAt = new Date().toISOString()
    yield { type: 'done', text: task.text, task: { ...task } }
  } catch (error) {
    task.state = 'failed'
    task.error = formatQuickTaskError(error)
    task.completedAt = new Date().toISOString()
    yield { type: 'error', error: task.error, task: { ...task } }
  }
}

async function* streamTextPrompt(prompt: string): AsyncGenerator<string> {
  const messages: Message[] = [
    { role: 'system', content: QUICK_TASK_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]
  for await (const event of streamLLM(messages, { allowTools: false })) {
    if (event.type === 'text_delta') yield event.text
  }
}

function formatQuickTaskError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    if (typeof value.message === 'string' && value.message) return value.message
    if (value.error && typeof value.error === 'object') {
      const nested = value.error as Record<string, unknown>
      if (typeof nested.message === 'string' && nested.message) return nested.message
    }
    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== '{}') return serialized.slice(0, 1_000)
    } catch {
      // Fall through to the generic message.
    }
  }
  return '快捷任务失败，请稍后重试。'
}

function buildPrompt(input: QuickTaskInput): string {
  const selected = input.selectedText?.trim()
  const instruction = input.instruction?.trim()
  switch (input.action) {
    case 'polish':
      return `润色下面这段文字，使它更清晰、自然、专业，保留原意和原语言。只输出修改后的文字。\n\n${selected}`
    case 'translate':
      return `翻译下面这段文字。中文翻译为自然英文，其他语言翻译为自然中文。保留格式，只输出译文。\n\n${selected}`
    case 'summarize':
      return selected
        ? `总结下面这段文字，保留关键事实、结论和行动项。直接输出简洁摘要。\n\n${selected}`
        : '总结截图中当前页面的可见内容，保留关键事实、结论和行动项。忽略浏览器工具栏、侧边栏和其他界面元素，直接输出简洁摘要。'
    case 'ask':
      return [
        instruction || '解释并回答与这段内容有关的关键问题。',
        selected
          ? `当前选中的内容：\n${selected}`
          : input.imageDataURL
            ? '请结合随附截图回答。'
            : '当前没有选中文字。',
      ].join('\n\n')
    case 'screenshot':
      return instruction || '分析这张截图，说明画面中的关键信息、问题和下一步建议。'
    case 'image':
      return selected ?? ''
  }
}

function buildImagePrompt(input: QuickTaskInput): string {
  const selected = input.selectedText?.trim() ?? ''
  const instruction = input.instruction?.trim()
  return [
    '生成一张可直接插入办公文档或 Notion 页面中的高质量横版配图。',
    '画面应清晰、克制、现代，主体明确，避免装饰性渐变、无意义文字、水印和品牌标识。',
    instruction ? `额外要求：${instruction}` : undefined,
    `内容依据：\n${selected}`,
  ].filter(Boolean).join('\n\n')
}

function readAction(value: unknown): QuickTaskAction {
  if (value === 'ask' || value === 'polish' || value === 'translate' || value === 'summarize' || value === 'screenshot' || value === 'image') {
    return value
  }
  throw new Error('unknown quick task action')
}

function readOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  if (text.length > maxLength) throw new Error(`value exceeds ${maxLength} characters`)
  return text
}

function actionTitle(action: QuickTaskAction): string {
  switch (action) {
    case 'ask': return '问一下'
    case 'polish': return '润色'
    case 'translate': return '翻译'
    case 'summarize': return '总结'
    case 'screenshot': return '分析截图'
    case 'image': return '生成配图'
  }
}

function trimTasks(): void {
  const oldest = [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(MAX_RECENT_TASKS)
  for (const task of oldest) tasks.delete(task.id)
}

const QUICK_TASK_SYSTEM_PROMPT = [
  '你是 Jesse Agent 的 macOS 快捷助手。',
  '直接完成当前办公任务，不调用代码工具，不描述内部过程。',
  '回答应当简洁、可直接粘贴，并严格遵守用户要求的语言和格式。',
].join('\n')
