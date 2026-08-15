import assert from 'node:assert/strict'
import test from 'node:test'
import { streamRun } from '../src/api.ts'
import type { AgentRunEnvelope, AgentRunSnapshot } from '../src/types.ts'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  onerror: ((event: Event) => void) | null = null
  closed = false
  private listeners = new Map<string, (event: Event) => void>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, typeof listener === 'function' ? listener : event => listener.handleEvent(event))
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }))
  }
}

test('web starts a persistent run and consumes cursor-scoped SSE until completion', async t => {
  const originalFetch = globalThis.fetch
  const originalEventSource = globalThis.EventSource
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.EventSource = originalEventSource
    FakeEventSource.instances = []
  })

  const running: AgentRunSnapshot = {
    id: 'run-1',
    sessionId: 'session-1',
    workspaceRoot: '/project',
    executionRoot: '/project',
    status: 'running',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
  }
  const completed: AgentRunSnapshot = {
    ...running,
    status: 'completed',
    updatedAt: '2026-08-13T00:00:02.000Z',
    finishedAt: '2026-08-13T00:00:02.000Z',
  }
  const requests: Array<{ path: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ path: String(input), init })
    return new Response(JSON.stringify({
      run: running,
      runId: running.id,
      sessionId: running.sessionId,
      cursor: 7,
    }), { status: 202, headers: { 'content-type': 'application/json' } })
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource

  const starts: string[] = []
  const envelopes: AgentRunEnvelope[] = []
  const result = streamRun(
    { prompt: 'Ship it', context: { workspaceRoot: '/project', origin: 'web' } },
    started => starts.push(started.runId),
    envelope => envelopes.push(envelope),
  )
  for (let attempt = 0; attempt < 20 && FakeEventSource.instances.length === 0; attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.path, '/api/runs')
  assert.equal(requests[0]?.init?.method, 'POST')
  assert.deepEqual(starts, ['run-1'])
  const events = FakeEventSource.instances[0]
  assert.ok(events)
  assert.equal(events.url, '/api/runs/events?runId=run-1&after=7')

  events.emit('run', {
    cursor: 8,
    run: running,
    output: { type: 'agent_event', event: { type: 'assistant_delta', text: 'Done' } },
  } satisfies AgentRunEnvelope)
  events.emit('run', {
    cursor: 9,
    run: completed,
    output: { type: 'done', sessionId: 'session-1', messageCount: 2, cancelled: false },
  } satisfies AgentRunEnvelope)
  await result

  assert.deepEqual(envelopes.map(envelope => envelope.cursor), [8, 9])
  assert.equal(events.closed, true)
})
