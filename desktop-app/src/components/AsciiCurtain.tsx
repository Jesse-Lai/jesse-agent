import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { MutableRefObject } from 'react'

const CHARS = '01<>[]{}()/\\|=+*#%&$@!?;:.~01ABCDEF0123456789'
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const DURATION_MS = 540
const REDUCED_MOTION_DURATION_MS = 180
const MIN_TEXT_PULSE = 0.1
const MAX_TEXT_ALPHA = 0.8

export interface AsciiCurtainHandle {
  transition<T>(action: () => Promise<T> | T): Promise<T>
}

type Phase = 'cover' | 'reveal'

interface Layout {
  width: number
  height: number
  cols: number
  rows: number
  cellW: number
  cellH: number
  bg: string
  fg: string
  coverOffsets: Float32Array
  revealOffsets: Float32Array
  seeds: Uint16Array
  flicker: Float32Array
}

export const AsciiCurtain = forwardRef<AsciiCurtainHandle>(function AsciiCurtain(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<number | null>(null)
  const busyRef = useRef(false)

  useEffect(() => () => clearFrame(frameRef), [])

  useImperativeHandle(ref, () => ({
    async transition<T>(action: () => Promise<T> | T): Promise<T> {
      if (busyRef.current) return await action()

      const canvas = canvasRef.current
      const host = canvas?.parentElement
      const context = canvas?.getContext('2d')
      if (!canvas || !host || !context) return await action()

      busyRef.current = true
      clearFrame(frameRef)
      const layout = createLayout(canvas, context, host)

      await play(canvas, context, frameRef, layout, 'cover')
      try {
        const result = await action()
        await nextPaint()
        await play(canvas, context, frameRef, layout, 'reveal')
        return result
      } catch (error) {
        await nextPaint()
        await play(canvas, context, frameRef, layout, 'reveal')
        throw error
      } finally {
        clearCanvas(canvas, frameRef)
        busyRef.current = false
      }
    },
  }), [])

  return <canvas ref={canvasRef} className="ascii-curtain" aria-hidden="true" />
})

async function play(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  frameRef: MutableRefObject<number | null>,
  layout: Layout,
  phase: Phase,
): Promise<void> {
  clearFrame(frameRef)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const duration = reducedMotion ? REDUCED_MOTION_DURATION_MS : DURATION_MS
  const startedAt = performance.now()

  canvas.dataset.phase = phase

  await new Promise<void>(resolve => {
    const tick = (now: number) => {
      const progress = clamp((now - startedAt) / duration)
      if (reducedMotion) drawReduced(context, layout, phase, progress)
      else drawAscii(context, layout, phase, progress, now)

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick)
        return
      }
      resolve()
    }
    frameRef.current = requestAnimationFrame(tick)
  })
}

function createLayout(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, host: HTMLElement): Layout {
  const rect = host.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cols = Math.max(24, Math.round(width / 12))
  const rows = Math.max(14, Math.round(height / 17))
  const count = cols * rows
  const seeds = new Uint16Array(count)
  const flicker = new Float32Array(count)

  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  context.setTransform(dpr, 0, 0, dpr, 0, 0)

  for (let index = 0; index < count; index += 1) {
    seeds[index] = Math.floor(Math.random() * 65535)
    flicker[index] = 70 + Math.random() * 120
  }

  return {
    width,
    height,
    cols,
    rows,
    cellW: width / cols,
    cellH: height / rows,
    bg: cssColor(host, '--ascii-transition-bg', '#05070a'),
    fg: cssColor(host, '--ascii-transition-color', '#f7f9fc'),
    coverOffsets: makeOffsets(cols, rows),
    revealOffsets: makeOffsets(cols, rows),
    seeds,
    flicker,
  }
}

function drawReduced(context: CanvasRenderingContext2D, layout: Layout, phase: Phase, progress: number) {
  context.clearRect(0, 0, layout.width, layout.height)
  context.globalAlpha = phase === 'cover' ? progress : 1 - progress
  context.fillStyle = layout.bg
  context.fillRect(0, 0, layout.width, layout.height)
  context.globalAlpha = 1
}

