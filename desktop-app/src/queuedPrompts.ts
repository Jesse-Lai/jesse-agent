import type { QueuedComposerItem } from './types'

export const MAX_QUEUED_PROMPTS = 5

/** Adds one prompt without replacing anything already waiting in line. */
export function enqueuePrompt(
  queue: QueuedComposerItem[],
  text: string,
  id: string,
): QueuedComposerItem[] | null {
  const normalized = text.trim()
  if (!normalized || queue.length >= MAX_QUEUED_PROMPTS) return null
  return [...queue, { id, text: normalized, mode: 'queue' }]
}

/** Removes only the oldest prompt so later prompts remain in FIFO order. */
export function dequeuePrompt(queue: QueuedComposerItem[]): {
  prompt: QueuedComposerItem | undefined
  remaining: QueuedComposerItem[]
} {
  const [prompt, ...remaining] = queue
  return { prompt, remaining }
}
