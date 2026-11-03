import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// -------------------------------------------------------------------------
// Overlays: new chat, bot exchange, details drawer, context menu

// Escape closes only the newest open layer, so a dialog over the details pane does
// not take the pane down with it.
const escapeLayers = []
const onEscapeKey = (event) => { if (event.key === 'Escape') escapeLayers.at(-1)?.current() }
// The drawer is not a React layer, but Escape still has to close it in the right
// order with any menu or pane that is open over it.
export function addEscapeLayer(onClose) {
  const ref = { current: onClose }
  if (escapeLayers.length === 0) window.addEventListener('keydown', onEscapeKey)
  escapeLayers.push(ref)
  return () => {
    const at = escapeLayers.indexOf(ref)
    if (at >= 0) escapeLayers.splice(at, 1)
    if (escapeLayers.length === 0) window.removeEventListener('keydown', onEscapeKey)
  }
}
export function useEscape(onClose) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (escapeLayers.length === 0) window.addEventListener('keydown', onEscapeKey)
    escapeLayers.push(ref)
    return () => {
      escapeLayers.splice(escapeLayers.indexOf(ref), 1)
      if (escapeLayers.length === 0) window.removeEventListener('keydown', onEscapeKey)
    }
  }, [])
}

// New chat and Bot exchanges show in place of the conversation, right of the sidebar.
export function usePaneLeft() {
  const [paneLeft, setPaneLeft] = useState(280)
  useLayoutEffect(() => {
    const column = document.querySelector('[class*="_footArea"]')?.parentElement
    if (column) setPaneLeft(Math.round(column.getBoundingClientRect().right))
  }, [])
  return paneLeft
}
