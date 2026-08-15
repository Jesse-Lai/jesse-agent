import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ActivityItem, ConversationItem } from '../types'

interface ConversationProps {
  items: ConversationItem[]
  header?: ReactNode
  onCopyMessage: (item: Extract<ConversationItem, { type: 'message' }>) => void
  onEditMessage: (item: Extract<ConversationItem, { type: 'message' }>) => void
  onAddSelectionToChat: (text: string) => void
}

interface SelectionToolbarState {
  text: string
  top: number
  left: number
}

export function Conversation({
  items,
  header,
  onCopyMessage,
  onEditMessage,
  onAddSelectionToChat,
}: ConversationProps) {
  const containerRef = useRef<HTMLElement>(null)
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [items])

  useEffect(() => {
    if (!selectionToolbar) return
    const closeToolbar = () => setSelectionToolbar(null)
    const container = containerRef.current
    container?.addEventListener('scroll', closeToolbar, { passive: true })
    window.addEventListener('resize', closeToolbar)
    return () => {
      container?.removeEventListener('scroll', closeToolbar)
      window.removeEventListener('resize', closeToolbar)
    }
  }, [selectionToolbar])

  const updateSelectionToolbar = () => {
    const container = containerRef.current
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) {
      setSelectionToolbar(null)
      return
    }

    const text = selection.toString().trim()
    const range = selection.getRangeAt(0)
    if (!text || !nodeInside(container, range.commonAncestorContainer)) {
      setSelectionToolbar(null)
      return
    }

    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) {
      setSelectionToolbar(null)
      return
    }
    setSelectionToolbar({
      text,
      top: Math.max(10, rect.top - 44),
      left: clamp(rect.left + rect.width / 2, 88, window.innerWidth - 88),
    })
  }

  return (
    <section
      ref={containerRef}
      className="messages"
      onMouseUp={() => window.setTimeout(updateSelectionToolbar, 0)}
      onKeyUp={updateSelectionToolbar}
    >
      {header}
      {items.map(item => {
        if (item.type === 'message') {
          return (
            <MessageBubble
              key={item.id}
              item={item}
              onCopy={onCopyMessage}
              onEdit={onEditMessage}
            />
          )
        }
        if (item.type === 'activity') {
          return <ActivityStream key={item.id} item={item} />
        }
        if (item.type === 'status') {
          return <StatusBlock key={item.id} item={item} />
        }
        return null
      })}
      {selectionToolbar ? (
        <div
          className="selection-toolbar"
          style={{ top: selectionToolbar.top, left: selectionToolbar.left }}
          onMouseDown={event => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              onAddSelectionToChat(selectionToolbar.text)
              window.getSelection()?.removeAllRanges()
              setSelectionToolbar(null)
            }}
          >
            Add to chat
          </button>
        </div>
      ) : null}
    </section>
  )
}

function MessageBubble({
  item,
  onCopy,
  onEdit,
}: {
  item: Extract<ConversationItem, { type: 'message' }>
  onCopy: ConversationProps['onCopyMessage']
  onEdit: ConversationProps['onEditMessage']
}) {
  const isUser = item.role === 'user'
  const time = formatMessageTime(item.createdAt)
  const attachments = item.attachments ?? []
  const hasCopy = Boolean(item.text.trim() || item.annotations?.length)

  return (
    <div className={'message-row ' + item.role}>
      <div className="message-cluster">
        <div className={'message ' + item.role + (attachments.length ? ' has-attachments' : '')}>
          {attachments.length ? <MessageImages item={item} /> : null}
          {hasCopy ? (
            <div className="message-copy">
              {item.annotations?.length ? <MessageAnnotations annotations={item.annotations} /> : null}
              {item.text.trim() ? <div className="message-body"><MarkdownContent text={item.text} /></div> : null}
            </div>
          ) : null}
        </div>
        <div className="message-actions" aria-label={isUser ? 'User message actions' : 'Assistant message actions'}>
          {isUser && time ? <span className="message-time">{time}</span> : null}
          {hasCopy ? <IconAction label="Copy" icon="copy" onClick={() => onCopy(item)} /> : null}
          {isUser && item.canEdit ? <IconAction label="Edit" icon="edit" onClick={() => onEdit(item)} /> : null}
        </div>
      </div>
    </div>
  )
}

