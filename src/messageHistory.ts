import type { Message } from './llm.js'

/**
 * Remove incomplete tool-call groups before history is sent back to an LLM.
 * An interrupted run can persist the assistant call without every matching
 * tool result; both OpenAI APIs reject that history instead of starting a turn.
 */
export function sanitizeToolCallHistory(messages: Message[]): Message[] {
  const sanitized: Message[] = []

  for (let index = 0; index < messages.length;) {
    const message = messages[index]
    if (!message) {
      index += 1
      continue
    }

    if (message.role === 'tool') {
      index += 1
      continue
    }

    const toolCalls = message.role === 'assistant' ? message.tool_calls : undefined
    if (!toolCalls || toolCalls.length === 0) {
      sanitized.push(message)
      index += 1
      continue
    }

    const toolResults: Message[] = []
    let nextIndex = index + 1
    while (messages[nextIndex]?.role === 'tool') {
      toolResults.push(messages[nextIndex]!)
      nextIndex += 1
    }

    const callIds = toolCalls.map(call => call.id)
    const validCallIds = new Set(callIds.filter(Boolean))
    const resultIds = new Set(
      toolResults
        .map(result => result.tool_call_id ?? '')
        .filter(id => validCallIds.has(id)),
    )
    const isComplete = (
      validCallIds.size === toolCalls.length &&
      callIds.every(id => resultIds.has(id))
    )

    if (isComplete) {
      sanitized.push(message)
      sanitized.push(...toolResults.filter(result => validCallIds.has(result.tool_call_id ?? '')))
    }

    index = nextIndex
  }

  return sanitized
}