function drawAscii(context: CanvasRenderingContext2D, layout: Layout, phase: Phase, progress: number, now: number) {
  const offsets = phase === 'cover' ? layout.coverOffsets : layout.revealOffsets

  context.clearRect(0, 0, layout.width, layout.height)
  context.fillStyle = layout.bg
  context.beginPath()

  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const index = row * layout.cols + col
      const local = clamp((progress - offsets[index]) * 8.4)
      const coverage = phase === 'cover' ? local : 1 - local
      if (coverage >= 0.35) {
        context.rect(
          Math.floor(col * layout.cellW),
          Math.floor(row * layout.cellH),
          Math.ceil(layout.cellW) + 1,
          Math.ceil(layout.cellH) + 1,
        )
      }
    }
  }
  context.fill()

  context.fillStyle = layout.fg
  context.font = `${Math.max(10, Math.round(layout.cellH * 0.86))}px ${FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const index = row * layout.cols + col
      const local = clamp((progress - offsets[index]) * 8.4)
      const coverage = phase === 'cover' ? local : 1 - local
      if (coverage <= 0.03) continue

      const seed = layout.seeds[index]
      const tick = Math.floor((now + seed) / layout.flicker[index])
      const unstable = local > 0 && local < 1
      const pulseCenter = (MIN_TEXT_PULSE + MAX_TEXT_ALPHA) / 2
      const pulseRange = (MAX_TEXT_ALPHA - MIN_TEXT_PULSE) / 2
      const pulse = pulseCenter + pulseRange * Math.sin(now * 0.004 + seed)
      context.globalAlpha = Math.min(MAX_TEXT_ALPHA, clamp((unstable ? 1 : pulse) * coverage * 1.35))
      context.fillText(
        CHARS[(seed + tick) % CHARS.length],
        col * layout.cellW + layout.cellW / 2,
        row * layout.cellH + layout.cellH / 2,
      )
    }
  }
  context.globalAlpha = 1
}

function makeOffsets(cols: number, rows: number): Float32Array {
  const noiseCols = 7
  const noiseRows = 5
  const anchors = Array.from({ length: noiseCols * noiseRows }, () => Math.random())
  const values = new Float32Array(cols * rows)
  let min = Infinity
  let max = -Infinity

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = (col / Math.max(1, cols - 1)) * (noiseCols - 1)
      const y = (row / Math.max(1, rows - 1)) * (noiseRows - 1)
      const ix = Math.min(noiseCols - 2, Math.floor(x))
      const iy = Math.min(noiseRows - 2, Math.floor(y))
      const fx = smooth(x - ix)
      const fy = smooth(y - iy)
      const base = iy * noiseCols + ix
      const top = lerp(anchors[base], anchors[base + 1], fx)
      const bottom = lerp(anchors[base + noiseCols], anchors[base + noiseCols + 1], fx)
      const value = lerp(top, bottom, fy) + (Math.random() - 0.5) * 0.08
      const index = row * cols + col
      values[index] = value
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  }

  const span = max - min || 1
  for (let index = 0; index < values.length; index += 1) {
    values[index] = ((values[index] - min) / span) * 0.88
  }
  return values
}

function clearCanvas(canvas: HTMLCanvasElement | null, frameRef: MutableRefObject<number | null>) {
  clearFrame(frameRef)
  if (!canvas) return
  const context = canvas.getContext('2d')
  context?.clearRect(0, 0, canvas.width, canvas.height)
  canvas.dataset.phase = 'idle'
}

function clearFrame(frameRef: MutableRefObject<number | null>) {
  if (frameRef.current === null) return
  cancelAnimationFrame(frameRef.current)
  frameRef.current = null
}

async function nextPaint(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
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

function cssColor(element: HTMLElement, property: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(property).trim() || fallback
}
