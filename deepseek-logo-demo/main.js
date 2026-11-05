const canvas = document.querySelector('#signal-field')
const context = canvas.getContext('2d')
const stage = document.querySelector('#logo-stage')
const logoButton = document.querySelector('#logo-button')
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

const GLYPHS = '01<>[]{}()/\\|=+*#%&$@!?;:.~DEEPSEEK'
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const LOGO_PATH = new Path2D('M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45')

let width = 0
let height = 0
let cells = []
let frame = 0
let pulseStartedAt = -Infinity
let pulseTimeout = 0

const pointer = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  targetX: window.innerWidth / 2,
  targetY: window.innerHeight / 2,
  active: false,
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = window.innerWidth
  height = window.innerHeight
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  context.setTransform(dpr, 0, 0, dpr, 0, 0)

  const spacing = Math.max(15, Math.min(21, Math.round(width / 80)))
  const cols = Math.ceil(width / spacing) + 1
  const rows = Math.ceil(height / spacing) + 1
  cells = []

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const seed = Math.random() * 1000
      cells.push({
        x: col * spacing,
        y: row * spacing,
        seed,
        glyph: GLYPHS[Math.floor(seed) % GLYPHS.length],
      })
    }
  }
}

function draw(now) {
  context.clearRect(0, 0, width, height)

  pointer.x += (pointer.targetX - pointer.x) * 0.08
  pointer.y += (pointer.targetY - pointer.y) * 0.08

  const rect = logoButton.getBoundingClientRect()
  const logoSize = rect.width
  const logoLeft = rect.left
  const logoTop = rect.top
  const logoCenterX = rect.left + rect.width / 2
  const logoCenterY = rect.top + rect.height / 2
  const pulseAge = now - pulseStartedAt
  const pulseRadius = pulseAge > 0 && pulseAge < 1100 ? easeOut(pulseAge / 1100) * Math.max(width, height) * 0.66 : -1

  context.font = `10px ${FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  for (const cell of cells) {
    const dx = cell.x - pointer.x
    const dy = cell.y - pointer.y
    const pointerDistance = Math.hypot(dx, dy)
    const influence = pointer.active ? clamp(1 - pointerDistance / 170) : 0
    const waveX = reducedMotion.matches ? 0 : Math.sin(now * 0.0007 + cell.seed) * 2.4
    const waveY = reducedMotion.matches ? 0 : Math.cos(now * 0.00055 + cell.seed * 0.7) * 1.8
    const repel = influence * influence * 21
    const drawX = cell.x + waveX + (dx / Math.max(pointerDistance, 1)) * repel
    const drawY = cell.y + waveY + (dy / Math.max(pointerDistance, 1)) * repel

    const logoX = ((cell.x - logoLeft) / logoSize) * 24
    const logoY = ((cell.y - logoTop) / logoSize) * 24
    const inLogo = logoX >= 0 && logoX <= 24 && logoY >= 0 && logoY <= 24 &&
      context.isPointInPath(LOGO_PATH, logoX, logoY)
    const centerDistance = Math.hypot(cell.x - logoCenterX, cell.y - logoCenterY)
    const halo = clamp(1 - centerDistance / (logoSize * 1.7))
    const pulseDistance = Math.abs(centerDistance - pulseRadius)
    const onPulse = pulseRadius > 0 ? clamp(1 - pulseDistance / 38) : 0
    const gridLine = (Math.round(cell.x) % 48 < 11 || Math.round(cell.y) % 48 < 11) ? 0.55 : 1
    const shimmer = 0.76 + Math.sin(now * 0.002 + cell.seed) * 0.24
    let alpha = 0.035 * gridLine + halo * 0.08 + influence * 0.35 + onPulse * 0.72

    if (inLogo) alpha = Math.max(alpha, 0.34 * shimmer + influence * 0.28)
    if (alpha < 0.025) continue

    context.fillStyle = inLogo || onPulse > 0.1
      ? `rgba(46, 99, 238, ${Math.min(0.9, alpha)})`
      : `rgba(16, 32, 75, ${Math.min(0.5, alpha)})`
    context.fillText(cell.glyph, drawX, drawY)

    if (!reducedMotion.matches && Math.floor(now / 900 + cell.seed) % 29 === 0) {
      cell.glyph = GLYPHS[(GLYPHS.indexOf(cell.glyph) + 1) % GLYPHS.length]
    }
  }

  if (pulseRadius > 0) {
    context.strokeStyle = `rgba(87, 134, 254, ${0.55 * (1 - pulseAge / 1100)})`
    context.lineWidth = 1
    context.beginPath()
    context.arc(logoCenterX, logoCenterY, pulseRadius, 0, Math.PI * 2)
    context.stroke()
  }

  if (!reducedMotion.matches) frame = requestAnimationFrame(draw)
}

function updatePointer(event) {
  pointer.targetX = event.clientX
  pointer.targetY = event.clientY
  pointer.active = true
  document.documentElement.style.setProperty('--mx', `${(event.clientX / width) * 100}%`)
  document.documentElement.style.setProperty('--my', `${(event.clientY / height) * 100}%`)

  const rect = stage.getBoundingClientRect()
  const nx = (event.clientX - rect.left) / rect.width - 0.5
  const ny = (event.clientY - rect.top) / rect.height - 0.5
  const engaged = Math.hypot(nx, ny) < 0.3
  stage.classList.toggle('is-engaged', engaged)
  logoButton.style.setProperty('--tilt-x', `${clamp(nx * 2, -1, 1) * 10}deg`)
  logoButton.style.setProperty('--tilt-y', `${clamp(ny * -2, -1, 1) * 10}deg`)
}

function resetPointer() {
  pointer.active = false
  pointer.targetX = width / 2
  pointer.targetY = height / 2
  stage.classList.remove('is-engaged')
  logoButton.style.setProperty('--tilt-x', '0deg')
  logoButton.style.setProperty('--tilt-y', '0deg')
}

function triggerPulse() {
  pulseStartedAt = performance.now()
  stage.classList.remove('is-pulsing')
  void stage.offsetWidth
  stage.classList.add('is-pulsing')
  window.clearTimeout(pulseTimeout)
  pulseTimeout = window.setTimeout(() => stage.classList.remove('is-pulsing'), 950)
  if (reducedMotion.matches) draw(performance.now())
}

function handleMotionChange() {
  cancelAnimationFrame(frame)
  if (reducedMotion.matches) draw(performance.now())
  else frame = requestAnimationFrame(draw)
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value))
}

function easeOut(value) {
  return 1 - Math.pow(1 - clamp(value), 3)
}

window.addEventListener('resize', resize)
window.addEventListener('pointermove', updatePointer)
document.documentElement.addEventListener('pointerleave', resetPointer)
logoButton.addEventListener('click', triggerPulse)
reducedMotion.addEventListener('change', handleMotionChange)

resize()
handleMotionChange()
window.setTimeout(triggerPulse, 550)
