import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type SyntheticEvent, type TransitionEvent } from 'react'
import { getJson } from '../api'
import type { DailyChangelogDetail, DailyChangelogSummary } from '../types'
import { MarkdownContent } from './Conversation'

interface DailyChangelogProps {
  projectPath: string
  items: DailyChangelogSummary[]
  onOpenSession: (sessionId: string) => void
}

interface RectSnapshot {
  left: number
  top: number
  width: number
  height: number
}

interface FrameAppearance {
  padding: number
  captionHeight: number
  borderRadius: number
  borderWidth: number
  backgroundColor: string
  boxShadow: string
}

interface ArtworkFlight {
  id: number
  date: string
  src: string
  direction: 'in' | 'out'
  from: RectSnapshot
  to?: RectSnapshot
  fromRotation: number
  toRotation: number
  fromSkew: number
  toSkew: number
  fromFrame: FrameAppearance
  toFrame: FrameAppearance
  targetZ: number
  started: boolean
}

interface CardLayout {
  y: number
  rotation: number
  skew: number
}

interface ReturnSequence {
  date: string
  phase: 'flight' | 'composer' | 'cards'
}

// Figma defines the visible three-card sequence from newest backwards as
// -2deg, 1deg, and -1.7deg. Extra variants extend the same quiet rhythm when
// the product has four or five daily cards.
const CARD_LAYOUT_FROM_NEWEST: readonly CardLayout[] = [
  { y: 0, rotation: -2, skew: 0 },
  { y: 1, rotation: 1, skew: 0 },
  { y: 0, rotation: -1.7, skew: 0.66 },
  { y: 1, rotation: 1.4, skew: 0 },
  { y: 0, rotation: -1.2, skew: 0.4 },
] as const

const CARD_FRAME: FrameAppearance = {
  padding: 9,
  captionHeight: 30,
  borderRadius: 2,
  borderWidth: 0,
  backgroundColor: '#fff',
  boxShadow: '1px 2px 2.2px rgba(121, 161, 172, 0.4)',
}

const DETAIL_FRAME: FrameAppearance = {
  padding: 14,
  captionHeight: 42,
  borderRadius: 2,
  borderWidth: 1,
  backgroundColor: '#fffdf8',
  boxShadow: '0 0 5px rgba(48, 38, 26, 0.08), 0 0 12px rgba(48, 38, 26, 0.10)',
}

const FLIGHT_COMPLETION_FALLBACK_MS = 860
const RETURN_COMPOSER_REVEAL_MS = 240
const RETURN_CARDS_COMPLETION_MS = 700

let flightSequence = 0

