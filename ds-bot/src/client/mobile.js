import { useEffect, useState } from 'react'

// -------------------------------------------------------------------------
// Phone-width layout: JS branches and the MOBILE_CSS block share the one
// 768px breakpoint.

const QUERY = '(max-width:768px)'

export const isPhone = () => typeof matchMedia === 'function' && matchMedia(QUERY).matches

export function usePhone() {
  const [phone, setPhone] = useState(isPhone)
  useEffect(() => {
    const media = matchMedia(QUERY)
    const onChange = () => setPhone(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return phone
}

// The height left above the soft keyboard. window.innerHeight does not shrink
// on iOS, so menus clamped to it land behind the keyboard.
export const viewportHeight = () => {
  const view = window.visualViewport
  return view ? view.offsetTop + view.height : window.innerHeight
}

// More than one shell module names a container "_frame"; the layout's is the one
// that owns the sidebar column.
export const layoutFrame = () => document.querySelector('[class*="_frame"]:has(> [class*="_sidebarCol"])')
export const drawerOpen = () => {
  const frame = layoutFrame()
  return frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
}
