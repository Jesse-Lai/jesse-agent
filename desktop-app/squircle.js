import { getSvgPath } from 'figma-squircle'

const CORNER_SMOOTHING = 1
const CIRCLE_TOLERANCE = 0.75
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

function initSquircles(root = document) {
  const elements = new Set()
  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) updateSquircle(entry.target)
  })

  function register(element) {
    if (!(element instanceof HTMLElement) || elements.has(element)) return
    if (shouldIgnoreSquircle(element)) return
    if (!hasRoundedCorners(element)) return
    elements.add(element)
    resizeObserver.observe(element)
    updateSquircle(element)
  }

  function registerTree(node) {
    if (!(node instanceof Element)) return
    register(node)
    for (const element of node.querySelectorAll('*')) register(element)
  }

  function unregisterTree(node) {
    if (!(node instanceof Element)) return
    unregister(node)
    for (const element of node.querySelectorAll('*')) unregister(element)
  }

  function unregister(element) {
    if (!elements.delete(element)) return
    resizeObserver.unobserve(element)
  }

  function updateSquircle(element) {
    if (shouldIgnoreSquircle(element)) {
      clearSquircle(element)
      unregister(element)
      return
    }

    if (!element.isConnected) {
      unregister(element)
      return
    }

    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      clearSquircle(element)
      return
    }

    const radii = cornerRadii(element, rect)
    if (radii.every(radius => radius <= 0) || isCircle(rect, radii)) {
      clearSquircle(element)
      return
    }

    const path = getSvgPath({
      width: round(rect.width),
      height: round(rect.height),
      topLeftCornerRadius: radii[0],
      topRightCornerRadius: radii[1],
      bottomRightCornerRadius: radii[2],
      bottomLeftCornerRadius: radii[3],
      cornerSmoothing: CORNER_SMOOTHING,
    })
    const clipPath = `path('${path}')`
    element.style.clipPath = clipPath
    element.style.webkitClipPath = clipPath
    element.dataset.squircle = 'true'
    updateSquircleStroke(element, rect, radii)
  }

  const mutationObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (shouldIgnoreSquircle(record.target)) {
          clearSquircle(record.target)
          unregister(record.target)
        } else {
          register(record.target)
        }
        continue
      }
      for (const node of record.removedNodes) unregisterTree(node)
      for (const node of record.addedNodes) registerTree(node)
    }
  })

  registerTree(root.documentElement)
  mutationObserver.observe(root.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-squircle-ignore'],
  })
  root.fonts?.ready.then(() => {
    for (const element of elements) updateSquircle(element)
  })

  return () => {
    mutationObserver.disconnect()
    resizeObserver.disconnect()
    elements.clear()
  }
}

function hasRoundedCorners(element) {
  const style = getComputedStyle(element)
  return [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].some(radius => parseFloat(radius) > 0)
}

function shouldIgnoreSquircle(element) {
  return element.hasAttribute('data-squircle-ignore')
}

function cornerRadii(element, rect) {
  const style = getComputedStyle(element)
  const maxRadius = Math.min(rect.width, rect.height) / 2
  return [
    resolveRadius(style.borderTopLeftRadius, rect, maxRadius),
    resolveRadius(style.borderTopRightRadius, rect, maxRadius),
    resolveRadius(style.borderBottomRightRadius, rect, maxRadius),
    resolveRadius(style.borderBottomLeftRadius, rect, maxRadius),
  ]
}

function resolveRadius(value, rect, maxRadius) {
  const numeric = parseFloat(value) || 0
  const radius = value.includes('%') ? numeric / 100 * Math.min(rect.width, rect.height) : numeric
  return round(Math.min(radius, maxRadius))
}

function isCircle(rect, radii) {
  const radius = Math.min(rect.width, rect.height) / 2
  return Math.abs(rect.width - rect.height) <= CIRCLE_TOLERANCE
    && radii.every(value => value >= radius - CIRCLE_TOLERANCE)
}

function clearSquircle(element) {
  element.style.removeProperty('clip-path')
  element.style.removeProperty('-webkit-clip-path')
  delete element.dataset.squircle
  element.querySelector(':scope > .squircle-stroke-layer')?.remove()
}

function updateSquircleStroke(element, rect, radii) {
  const stroke = element.dataset.squircleStroke
  const strokeWidth = Number(element.dataset.squircleStrokeWidth)
  if (!stroke || !Number.isFinite(strokeWidth) || strokeWidth <= 0) return

  let svg = element.querySelector(':scope > .squircle-stroke-layer')
  if (!svg) {
    svg = document.createElementNS(SVG_NAMESPACE, 'svg')
    svg.classList.add('squircle-stroke-layer')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    svg.append(createStrokePath('squircle-stroke-base'))
    svg.append(createStrokePath('squircle-stroke-focus'))
    element.append(svg)
  }

  const width = round(rect.width)
  const height = round(rect.height)
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  updateStrokePath(svg.querySelector('.squircle-stroke-base'), width, height, radii, stroke, strokeWidth)

  const focusStroke = element.dataset.squircleFocusStroke
  const focusStrokeWidth = Number(element.dataset.squircleFocusStrokeWidth)
  const focusPath = svg.querySelector('.squircle-stroke-focus')
  if (focusStroke && Number.isFinite(focusStrokeWidth) && focusStrokeWidth > 0) {
    updateStrokePath(focusPath, width, height, radii, focusStroke, focusStrokeWidth)
  } else {
    focusPath.removeAttribute('d')
  }
}

function createStrokePath(className) {
  const path = document.createElementNS(SVG_NAMESPACE, 'path')
  path.classList.add(className)
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('vector-effect', 'non-scaling-stroke')
  return path
}

function updateStrokePath(path, width, height, radii, color, strokeWidth) {
  const inset = strokeWidth / 2
  const pathWidth = round(Math.max(1, width - strokeWidth))
  const pathHeight = round(Math.max(1, height - strokeWidth))
  const insetRadii = radii.map(radius => round(Math.max(0, radius - inset)))
  const pathData = getSvgPath({
    width: pathWidth,
    height: pathHeight,
    topLeftCornerRadius: insetRadii[0],
    topRightCornerRadius: insetRadii[1],
    bottomRightCornerRadius: insetRadii[2],
    bottomLeftCornerRadius: insetRadii[3],
    cornerSmoothing: CORNER_SMOOTHING,
  })

  path.setAttribute('d', pathData)
  path.setAttribute('transform', `translate(${inset} ${inset})`)
  path.setAttribute('stroke', color)
  path.setAttribute('stroke-width', String(strokeWidth))
}

function round(value) {
  return Math.round(value * 100) / 100
}

initSquircles()
