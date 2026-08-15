import { useEffect, useState } from 'react'
import type { DesktopRoutine, RoutineRunSummary } from '../types'

interface RoutinePanelProps {
  routine: DesktopRoutine
  runs: RoutineRunSummary[]
  running: boolean
  onSave: (routineId: string, patch: Partial<DesktopRoutine>) => Promise<void>
  onRun: (routineId: string) => Promise<void>
  onAddConnector: (routine: DesktopRoutine) => Promise<void>
  onRemoveConnector: (routine: DesktopRoutine, connectorId: string) => Promise<void>
}

export function RoutinePanel({
  routine,
  runs,
  running,
  onSave,
  onRun,
  onAddConnector,
  onRemoveConnector,
}: RoutinePanelProps) {
  const [name, setName] = useState(routine.name)
  const [scheduleText, setScheduleText] = useState(routine.scheduleText)
  const [instruction, setInstruction] = useState(routine.instruction)

  useEffect(() => {
    setName(routine.name)
    setScheduleText(routine.scheduleText)
    setInstruction(routine.instruction)
  }, [routine.id, routine.name, routine.scheduleText, routine.instruction])

  return (
    <section className="routine-panel" aria-label="Routine settings">
      <div className="routine-panel-main">
        <div className="routine-title-row">
          <input
            className="routine-title-input"
            value={name}
            onChange={event => setName(event.target.value)}
            onBlur={() => saveIfChanged('name', name.trim())}
            aria-label="Routine name"
          />
          <button className="routine-run-button" type="button" disabled={running} onClick={() => void onRun(routine.id)}>
            Run now
          </button>
        </div>

        <div className="routine-fields">
          <label>
            <span>Schedule</span>
            <input
              value={scheduleText}
              placeholder="Daily at 9:00"
              onChange={event => setScheduleText(event.target.value)}
              onBlur={() => saveIfChanged('scheduleText', scheduleText.trim())}
            />
          </label>
          <label>
            <span>Approval</span>
            <select
              value={routine.approvalPolicy}
              onChange={event => void onSave(routine.id, { approvalPolicy: event.target.value as DesktopRoutine['approvalPolicy'] })}
            >
              <option value="read_only_auto">Read-only auto</option>
              <option value="ask_before_write">Ask before write</option>
              <option value="ask_before_external_action">Ask before external action</option>
            </select>
          </label>
          <label className="routine-enabled-field">
            <span>Enabled</span>
            <input
              type="checkbox"
              checked={routine.enabled}
              onChange={event => void onSave(routine.id, { enabled: event.target.checked })}
            />
          </label>
        </div>

        <label className="routine-instruction-field">
          <span>Instruction</span>
          <textarea
            value={instruction}
            placeholder="Describe what this routine should accomplish when it runs."
            onChange={event => setInstruction(event.target.value)}
            onBlur={() => saveIfChanged('instruction', instruction.trim())}
          />
        </label>
      </div>

      <div className="routine-panel-grid">
        <div className="routine-panel-section">
          <div className="routine-section-heading">
            <span>Connectors</span>
            <button type="button" onClick={() => void onAddConnector(routine)}>Add</button>
          </div>
          {routine.connectors.length === 0 ? (
            <div className="routine-muted">No connectors yet. Add MCP, HTTP API, built-in, or manual capability sources.</div>
          ) : routine.connectors.map(connector => (
            <div className="routine-chip-row" key={connector.id}>
              <div>
                <div className="routine-chip-title">{connector.displayName}</div>
                <div className="routine-chip-meta">{connector.kind} · {connector.capabilities.join(', ') || 'no capabilities'}</div>
              </div>
              <button type="button" onClick={() => void onRemoveConnector(routine, connector.id)}>Remove</button>
            </div>
          ))}
        </div>

        <div className="routine-panel-section">
          <div className="routine-section-heading"><span>Workflow</span></div>
          {routine.workflow.length === 0 ? (
            <div className="routine-muted">No workflow steps yet. The agent will follow the instruction directly.</div>
          ) : routine.workflow.map((step, index) => (
            <div className="routine-step" key={step.id}>
              <div className="routine-chip-title">{index + 1}. {step.title}</div>
              <div className="routine-chip-meta">{step.kind}</div>
              <div className="routine-chip-meta">{formatConfig(step.config)}</div>
              <div className="routine-step-prompt">{step.prompt}</div>
            </div>
          ))}
        </div>

        <div className="routine-panel-section routine-runs-section">
          <div className="routine-section-heading"><span>Recent Runs</span></div>
          {runs.length === 0 ? (
            <div className="routine-muted">No runs yet.</div>
          ) : runs.slice(0, 5).map(run => (
            <div className="routine-run-row" key={run.id}>
              <div>
                <div className={`routine-run-status ${run.status}`}>{run.status}</div>
                <div className="routine-chip-meta">{formatRunTime(run.startedAt)}{run.sessionId ? ` · ${run.sessionId}` : ''}</div>
              </div>
              <div className="routine-run-output">{run.output || run.error}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )

  function saveIfChanged(key: 'name' | 'scheduleText' | 'instruction', value: string) {
    if (value === routine[key]) return
    void onSave(routine.id, { [key]: value })
  }
}

function formatRunTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatConfig(config: Record<string, string | number | boolean>): string {
  const entries = Object.entries(config)
  if (entries.length === 0) return 'config: none'
  return `config: ${entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`
}
