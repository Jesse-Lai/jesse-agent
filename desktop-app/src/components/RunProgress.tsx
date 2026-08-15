import { useState } from 'react'
import type { OutputFile, RunStep } from '../types'

interface RunProgressProps {
  visible: boolean
  steps: RunStep[]
  files: OutputFile[]
  running: boolean
}

export function RunProgress({ visible, steps, files, running }: RunProgressProps) {
  const [open, setOpen] = useState(false)
  if (!visible || steps.length === 0) return null

  const activeIndex = steps.findIndex(step => step.status === 'active')
  const currentStep = activeIndex === -1 ? steps.length : activeIndex + 1
  const hasError = steps.some(step => step.status === 'error')
  const isDone = !running && !hasError && steps.every(step => step.status === 'done')
  const state = hasError ? 'error' : isDone ? 'done' : running ? 'running' : 'idle'
  const stepLabel = hasError ? 'Run needs attention' : isDone ? 'Run complete' : 'Step ' + currentStep + ' / ' + steps.length
  const diffStats = summarizeDiffStats(files)
  const changedLabel = files.length === 1 ? '1 file changed' : files.length + ' files changed'

  return (
    <div className="run-progress-wrap">
      <div className="run-progress-anchor">
        {open ? (
          <div className="run-progress-popover">
            {steps.map(step => (
              <div key={step.id} className={'run-progress-step ' + step.status}>
                <span className="run-progress-step-dot" aria-hidden="true" />
                <span>{step.title}</span>
              </div>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className={'run-progress-pill ' + state}
          data-squircle-ignore="true"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
          <span className="run-progress-spinner" aria-hidden="true" />
          <span>{stepLabel}</span>
          {files.length > 0 ? <span className="run-progress-separator">·</span> : null}
          {files.length > 0 ? <span>{changedLabel}</span> : null}
          {files.length > 0 ? <span className="run-progress-additions">+{diffStats.additions}</span> : null}
          {files.length > 0 ? <span className="run-progress-deletions">-{diffStats.deletions}</span> : null}
        </button>
      </div>
    </div>
  )
}

function summarizeDiffStats(files: OutputFile[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    if (!file.diff) continue
    for (const line of file.diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) additions += 1
      if (line.startsWith('-')) deletions += 1
    }
  }
  return { additions, deletions }
}
