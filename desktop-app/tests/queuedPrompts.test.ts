import assert from 'node:assert/strict'
import test from 'node:test'
import { dequeuePrompt, enqueuePrompt, MAX_QUEUED_PROMPTS } from '../src/queuedPrompts.ts'
import type { QueuedComposerItem } from '../src/types.ts'

test('queue accepts five prompts, preserves FIFO order, and rejects a sixth', () => {
  let queue: QueuedComposerItem[] = []
  for (let index = 1; index <= MAX_QUEUED_PROMPTS; index += 1) {
    queue = enqueuePrompt(queue, `prompt ${index}`, `queue-${index}`) ?? queue
  }

  assert.equal(queue.length, 5)
  assert.equal(enqueuePrompt(queue, 'prompt 6', 'queue-6'), null)

  const first = dequeuePrompt(queue)
  assert.equal(first.prompt?.text, 'prompt 1')
  assert.deepEqual(first.remaining.map(item => item.text), ['prompt 2', 'prompt 3', 'prompt 4', 'prompt 5'])
})
