/**
 * compaction.ts - structured context compaction (Phase 5 / Step 14)
 *
 * Long coding sessions cannot keep sending the full messages[] array forever.
 * This module turns older messages into one structured work summary, then keeps
 * the most recent messages verbatim so the agent can continue the current task.
 */

import { streamLLM, type Message } from './llm.js'

const DEFAULT_KEEP_RECENT_MESSAGES = 8
const DEFAULT_SOURCE_MAX_CHARS = 90_000

export const COMPACT_KEEP_RECENT_MESSAGES = numberFromEnv(
  'COMPACT_KEEP_RECENT_MESSAGES',
  DEFAULT_KEEP_RECENT_MESSAGES,
)

export const COMPACT_SOURCE_MAX_CHARS = numberFromEnv(
  'COMPACT_SOURCE_MAX_CHARS',
  DEFAULT_SOURCE_MAX_CHARS,
)

export type CompactMessagesResult =
  | {
      compacted: false
      beforeMessageCount: number
      keptRecentMessages: number
      reason: string
    }
  | {
      compacted: true
      beforeMessageCount: number
      afterMessageCount: number
      compactedMessageCount: number
      keptRecentMessages: number
      summary: string
      messages: Message[]
    }

const COMPACTION_SYSTEM_PROMPT = `You are the context compactor for a coding agent.

Your job is to turn older conversation history into a structured work summary so the agent can continue the task without re-reading every old message.

Rules:
- Preserve concrete technical facts: file paths, commands, decisions, errors, current state, and exact next step.
- Do not introduce yourself.
- Do not write a casual chat recap.
- Do not invent missing details. Write "Unknown" when a section has no evidence.
- Use the user's language when it is clear from the transcript.
- Keep it concise but complete enough for a coding agent to resume work.`

export async function compactMessages(
  messages: Message[],
  keepRecentMessages = COMPACT_KEEP_RECENT_MESSAGES,
): Promise<CompactMessagesResult> {
  const beforeMessageCount = messages.length
  const systemMessage = messages[0]?.role === 'system' ? messages[0] : undefined
  const conversation = systemMessage ? messages.slice(1) : messages.slice()

  if (conversation.length <= keepRecentMessages) {
    return {
      compacted: false,
      beforeMessageCount,
      keptRecentMessages: keepRecentMessages,
      reason: `Current session has ${conversation.length} compactable messages, which is not more than the keep window (${keepRecentMessages}).`,
    }
  }

  const compactedPart = conversation.slice(0, conversation.length - keepRecentMessages)
  const recentPart = conversation.slice(conversation.length - keepRecentMessages)
  const transcript = clampSourceTranscript(formatTranscript(compactedPart))
  const summary = await generateCompactSummary(transcript)

  const summaryMessage: Message = {
    role: 'user',
    content: [
      '[Compacted conversation summary]',
      'The earlier part of this coding-agent session has been compacted. Use this as working context and continue the current task directly.',
      '',
      summary,
    ].join('\n'),
  }

  const compactedMessages = [
    ...(systemMessage ? [systemMessage] : []),
    summaryMessage,
    ...recentPart,
  ]

  return {
    compacted: true,
    beforeMessageCount,
    afterMessageCount: compactedMessages.length,
    compactedMessageCount: compactedPart.length,
    keptRecentMessages: recentPart.length,
    summary,
    messages: compactedMessages,
  }
}

async function generateCompactSummary(transcript: string): Promise<string> {
  const prompt = [
    'Summarize the older part of this coding-agent session into the fixed sections below.',
    'The newest messages will be preserved verbatim after your summary, so focus on stable facts needed to continue the work.',
    '',
    'Required sections:',
    '## User intent',
    '## Current plan',
    '## Completed work',
    '## Files touched',
    '## Decisions made',
    '## Errors or blockers',
    '## Current state',
    '## Exact next step',
    '',
    'Older transcript:',
    transcript,
  ].join('\n')

  let finalText = ''
  for await (const event of streamLLM([
    { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ])) {
    if (event.type === 'done' && event.response.type === 'text') {
      finalText = event.response.text
    }
  }

  const summary = finalText.trim()
  if (!summary) throw new Error('compact summary is empty')
  return summary
}

function formatTranscript(messages: Message[]): string {
  return messages.map(formatMessage).join('\n\n')
}

function formatMessage(message: Message, index: number): string {
  const lines = [`[${index}] role=${message.role}`]

  if (message.tool_call_id) lines.push(`tool_call_id=${message.tool_call_id}`)
  if (message.content) lines.push(message.content)
  if (message.tool_calls && message.tool_calls.length > 0) {
    lines.push('tool_calls:')
    for (const toolCall of message.tool_calls) {
      lines.push(`- ${toolCall.function.name}(${toolCall.function.arguments}) id=${toolCall.id}`)
    }
  }

  if (!message.content && !message.tool_calls) lines.push('(empty)')
  return lines.join('\n')
}

function clampSourceTranscript(transcript: string): string {
  if (transcript.length <= COMPACT_SOURCE_MAX_CHARS) return transcript

  const headChars = Math.floor(COMPACT_SOURCE_MAX_CHARS * 0.6)
  const tailChars = COMPACT_SOURCE_MAX_CHARS - headChars
  const omitted = transcript.length - COMPACT_SOURCE_MAX_CHARS

  return [
    transcript.slice(0, headChars),
    '',
    `[... ${omitted.toLocaleString()} characters omitted from compact source because it exceeded COMPACT_SOURCE_MAX_CHARS ...]`,
    '',
    transcript.slice(-tailChars),
  ].join('\n')
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
