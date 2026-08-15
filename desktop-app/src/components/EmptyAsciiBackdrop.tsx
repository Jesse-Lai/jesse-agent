import { useCallback, useRef } from 'react'

const CHARS = '01<>[]{}()/\\|=+*#%&$@!?;:.~JESSEAGENTCODE0123456789'
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const CELL_WIDTH = 12
const CELL_HEIGHT = 16
const FRAME_INTERVAL_MS = 96
const AREA_TRANSITION_MS = 280
const MIN_GLYPH_INTERVAL_MS = 760
const MAX_GLYPH_INTERVAL_MS = 3200
const REST_ANIMATED_CELL_DIVISOR = 1
const FOCUS_ANIMATED_CELL_DIVISOR = 3
const MAX_ALPHA = 0.24
const MIN_ALPHA = 0.008
const FOCUS_AREA_SCALE = 0.84
const REST_AREA_SCALE = 1.65
const REST_VERTICAL_SCALE = 1.3
const EDGE_ALPHA_BOOST = 0.26
const EDGE_MAX_ALPHA = 0.42

interface ComposerBox {
  left: number
  right: number
  top: number
  bottom: number
}

interface Layout {
  width: number
  height: number
  cols: number
  rows: number
  cellW: number
  cellH: number
  color: string
  seeds: Uint16Array
  glyphs: Uint8Array
  nextGlyphAt: Float32Array
  glyphIntervals: Float32Array
  pulse: Float32Array
  alphaJitter: Float32Array
  composerBox: ComposerBox | null
}

export function EmptyAsciiBackdrop({ themeMode }: { themeMode: 'light' | 'dark' }) {
  const cleanupRef = useRef<(() => void) | null>(null)

  const setCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    if (!canvas) return
    cleanupRef.current = startBackdrop(canvas)
  }, [themeMode])

  return <canvas ref={setCanvas} className="empty-ascii-backdrop" aria-hidden="true" />
}

function startBackdrop(canvas: HTMLCanvasElement): () => void {
  const host = canvas.parentElement
  const context = canvas.getContext('2d')
  if (!host || !context) return () => {}

  let frame: number | null = null
  let layout: Layout | null = null
  let lastDraw = 0
  let areaScale = targetAreaScale(host)
  let areaScaleFrom = areaScale
  let areaScaleTo = areaScale
  let areaTransitionStartedAt = performance.now()
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

  const drawNow = (now: number) => {
    if (!layout) return
    drawAscii(context, layout, now, motionQuery.matches, areaScale, animatedCellDivisor(host))
  }

  const resize = () => {
    layout = createLayout(canvas, context, host)
    drawNow(performance.now())
  }

  const tick = (now: number) => {
    const areaTransitioning = updateAreaScale(now)
    if (areaTransitioning || now - lastDraw >= FRAME_INTERVAL_MS) {
      lastDraw = now
      drawNow(now)
    }
    frame = window.requestAnimationFrame(tick)
  }

  const start = () => {
    if (frame !== null || motionQuery.matches) return
    frame = window.requestAnimationFrame(tick)
  }

  const stop = () => {
    if (frame === null) return
    window.cancelAnimationFrame(frame)
    frame = null
  }

  const handleMotionChange = () => {
    if (motionQuery.matches) {
      stop()
      areaScale = targetAreaScale(host)
      areaScaleFrom = areaScale
      areaScaleTo = areaScale
      drawNow(performance.now())
    } else {
      start()
    }
  }

  const handleComposerInteractionChange = () => {
    if (!motionQuery.matches) return
    areaScale = targetAreaScale(host)
    areaScaleFrom = areaScale
    areaScaleTo = areaScale
    drawNow(performance.now())
  }

  const updateAreaScale = (now: number): boolean => {
    const nextTarget = targetAreaScale(host)
    if (nextTarget !== areaScaleTo) {
      areaScaleFrom = areaScale
      areaScaleTo = nextTarget
      areaTransitionStartedAt = now
    }

    if (motionQuery.matches) {
      areaScale = areaScaleTo
      return false
    }

    const progress = smooth(clamp((now - areaTransitionStartedAt) / AREA_TRANSITION_MS))
    areaScale = lerp(areaScaleFrom, areaScaleTo, progress)
    return progress < 1
  }

  resize()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
  observer?.observe(host)
  start()
  host.addEventListener('focusin', handleComposerInteractionChange)
  host.addEventListener('focusout', handleComposerInteractionChange)
  host.addEventListener('pointerover', handleComposerInteractionChange)
  host.addEventListener('pointerout', handleComposerInteractionChange)
  addMotionListener(motionQuery, handleMotionChange)

  return () => {
    stop()
    observer?.disconnect()
    host.removeEventListener('focusin', handleComposerInteractionChange)
    host.removeEventListener('focusout', handleComposerInteractionChange)
    host.removeEventListener('pointerover', handleComposerInteractionChange)
    host.removeEventListener('pointerout', handleComposerInteractionChange)
    removeMotionListener(motionQuery, handleMotionChange)
  }
}

