import { useState } from 'react'
import type { CommandOutput, OutputFile, SourceItem } from '../types'

interface OutputsRailProps {
  files: OutputFile[]
  commands: CommandOutput[]
  sources: SourceItem[]
}

export function hasOutputsRailContent({ files, commands, sources }: OutputsRailProps) {
  const hasMeaningfulSource = sources.some(source => source.kind !== 'Chat' && source.kind !== 'Project')
  return files.length > 0 || commands.length > 0 || hasMeaningfulSource
}

export function OutputsRail({ files, commands, sources }: OutputsRailProps) {
  const [expanded, setExpanded] = useState(false)
  const hasOutputs = files.length > 0 || commands.length > 0

  if (!hasOutputsRailContent({ files, commands, sources })) return null

  return (
    <aside className={`outputs-rail${expanded ? ' expanded' : ''}`} aria-label="Outputs and sources">
      <section className="rail-section">
        <div className="rail-heading-row">
          <div>
            <div className="rail-heading">Outputs</div>
            {!hasOutputs ? <div className="rail-muted">Create a file or site</div> : null}
          </div>
          {hasOutputs ? (
            <button
              type="button"
              aria-label={expanded ? 'Collapse outputs' : 'Expand outputs'}
              title={expanded ? 'Collapse outputs' : 'Expand outputs'}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? '-' : '+'}
            </button>
          ) : null}
        </div>
        {hasOutputs ? (
          <div className="rail-list">
            {files.map(file => <RailFile key={file.path} file={file} expanded={expanded} />)}
            {commands.map(command => <RailCommand key={command.id} command={command} expanded={expanded} />)}
          </div>
        ) : null}
      </section>

      <section className="rail-section sources-section">
        <div className="rail-heading-row">
          <div className="rail-heading">Sources</div>
        </div>
        <div className="rail-list">
          {sources.slice(0, expanded ? sources.length : 5).map(source => (
            <div key={source.id} className="rail-source" title={source.detail || source.label}>
              <span className="rail-source-icon" aria-hidden="true" />
              <span className="rail-source-copy">
                <span>{source.label}</span>
                {expanded && source.detail ? <span>{source.detail}</span> : null}
              </span>
            </div>
          ))}
          {sources.length === 0 ? <div className="rail-muted">No sources yet</div> : null}
        </div>
        {sources.length > 5 && !expanded ? (
          <button type="button" className="rail-view-all" onClick={() => setExpanded(true)}>View all</button>
        ) : null}
      </section>
    </aside>
  )
}

function RailFile({ file, expanded }: { file: OutputFile; expanded: boolean }) {
  return (
    <details className="rail-output" open={expanded && Boolean(file.diff)}>
      <summary>
        <span className="rail-output-icon" aria-hidden="true" />
        <span className="rail-output-copy">
          <span>{file.path}</span>
          <span>{file.action}</span>
        </span>
      </summary>
      {file.diff ? <pre>{file.diff}</pre> : null}
    </details>
  )
}

function RailCommand({ command, expanded }: { command: CommandOutput; expanded: boolean }) {
  return (
    <details className={`rail-output command ${command.ok ? 'success' : 'error'}`} open={expanded}>
      <summary>
        <span className="rail-output-icon" aria-hidden="true" />
        <span className="rail-output-copy">
          <span>{command.command}</span>
          <span>{command.ok ? 'passed' : 'failed'}</span>
        </span>
      </summary>
      <pre>{command.content}</pre>
    </details>
  )
}
