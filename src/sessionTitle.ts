import { streamLLM, type LLMStreamer } from './llm.js'

const TITLE_MODEL = process.env.LLM_TITLE_MODEL?.trim() || undefined
const MAX_TITLE_CHARACTERS = 28

const SESSION_TITLE_PROMPT = `Generate a concise title that captures the main goal of this coding session.

Rules:
- Use the same language as the user.
- For Chinese, use roughly 4-12 Chinese characters when possible.
- For English, use 3-7 words in sentence case.
- Preserve important code identifiers such as task_continue or MCP.
- Describe the task; do not copy the user's full sentence.
- Do not use ending punctuation or filler words.

Return JSON with exactly one field: {"title":"..."}

Good examples:
{"title":"检查系统提示词"}
{"title":"验证审批与 Diff"}
{"title":"追踪 task_continue"}
{"title":"Fix mobile login button"}`

export async function generateSessionTitle(
  description: string,
  signal: AbortSignal,
  llmStream: LLMStreamer = streamLLM,
): Promise<string | null> {
  const input = description.trim()
  if (!input) return null

  try {
    let responseText = ''
    for await (const event of llmStream([
      { role: 'system', content: SESSION_TITLE_PROMPT },
      { role: 'user', content: input },
    ], { signal, model: TITLE_MODEL })) {
      if (event.type === 'done' && event.response.type === 'text') {
        responseText = event.response.text
      }
    }
    return normalizeSessionTitle(responseText)
  } catch {
    return null
  }
}

export function normalizeSessionTitle(value: string): string | null {
  const raw = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!raw) return null

  let title = ''
  try {
    const parsed = JSON.parse(raw) as { title?: unknown }
    if (typeof parsed.title === 'string') title = parsed.title
  } catch {
    title = raw
  }

  title = title
    .split('\n')[0]
    ?.replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[。.!！]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim() ?? ''

  if (!title) return null
  const characters = [...title]
  return characters.length > MAX_TITLE_CHARACTERS
    ? characters.slice(0, MAX_TITLE_CHARACTERS).join('')
    : title
}