function createLayout(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, host: HTMLElement): Layout {
  const rect = host.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cols = Math.max(36, Math.round(width / CELL_WIDTH))
  const rows = Math.max(24, Math.round(height / CELL_HEIGHT))
  const count = cols * rows
  const seeds = new Uint16Array(count)
  const glyphs = new Uint8Array(count)
  const nextGlyphAt = new Float32Array(count)
  const glyphIntervals = new Float32Array(count)
  const pulse = new Float32Array(count)
  const alphaJitter = new Float32Array(count)
  const now = performance.now()

  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  context.setTransform(dpr, 0, 0, dpr, 0, 0)

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col
      seeds[index] = Math.floor(Math.random() * 65535)
      glyphs[index] = seeds[index] % CHARS.length
      glyphIntervals[index] = randomGlyphInterval()
      nextGlyphAt[index] = now + Math.random() * glyphIntervals[index]
      pulse[index] = 0.65 + Math.random() * 0.55
      alphaJitter[index] = 0.72 + Math.random() * 0.42
    }
  }

  return {
    width,
    height,
    cols,
    rows,
    cellW: width / cols,
    cellH: height / rows,
    color: cssColor(host, '--empty-ascii-color', '#0d0d0d'),
    seeds,
    glyphs,
    nextGlyphAt,
    glyphIntervals,
    pulse,
    alphaJitter,
    composerBox: composerBox(host, rect, width, height),
  }
}