function MessageImages({ item }: { item: Extract<ConversationItem, { type: 'message' }> }) {
  const attachments = item.attachments ?? []
  return (
    <div className={`message-images count-${Math.min(attachments.length, 4)}`} aria-label="Message images">
      {attachments.map((attachment, index) => {
        const source = attachment.url || attachment.dataURL
        if (!source) {
          return <div className="message-image-missing" key={attachment.assetId || attachment.id || index}>Image unavailable</div>
        }
        const label = attachment.name || (attachment.source === 'generated' ? 'Generated image' : `Attached image ${index + 1}`)
        return (
          <a
            className="message-image-link"
            href={source}
            target="_blank"
            rel="noreferrer"
            title={`Open ${label}`}
            key={attachment.assetId || attachment.id || attachment.url || index}
          >
            <img src={source} alt={label} loading="lazy" decoding="async" />
          </a>
        )
      })}
    </div>
  )
}

function MessageAnnotations({ annotations }: { annotations: NonNullable<Extract<ConversationItem, { type: 'message' }>['annotations']> }) {
  return (
    <div className="message-annotations">
      {annotations.map((annotation, index) => (
        <details key={annotation.id} className="message-annotation">
          <summary>
            <span className="annotation-icon" aria-hidden="true" />
            <span>{annotations.length === 1 ? 'Annotation' : 'Annotation ' + (index + 1)}</span>
          </summary>
          <blockquote>{annotation.text}</blockquote>
        </details>
      ))}
    </div>
  )
}

function IconAction({ label, icon, onClick }: { label: string; icon: 'copy' | 'edit'; onClick: () => void }) {
  return (
    <button className="message-icon-action" type="button" aria-label={label} title={label} onClick={onClick}>
      {icon === 'edit'
        ? <span className="fluent-icon icon-edit" aria-hidden="true" />
        : <span className="fluent-icon icon-copy" aria-hidden="true" />}
    </button>
  )
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function MarkdownContent({ text }: { text: string }) {
  const parts = parseFencedBlocks(text)
  return (
    <>
      {parts.map((part, index) => part.kind === 'code'
        ? <CodeBlock key={index} language={part.language} code={part.code} />
        : <MarkdownBlocks key={index} text={part.text} />)}
    </>
  )
}

function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const nodes: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      nodes.push(<Tag key={nodes.length}>{renderInlineMarkdown(heading[2])}</Tag>)
      index += 1
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(<li key={items.length}>{renderInlineMarkdown(lines[index].replace(/^\s*[-*+]\s+/, ''))}</li>)
        index += 1
      }
      nodes.push(<ul key={nodes.length}>{items}</ul>)
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(<li key={items.length}>{renderInlineMarkdown(lines[index].replace(/^\s*\d+[.)]\s+/, ''))}</li>)
        index += 1
      }
      nodes.push(<ol key={nodes.length}>{items}</ol>)
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      nodes.push(<blockquote key={nodes.length}><MarkdownBlocks text={quoteLines.join('\n')} /></blockquote>)
      continue
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        tableLines.push(lines[index])
        index += 1
      }
      nodes.push(renderMarkdownTable(tableLines, nodes.length))
      continue
    }

    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      nodes.push(<hr key={nodes.length} />)
      index += 1
      continue
    }

    const paragraphLines = [line]
    index += 1
    while (index < lines.length && lines[index].trim() !== '' && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index])
      index += 1
    }
    nodes.push(<p key={nodes.length}>{renderInlineMarkdown(paragraphLines.join('\n'))}</p>)
  }

  return <>{nodes}</>
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const label = language || 'text'
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{label}</span>
        <button type="button" onClick={() => void copyText(code)}>Copy</button>
      </div>
      <pre>{code}</pre>
    </div>
  )
}

function StatusBlock({ item }: { item: Extract<ConversationItem, { type: 'status' }> }) {
  return (
    <div className={`message status-block ${item.tone}`}>
      <div className="status-title">{item.title}</div>
      {item.detail ? <div className="status-detail">{item.detail}</div> : null}
    </div>
  )
}

