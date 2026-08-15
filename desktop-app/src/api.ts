import type { AgentRunEnvelope, AgentRunSnapshot } from './types'

interface RequestOptions {
  method?: string
  body?: unknown
}

export async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path)
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, { method: 'POST', body })
}

export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Expected JSON from ${path}, received: ${text.slice(0, 80)}`)
  }
}

export interface StartedRun {
  run: AgentRunSnapshot
  sessionId: string
  runId: string
  cursor: number
}

export async function streamRun(
  body: unknown,
  onStarted: (started: StartedRun) => void,
  onEnvelope: (envelope: AgentRunEnvelope) => void,
): Promise<void> {
  const started = await postJson<StartedRun>('/api/runs', body)
  onStarted(started)

  await new Promise<void>((resolve, reject) => {
    const query = new URLSearchParams({ runId: started.runId, after: String(started.cursor) })
    const events = new EventSource(`/api/runs/events?${query}`)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      events.close()
      if (error) reject(error)
      else resolve()
    }
    events.addEventListener('run', rawEvent => {
      if (!(rawEvent instanceof MessageEvent) || typeof rawEvent.data !== 'string') return
      try {
        const envelope = JSON.parse(rawEvent.data) as AgentRunEnvelope
        onEnvelope(envelope)
        if (envelope.output?.type === 'done' || !isActiveRunStatus(envelope.run.status)) finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    events.onerror = () => {
      // EventSource reconnects automatically. A terminal run is also visible
      // through GET /runs, so only fail after the service reports it missing.
      void getJson<{ runs?: AgentRunSnapshot[] }>(`/api/runs?runId=${encodeURIComponent(started.runId)}`)
        .then(result => {
          const run = result.runs?.[0]
          if (run && !isActiveRunStatus(run.status)) finish()
        })
        .catch(() => undefined)
    }
  })
}

function isActiveRunStatus(status: AgentRunSnapshot['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_approval'
}

/** @deprecated Kept only for IDE-oriented clients during the run API migration. */
export async function streamAskLegacy(
  body: unknown,
  onMessage: (message: unknown) => void,
): Promise<void> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok || !response.body) {
    throw new Error(await response.text() || 'Agent request failed')
  }
  await readNdjson(response.body, onMessage)
}

async function readNdjson(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: unknown) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) onMessage(JSON.parse(line) as unknown)
    }
  }

  if (buffer.trim()) onMessage(JSON.parse(buffer) as unknown)
}