function drawAscii(
  context: CanvasRenderingContext2D,
  layout: Layout,
  now: number,
  reducedMotion: boolean,
  areaScale: number,
  animatedCellDivisor: number,
) {
  context.clearRect(0, 0, layout.width, layout.height)
  context.fillStyle = layout.color
  context.font = `${Math.max(10, Math.round(layout.cellH * 0.72))}px ${FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const index = row * layout.cols + col
      const x = col / Math.max(1, layout.cols - 1)
      const y = row / Math.max(1, layout.rows - 1)
      const edgeBoost = composerEdgeBoost(x, y, layout.composerBox)
      const baseAlpha = backdropAlpha(x, y, areaScale, layout.composerBox) * layout.alphaJitter[index] + edgeBoost
      if (baseAlpha < MIN_ALPHA) continue

      const seed = layout.seeds[index]
      const isAnimatedCell = seed % animatedCellDivisor === 0
      const wave = reducedMotion || !isAnimatedCell ? 0.86 : 0.78 + 0.22 * Math.sin(now * 0.0016 + seed)
      if (!reducedMotion && isAnimatedCell && now >= layout.nextGlyphAt[index]) {
        layout.glyphs[index] = nextGlyph(layout.glyphs[index], seed, now)
        layout.glyphIntervals[index] = randomGlyphInterval()
        layout.nextGlyphAt[index] = now + layout.glyphIntervals[index]
      }
      const maxAlpha = lerp(MAX_ALPHA, EDGE_MAX_ALPHA, clamp(edgeBoost / EDGE_ALPHA_BOOST))
      context.globalAlpha = Math.min(maxAlpha, baseAlpha * wave * layout.pulse[index])
      context.fillText(
        CHARS[layout.glyphs[index]],
        col * layout.cellW + layout.cellW / 2,
        row * layout.cellH + layout.cellH / 2,
      )
    }
  }

  context.globalAlpha = 1
}

function composerBox(host: HTMLElement, hostRect: DOMRect, width: number, height: number): ComposerBox | null {
  const composer = host.querySelector('.composer-shadow-wrap') ?? host.querySelector('.composer')
  if (!(composer instanceof HTMLElement)) return null
  const rect = composer.getBoundingClientRect()
  return {
    left: clamp((rect.left - hostRect.left) / width),
    right: clamp((rect.right - hostRect.left) / width),
    top: clamp((rect.top - hostRect.top) / height),
    bottom: clamp((rect.bottom - hostRect.top) / height),
  }
}

function composerEdgeBoost(x: number, y: number, box: ComposerBox | null): number {
  if (!box) return 0
  const horizontal = smooth(clamp((x - box.left + 0.055) / 0.09)) * smooth(clamp((box.right - x + 0.055) / 0.09))
  const topBand = edgeBand(Math.abs(y - box.top), 0.055)
  const bottomBand = edgeBand(Math.abs(y - box.bottom), 0.055)
  return Math.max(topBand, bottomBand) * horizontal * EDGE_ALPHA_BOOST
}

function edgeBand(distance: number, radius: number): number {
  return Math.pow(smooth(clamp(1 - distance / radius)), 1.25)
}

function randomGlyphInterval(): number {
  return MIN_GLYPH_INTERVAL_MS + Math.random() * (MAX_GLYPH_INTERVAL_MS - MIN_GLYPH_INTERVAL_MS)
}

function nextGlyph(current: number, seed: number, now: number): number {
  const offset = 1 + ((seed + Math.floor(now * 0.037)) % (CHARS.length - 1))
  return (current + offset) % CHARS.length
}

function backdropAlpha(x: number, y: number, areaScale: number, box: ComposerBox | null): number {
  const restProgress = clamp((areaScale - FOCUS_AREA_SCALE) / (REST_AREA_SCALE - FOCUS_AREA_SCALE))
  const verticalScale = areaScale * lerp(1, REST_VERTICAL_SCALE, restProgress)
  const centerX = box ? (box.left + box.right) / 2 : 0.5
  const centerY = box ? (box.top + box.bottom) / 2 : 0.5
  const mainGlow = ellipseFalloff(x, y, centerX, centerY, 0.47 * areaScale, 0.26 * verticalScale)
  const coreGlow = ellipseFalloff(x, y, centerX, centerY, 0.34 * areaScale, 0.18 * verticalScale)
  const centerLift = 0.7 + 0.3 * Math.cos((x - centerX) * Math.PI)
  return (mainGlow * 0.94 + coreGlow * 0.28) * centerLift * MAX_ALPHA
}

function ellipseFalloff(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return Math.pow(clamp(1 - dx * dx - dy * dy), 1.5)
}

function clamp(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value)
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

function targetAreaScale(host: HTMLElement): number {
  return isComposerEngaged(host) ? FOCUS_AREA_SCALE : REST_AREA_SCALE
}

function animatedCellDivisor(host: HTMLElement): number {
  return isComposerEngaged(host) ? FOCUS_ANIMATED_CELL_DIVISOR : REST_ANIMATED_CELL_DIVISOR
}

function isComposerEngaged(host: HTMLElement): boolean {
  const composer = host.querySelector('.composer-shadow-wrap') ?? host.querySelector('.composer')
  const activeElement = document.activeElement
  return Boolean(composer instanceof HTMLElement && (
    (activeElement && composer.contains(activeElement)) ||
    composer.matches(':hover')
  ))
}

function cssColor(element: HTMLElement, property: string, fallback: string): string {
  const styles = getComputedStyle(element)
  const value = styles.getPropertyValue(property).trim()
  if (!value) return fallback
  const variableMatch = value.match(/^var\((--[\w-]+)\)$/)
  if (!variableMatch) return value
  return styles.getPropertyValue(variableMatch[1]).trim() || fallback
}

function addMotionListener(query: MediaQueryList, listener: () => void) {
  if ('addEventListener' in query) query.addEventListener('change', listener)
  else (query as unknown as { addListener: (listener: () => void) => void }).addListener(listener)
}

function removeMotionListener(query: MediaQueryList, listener: () => void) {
  if ('removeEventListener' in query) query.removeEventListener('change', listener)
  else (query as unknown as { removeListener: (listener: () => void) => void }).removeListener(listener)
}