function ActivityStream({ item }: { item: Extract<ConversationItem, { type: 'activity' }> }) {
  if (item.items.length === 0) return null

  return (
    <div className="message activity-stream" aria-label="Agent activity">
      {item.items.map(activity => <ActivityRow key={activity.id} item={activity} />)}
    </div>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div className={`activity-row ${item.kind} ${item.status}`}>
      <span className={`activity-icon fluent-icon ${activityIconClass(item)}`} aria-hidden="true" />
      <div className="activity-copy">
        <div className="activity-label">{item.label}</div>
        {item.summary || item.target ? (
          <div className="activity-summary">{[item.summary, item.target].filter(Boolean).join(' · ')}</div>
        ) : null}
      </div>
    </div>
  )
}

function activityIconClass(item: ActivityItem): string {
  if (item.status === 'error' || item.kind === 'error') return 'icon-dismiss-circle'
  if (item.kind === 'done') return 'icon-checkmark-circle'
  if (item.kind === 'read') return 'icon-folder-open'
  if (item.kind === 'edit') return 'icon-rename'
  if (item.kind === 'command') return 'icon-settings'
  if (item.kind === 'approval') return 'icon-checkmark-circle'
  if (item.kind === 'context') return 'icon-chat'
  if (item.kind === 'thinking') return 'icon-bot'
  return 'icon-settings'
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>'"]+/gi
const TRAILING_URL_PUNCTUATION = /[.,!?;:]+$/

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let index = 0

  const pushPlain = (value: string) => {
    if (!value) return
    const lines = value.split('\n')
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (lineIndex > 0) nodes.push(<br key={`br-${nodes.length}`} />)
      if (lines[lineIndex]) nodes.push(lines[lineIndex])
    }
  }

  while (index < text.length) {
    const next = findNextInlineToken(text, index)
    if (!next) {
      pushPlain(text.slice(index))
      break
    }

    if (next.start > index) pushPlain(text.slice(index, next.start))
    nodes.push(next.node)
    index = next.end
  }

  return nodes
}

function findNextInlineToken(text: string, startIndex: number): { start: number; end: number; node: ReactNode } | null {
  const candidates = [
    findInlineCode(text, startIndex),
    findMarkdownLink(text, startIndex),
    findDelimitedInline(text, startIndex, '**', (content, key) => <strong key={key}>{renderInlineMarkdown(content)}</strong>),
    findDelimitedInline(text, startIndex, '__', (content, key) => <strong key={key}>{renderInlineMarkdown(content)}</strong>),
    findDelimitedInline(text, startIndex, '~~', (content, key) => <del key={key}>{renderInlineMarkdown(content)}</del>),
    findDelimitedInline(text, startIndex, '*', (content, key) => <em key={key}>{renderInlineMarkdown(content)}</em>),
    findAutolink(text, startIndex),
  ].filter((candidate): candidate is { start: number; end: number; node: ReactNode } => Boolean(candidate))

  return candidates.sort((a, b) => a.start - b.start || a.end - b.end)[0] ?? null
}

function findInlineCode(text: string, startIndex: number): { start: number; end: number; node: ReactNode } | null {
  const start = text.indexOf('`', startIndex)
  if (start === -1) return null
  const end = text.indexOf('`', start + 1)
  if (end === -1) return null
  return { start, end: end + 1, node: <code key={`code-${start}`}>{text.slice(start + 1, end)}</code> }
}

function findMarkdownLink(text: string, startIndex: number): { start: number; end: number; node: ReactNode } | null {
  const start = text.indexOf('[', startIndex)
  if (start === -1) return null
  const labelEnd = text.indexOf('](', start + 1)
  if (labelEnd === -1) return null
  const hrefEnd = text.indexOf(')', labelEnd + 2)
  if (hrefEnd === -1) return null
  const label = text.slice(start + 1, labelEnd)
  const href = text.slice(labelEnd + 2, hrefEnd).trim()
  if (!label || !href) return null
  return {
    start,
    end: hrefEnd + 1,
    node: <a key={`link-${start}`} href={hrefForLinkText(href)} target="_blank" rel="noreferrer">{renderInlineMarkdown(label)}</a>,
  }
}

