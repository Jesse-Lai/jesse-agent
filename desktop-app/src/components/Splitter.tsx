import { useEffect } from 'react'

const STORAGE_KEY = 'jesse.sidebarWidth'
const SHELL_INSET = 8

export function Splitter() {
  useEffect(() => {
    const savedWidth = Number(localStorage.getItem(STORAGE_KEY) || 0)
    setSidebarWidth(savedWidth >= 240 && savedWidth <= 320 ? savedWidth : 320)
  }, [])

  return (
    <div
      className="splitter"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      onPointerDown={event => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        document.body.classList.add('resizing')
      }}
      onPointerMove={event => {
        if (document.body.classList.contains('resizing')) setSidebarWidth(event.clientX - SHELL_INSET)
      }}
      onPointerUp={event => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        document.body.classList.remove('resizing')
        localStorage.setItem(STORAGE_KEY, String(currentSidebarWidth()))
      }}
    />
  )
}

function setSidebarWidth(width: number) {
  const clamped = Math.max(240, Math.min(320, Math.round(width)))
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`)
}

function currentSidebarWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')
  return Number(raw.replace('px', '').trim()) || 320
}
