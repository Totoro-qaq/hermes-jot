import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Browser-owned top layer: keeps React ownership and avoids a second ReactDOM runtime. */
function TopLayer({ children }: { children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    node.showPopover()
    return () => { if (node.matches(':popover-open')) node.hidePopover() }
  }, [])
  return <div ref={element} popover="manual" className="jot-top-layer"
    style={{ position: 'fixed', inset: 0, margin: 0, padding: 0, border: 0, width: '100vw', height: '100vh',
      maxWidth: 'none', maxHeight: 'none', overflow: 'visible', pointerEvents: 'none', background: 'transparent' }}>
    {children}
  </div>
}

export function createPortal(children: ReactNode, _target: Element | DocumentFragment): ReactNode {
  return <TopLayer>{children}</TopLayer>
}
