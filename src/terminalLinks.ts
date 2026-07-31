import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getProjectRoot } from './workingDirectory.js'

export interface TerminalPathOptions {
  label?: string
  link?: boolean
}

export function formatTerminalPath(path: string, options: TerminalPathOptions = {}): string {
  const label = options.label ?? path
  if (!options.link || !path || path.startsWith('(')) return label

  const absolutePath = path.startsWith('/') ? path : resolve(getProjectRoot(), path)
  return osc8(pathToFileURL(absolutePath).href, label)
}

export function linkifyPathFields(text: string, link: boolean): string {
  if (!link) return text

  return text.split('\n').map(line => {
    const colon = line.match(/^(\s*(?:path|file|cwd|output_path|worktree)\s*:\s*)(.+)$/i)
    if (colon) return `${colon[1] ?? ''}${formatTerminalPath((colon[2] ?? '').trim(), { link })}`

    const equals = line.match(/^(.*\b(?:path|file|cwd|output_path|worktree)=)(\S+)(.*)$/i)
    if (equals) return `${equals[1] ?? ''}${formatTerminalPath(equals[2] ?? '', { link })}${equals[3] ?? ''}`

    return line
  }).join('\n')
}

function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`
}