function findDelimitedInline(
  text: string,
  startIndex: number,
  delimiter: string,
  render: (content: string, key: string) => ReactNode,
): { start: number; end: number; node: ReactNode } | null {
  let start = text.indexOf(delimiter, startIndex)
  while (start !== -1) {
    if (delimiter === '*' && text[start + 1] === '*') {
      start = text.indexOf(delimiter, start + 2)
      continue
    }
    const contentStart = start + delimiter.length
    const end = text.indexOf(delimiter, contentStart)
    if (end === -1) return null
    if (end > contentStart) return { start, end: end + delimiter.length, node: render(text.slice(contentStart, end), `${delimiter}-${start}`) }
    start = text.indexOf(delimiter, contentStart)
  }
  return null
}

function findAutolink(text: string, startIndex: number): { start: number; end: number; node: ReactNode } | null {
  URL_PATTERN.lastIndex = startIndex
  const match = URL_PATTERN.exec(text)
  if (!match) return null
  const rawUrl = match[0]
  const start = match.index
  const linkText = trimLinkText(rawUrl)
  return {
    start,
    end: start + linkText.length,
    node: <a key={`url-${start}`} href={hrefForLinkText(linkText)} target="_blank" rel="noreferrer">{linkText}</a>,
  }
}

function isMarkdownBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  return /^(#{1,6})\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^>\s?/.test(line) ||
    isTableStart(lines, index) ||
    /^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]?.trim() ?? ''
  const separator = lines[index + 1]?.trim() ?? ''
  return header.includes('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator)
}

function renderMarkdownTable(lines: string[], key: number): ReactNode {
  const header = splitTableRow(lines[0])
  const rows = lines.slice(2).map(splitTableRow)
  return (
    <div className="markdown-table-wrap" key={key}>
      <table>
        <thead>
          <tr>{header.map((cell, index) => <th key={index}>{renderInlineMarkdown(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function renderTextWithLinks(text: string): ReactNode {
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const rawUrl = match[0]
    const matchIndex = match.index ?? 0
    const linkText = trimLinkText(rawUrl)
    const trailingText = rawUrl.slice(linkText.length)
    const linkStart = matchIndex
    const linkEnd = linkStart + linkText.length

    if (linkStart > lastIndex) parts.push(text.slice(lastIndex, linkStart))
    parts.push(
      <a key={`${linkStart}-${linkText}`} href={hrefForLinkText(linkText)} target="_blank" rel="noreferrer">
        {linkText}
      </a>,
    )
    if (trailingText) parts.push(trailingText)
    lastIndex = linkEnd + trailingText.length
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length ? parts : text
}

function trimLinkText(text: string): string {
  let result = text.replace(TRAILING_URL_PUNCTUATION, '')
  result = trimUnmatchedClosingPunctuation(result, '(', ')')
  result = trimUnmatchedClosingPunctuation(result, '[', ']')
  result = trimUnmatchedClosingPunctuation(result, '{', '}')
  return result
}

function trimUnmatchedClosingPunctuation(text: string, open: string, close: string): string {
  let result = text
  while (result.endsWith(close) && countChar(result, close) > countChar(result, open)) {
    result = result.slice(0, -1)
  }
  return result
}

function countChar(text: string, char: string): number {
  return Array.from(text).filter(value => value === char).length
}

function hrefForLinkText(text: string): string {
  return text.startsWith('www.') ? `https://${text}` : text
}

type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string; code: string }

function parseFencedBlocks(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) parts.push({ kind: 'text', text: text.slice(lastIndex, index) })
    parts.push({ kind: 'code', language: (match[1] ?? '').trim(), code: match[2] ?? '' })
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) parts.push({ kind: 'text', text: text.slice(lastIndex) })
  return parts.length ? parts : [{ kind: 'text', text }]
}

function nodeInside(container: Node, node: Node): boolean {
  let current: Node | null = node
  while (current) {
    if (current === container) return true
    current = current.parentNode
  }
  return false
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text)
}