export function DailyChangelog(props: DailyChangelogProps) {
  const [selected, setSelected] = useState<DailyChangelogSummary | null>(null)
  const [detail, setDetail] = useState<DailyChangelogDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [contentVisible, setContentVisible] = useState(false)
  const [flight, setFlight] = useState<ArtworkFlight | null>(null)
  const [returnSequence, setReturnSequence] = useState<ReturnSequence | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const detailArtworkRef = useRef<HTMLDivElement>(null)
  const cardButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const animationFramesRef = useRef<number[]>([])
  const detailRequestRef = useRef(0)

  useEffect(() => () => cancelAnimationFrames(animationFramesRef.current), [])

  useEffect(() => {
    if (!selected) return
    const requestId = ++detailRequestRef.current
    setDetail(null)
    setDetailError('')
    const query = new URLSearchParams({ workspaceRoot: props.projectPath })
    void getJson<{ changelog?: DailyChangelogDetail }>(`/api/changelogs/${selected.date}?${query}`)
      .then(result => {
        if (detailRequestRef.current !== requestId) return
        if (!result.changelog) throw new Error('The changelog detail response was empty.')
        setDetail(result.changelog)
      })
      .catch(error => {
        if (detailRequestRef.current !== requestId) return
        setDetailError(error instanceof Error ? error.message : String(error))
      })
  }, [props.projectPath, selected?.date])

  useEffect(() => {
    if (!selected) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDetail()
      if (event.key === 'Tab' && dialogRef.current) keepFocusInsideDialog(event, dialogRef.current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected, flight])

  useEffect(() => {
    if (!selected) return
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [selected?.date])

  useEffect(() => {
    if (!flight?.started) return
    const currentFlight = flight
    const timer = window.setTimeout(() => completeFlight(currentFlight), FLIGHT_COMPLETION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [flight?.id, flight?.started])

  useEffect(() => {
    if (!returnSequence || returnSequence.phase === 'flight') return
    const currentSequence = returnSequence
    const delay = currentSequence.phase === 'composer'
      ? RETURN_COMPOSER_REVEAL_MS
      : RETURN_CARDS_COMPLETION_MS
    const timer = window.setTimeout(() => {
      if (currentSequence.phase === 'composer') {
        setReturnSequence(current => current?.date === currentSequence.date
          ? { ...current, phase: 'cards' }
          : current)
        return
      }
      setReturnSequence(current => current?.date === currentSequence.date ? null : current)
      restoreCardFocus(currentSequence.date)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [returnSequence?.date, returnSequence?.phase])

  useLayoutEffect(() => {
    if (!flight || flight.to || flight.direction !== 'in') return
    const target = detailArtworkRef.current
    if (!target) return
    const to = cardFrameSnapshot(target)
    setFlight(current => current?.id === flight.id ? { ...current, to } : current)
    startFlightOnNextPaint(flight.id)
  }, [flight, selected])

  function openDetail(item: DailyChangelogSummary, layout: CardLayout) {
    if (selected || flight || returnSequence) return
    const source = cardButtonRefs.current.get(item.date)
    setSelected(item)
    setDetail(null)
    setDetailError('')
    setContentVisible(false)

    if (!item.imageAvailable || !source || prefersReducedMotion()) {
      setContentVisible(true)
      return
    }

    setFlight({
      id: ++flightSequence,
      date: item.date,
      src: illustrationUrl(props.projectPath, item.date),
      direction: 'in',
      from: cardFrameSnapshot(source),
      fromRotation: layout.rotation,
      toRotation: layout.rotation,
      fromSkew: layout.skew,
      toSkew: layout.skew,
      fromFrame: CARD_FRAME,
      toFrame: DETAIL_FRAME,
      targetZ: Math.max(1, orderedItems.findIndex(candidate => candidate.date === item.date) + 1),
      started: false,
    })
  }

  function closeDetail() {
    if (!selected || flight) return
    const source = detailArtworkRef.current
    const target = cardButtonRefs.current.get(selected.date)
    if (!selected.imageAvailable || !source || !target || prefersReducedMotion()) {
      const selectedDate = selected.date
      setSelected(null)
      setDetail(null)
      setDetailError('')
      setContentVisible(false)
      restoreCardFocus(selectedDate)
      return
    }

    const index = orderedItems.findIndex(item => item.date === selected.date)
    const layout = cardLayout(index, orderedItems.length)
    const nextFlight: ArtworkFlight = {
      id: ++flightSequence,
      date: selected.date,
      src: illustrationUrl(props.projectPath, selected.date),
      direction: 'out',
      from: cardFrameSnapshot(source),
      to: cardFrameSnapshot(target),
      fromRotation: layout.rotation,
      toRotation: layout.rotation,
      fromSkew: layout.skew,
      toSkew: layout.skew,
      fromFrame: DETAIL_FRAME,
      toFrame: CARD_FRAME,
      targetZ: Math.max(1, index + 1),
      started: false,
    }
    setContentVisible(false)
    setReturnSequence({ date: selected.date, phase: 'flight' })
    setFlight(nextFlight)
    startFlightOnNextPaint(nextFlight.id)
  }

  function startFlightOnNextPaint(id: number) {
    cancelAnimationFrames(animationFramesRef.current)
    const first = window.requestAnimationFrame(() => {
      const second = window.requestAnimationFrame(() => {
        setFlight(current => current?.id === id ? { ...current, started: true } : current)
      })
      animationFramesRef.current.push(second)
    })
    animationFramesRef.current.push(first)
  }

  function finishFlight(event: TransitionEvent<HTMLDivElement>) {
    if (event.propertyName !== 'left' || !flight) return
    completeFlight(flight)
  }

  function completeFlight(currentFlight: ArtworkFlight) {
    if (flight?.id !== currentFlight.id) return
    if (currentFlight.direction === 'in') {
      setFlight(null)
      setContentVisible(true)
      return
    }
    setFlight(null)
    setSelected(null)
    setDetail(null)
    setDetailError('')
    setContentVisible(false)
    setReturnSequence({ date: currentFlight.date, phase: 'composer' })
  }

  function restoreCardFocus(date: string) {
    const frame = window.requestAnimationFrame(() => cardButtonRefs.current.get(date)?.focus({ preventScroll: true }))
    animationFramesRef.current.push(frame)
  }

  const flightRect = flight?.started && flight.to ? flight.to : flight?.from
  const flightRotation = flight?.started ? flight.toRotation : flight?.fromRotation
  const flightSkew = flight?.started ? flight.toSkew : flight?.fromSkew
  const flightFrame = flight ? (flight.started ? flight.toFrame : flight.fromFrame) : null
  const opening = flight?.direction === 'in'
  const openingActive = opening && flight?.started
  const returning = flight?.direction === 'out'
  const returningActive = returning && flight?.started
  const returnFlight = returnSequence?.phase === 'flight'
  const returnComposer = returnSequence?.phase === 'composer'
  const returnCards = returnSequence?.phase === 'cards'
  const stackItems = selected && !props.items.some(item => item.date === selected.date)
    ? [...props.items.slice(0, 4), selected]
    : props.items.slice(0, 5)
  const orderedItems = [...stackItems].sort((a, b) => a.date.localeCompare(b.date))
  const selectedIndex = selected ? orderedItems.findIndex(item => item.date === selected.date) : -1
  const selectedLayout = selectedIndex >= 0 ? cardLayout(selectedIndex, orderedItems.length) : null

  return (
    <div
      className={`daily-changelog-experience${selected ? ' detail-open' : ''}${opening ? ' opening' : ''}${openingActive ? ' opening-active' : ''}${returning ? ' returning' : ''}${returningActive ? ' returning-active' : ''}${returnFlight ? ' return-flight' : ''}${returnComposer ? ' return-composer' : ''}${returnCards ? ' return-cards' : ''}`}
      aria-label="Project daily changelogs"
    >
      <div className="daily-changelog-stack">
        {orderedItems.map((item, index) => {
          const layout = cardLayout(index, orderedItems.length)
          const style = {
            '--changelog-card-y': `${layout.y}px`,
            '--changelog-card-rotation': `${layout.rotation}deg`,
            '--changelog-card-skew': `${layout.skew}deg`,
            '--changelog-card-z': String(index + 1),
            '--changelog-return-delay': `${index * 42}ms`,
          } as CSSProperties
          const returnAnchor = returnSequence?.date === item.date
          return (
            <button
              className={`daily-changelog-card${returnAnchor ? ' return-anchor' : ''}`}
              data-squircle-ignore="true"
              key={item.date}
              type="button"
              style={style}
              ref={node => {
                if (node) cardButtonRefs.current.set(item.date, node)
                else cardButtonRefs.current.delete(item.date)
              }}
              aria-label={`Open changelog for ${formatDate(item.date)}`}
              title={`${formatDate(item.date)} · ${item.headline}`}
              onClick={() => openDetail(item, layout)}
            >
              <ArtworkMedia
                className="daily-changelog-card-artwork"
                date={item.date}
                captionHeight={CARD_FRAME.captionHeight}
                headline={item.headline}
                src={item.imageAvailable ? illustrationUrl(props.projectPath, item.date) : null}
                alt=""
              />
            </button>
          )
        })}
      </div>

      {selected ? (
        <section
          ref={dialogRef}
          className={`daily-changelog-detail${flight?.direction === 'out' ? ' closing' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={`${formatDate(selected.date)} changelog`}
        >
          <button ref={closeButtonRef} className="daily-changelog-detail-close" type="button" onClick={closeDetail} aria-label="Close changelog detail">
            <span aria-hidden="true">×</span>
          </button>
          <div className="daily-changelog-detail-scroll">
            <div
              ref={detailArtworkRef}
              className={`daily-changelog-detail-artwork${flight ? ' flight-active' : ''}`}
              data-squircle-ignore="true"
              style={selectedLayout ? {
                '--changelog-detail-rotation': `${selectedLayout.rotation}deg`,
                '--changelog-detail-skew': `${selectedLayout.skew}deg`,
              } as CSSProperties : undefined}
            >
              <ArtworkMedia
                date={selected.date}
                captionHeight={DETAIL_FRAME.captionHeight}
                headline={selected.headline}
                src={selected.imageAvailable ? illustrationUrl(props.projectPath, selected.date) : null}
                alt={selected.headline}
              />
            </div>

            <div
              className={`daily-changelog-detail-copy message message-body${contentVisible ? ' visible' : ''}`}
              aria-hidden={!contentVisible}
              aria-live="polite"
            >
              <div className="daily-changelog-detail-date">{formatDate(selected.date)}</div>
              {detail ? (
                <>
                  <MarkdownContent text={changelogMarkdown(detail)} />
                  {detail.sourceSessions.length > 0 ? (
                    <div className="daily-changelog-source-links">
                      {detail.sourceSessions.map((sessionId, index) => (
                        <button key={sessionId} type="button" onClick={() => props.onOpenSession(sessionId)}>
                          对话 {index + 1}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : detailError ? (
                <div className="daily-changelog-detail-error">详情加载失败：{detailError}</div>
              ) : (
                <div className="daily-changelog-detail-loading">正在展开这一天的记录…</div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {flight && flightRect && flightFrame ? (
        <div
          className="daily-changelog-artwork-flight"
          data-squircle-ignore="true"
          style={{
            left: flightRect.left,
            top: flightRect.top,
            width: flightRect.width,
            height: flightRect.height,
            zIndex: flight.direction === 'out' ? flight.targetZ : 1000,
            padding: flightFrame.padding,
            '--changelog-caption-height': `${flightFrame.captionHeight}px`,
            borderRadius: flightFrame.borderRadius,
            borderWidth: flightFrame.borderWidth,
            backgroundColor: flightFrame.backgroundColor,
            boxShadow: flightFrame.boxShadow,
            transform: `rotate(${flightRotation ?? 0}deg) skewX(${flightSkew ?? 0}deg)`,
          } as CSSProperties}
          onTransitionEnd={finishFlight}
          aria-hidden="true"
        >
          <ArtworkMedia
            date={flight.date}
            captionHeight={flightFrame.captionHeight}
            headline=""
            src={flight.src}
            alt=""
          />
        </div>
      ) : null}
    </div>
  )
}

function changelogMarkdown(detail: DailyChangelogDetail): string {
  const sections = [
    `# ${detail.headline}`,
    detail.summary,
    ...detail.highlights.flatMap((highlight, index) => [
      `## ${String(index + 1).padStart(2, '0')}. ${highlight.title}`,
      highlight.detail,
    ]),
  ]

  if (detail.verification.length > 0) {
    sections.push('## 如何确认它可以正常工作')
    sections.push(detail.verification.map(item => `- ${item}`).join('\n'))
  }

  if (detail.changedFiles.length > 0) {
    sections.push('## 当天修改的文件')
    sections.push(detail.changedFiles.map(path => `- \`${path}\``).join('\n'))
  }

  if (detail.sourceSessions.length > 0) sections.push('## 关联对话')

  return sections.join('\n\n')
}

function ArtworkMedia(props: {
  date: string
  captionHeight: number
  headline: string
  src: string | null
  alt: string
  className?: string
}) {
  const layout = captionLayout(props.date, props.captionHeight)
  const style = {
    '--changelog-caption-x': `${layout.xPercent}%`,
    '--changelog-caption-y': `${layout.y}px`,
    '--changelog-caption-rotation': `${layout.rotation}deg`,
  } as CSSProperties
  return (
    <div className={`daily-changelog-polaroid-content${props.className ? ` ${props.className}` : ''}`} style={style}>
      <div className="daily-changelog-photo">
        {props.src
          ? <img src={props.src} alt={props.alt} draggable={false} onLoad={applySampledInkColor} />
          : <ArtworkPlaceholder headline={props.headline} />}
      </div>
      <time className="daily-changelog-caption" dateTime={props.date}>{formatCaptionDate(props.date)}</time>
    </div>
  )
}

function ArtworkPlaceholder({ headline }: { headline: string }) {
  return (
    <div className="daily-changelog-artwork-placeholder" aria-label={headline}>
      <span aria-hidden="true">✦</span>
      <small>{headline}</small>
    </div>
  )
}

function illustrationUrl(projectPath: string, date: string): string {
  const query = new URLSearchParams({ workspaceRoot: projectPath })
  return `/api/changelogs/${date}/image?${query}`
}

function cardFrameSnapshot(element: HTMLElement): RectSnapshot {
  const rect = element.getBoundingClientRect()
  const width = element.offsetWidth
  const height = element.offsetHeight
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  }
}

function cardLayout(index: number, count: number): CardLayout {
  const distanceFromNewest = Math.max(0, count - index - 1)
  return CARD_LAYOUT_FROM_NEWEST[Math.min(distanceFromNewest, CARD_LAYOUT_FROM_NEWEST.length - 1)]!
}

function formatDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return `${year}年${month}月${day}日`
}

function formatCaptionDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]
  return monthName ? `${monthName} ${day}, ${year}` : value
}

function captionLayout(value: string, captionHeight: number): {
  xPercent: number
  y: number
  rotation: number
} {
  const horizontal = stableRandom(value, 1)
  const overlap = 0.2 + stableRandom(value, 2) * 0.2
  const baseRotation = -3 + stableRandom(value, 3) * 6
  const rotationJitter = -0.57 + stableRandom(value, 4) * 1.14
  const fontSize = Math.min(28, captionHeight - 10)
  const upwardShift = captionHeight / 2 + fontSize * (overlap - 0.5)
  return {
    xPercent: roundCaptionValue((horizontal - 0.5) * 15),
    y: -roundCaptionValue(upwardShift),
    rotation: roundCaptionValue(baseRotation + rotationJitter),
  }
}

function stableRandom(value: string, salt: number): number {
  let hash = 2166136261 ^ salt
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  hash += hash << 13
  hash ^= hash >>> 7
  hash += hash << 3
  hash ^= hash >>> 17
  hash += hash << 5
  return (hash >>> 0) / 4294967295
}

function roundCaptionValue(value: number): number {
  return Math.round(value * 100) / 100
}

function applySampledInkColor(event: SyntheticEvent<HTMLImageElement>): void {
  const image = event.currentTarget
  const content = image.closest<HTMLElement>('.daily-changelog-polaroid-content')
  if (!content) return
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 24
    canvas.height = 24
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let red = 0
    let green = 0
    let blue = 0
    let weight = 0
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3]! / 255
      if (alpha < 0.1) continue
      red += pixels[index]! * alpha
      green += pixels[index + 1]! * alpha
      blue += pixels[index + 2]! * alpha
      weight += alpha
    }
    if (weight === 0) return
    const hue = rgbHue(red / weight, green / weight, blue / weight)
    content.style.setProperty('--changelog-ink-color', `hsl(${Math.round(hue)} 100% 36%)`)
  } catch {
    // The fallback ink color remains when an image cannot be sampled.
  }
}

function rgbHue(red: number, green: number, blue: number): number {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const maximum = Math.max(r, g, b)
  const minimum = Math.min(r, g, b)
  const delta = maximum - minimum
  if (delta === 0) return 28
  let hue = maximum === r
    ? ((g - b) / delta) % 6
    : maximum === g
      ? (b - r) / delta + 2
      : (r - g) / delta + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function cancelAnimationFrames(frames: number[]): void {
  for (const frame of frames.splice(0)) window.cancelAnimationFrame(frame)
}

function keepFocusInsideDialog(event: KeyboardEvent, dialog: HTMLElement): void {
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => {
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}
