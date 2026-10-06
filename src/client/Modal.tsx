import { createContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from './layers.js'
import { jotStyles } from './styles.js'
import { JotActionIcon } from './icons.js'

export interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  closeLabel?: string
  /** Short forms and confirmations use a narrower dialog. */
  size?: 'small' | 'default'
}

// Compact and wide views can both mount a dialog. Only the top dialog traps
// focus; otherwise two independent focusin handlers would fight each other.
const dialogs: HTMLElement[] = []
/** Portal popups rendered by dialog children retain their logical modal owner. */
export const ModalLayerContext = createContext<string | null>(null)
function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button,input,select,textarea,a[href],[tabindex]',
  )].filter(element => element.tabIndex >= 0 && !element.matches('[disabled],[aria-disabled="true"]')
    && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0)
}
function focusFirst(container: HTMLElement): void {
  const preferred = container.querySelector<HTMLElement>('[autofocus],[data-autofocus]')
  const elements = focusable(container)
  ;(preferred && elements.includes(preferred) ? preferred : elements[0] ?? container).focus({ preventScroll: true })
}

/** A pane-independent dialog with a bounded keyboard focus lifetime. */
export function Modal({ title, onClose, children, footer, closeLabel = 'Close', size = 'default' }: ModalProps) {
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const backdropPress = useRef(false)

  useEffect(() => {
    const container = dialog.current
    if (!container) return
    const document = container.ownerDocument
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogs.push(container)
    const top = () => dialogs.at(-1) === container
    const ownPopup = (target: EventTarget | null) => target instanceof Element
      && !container.contains(target) && target.closest('[data-jot-modal-layer]')?.getAttribute('data-jot-modal-layer') === titleId
    if (!container.contains(document.activeElement)) focusFirst(container)
    const keydown = (event: KeyboardEvent) => {
      if (!top() || event.isComposing || event.keyCode === 229 || ownPopup(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current(); return
      }
      if (event.key !== 'Tab') return
      const elements = focusable(container)
      const index = elements.indexOf(document.activeElement as HTMLElement)
      if (!elements.length) { event.preventDefault(); container.focus(); return }
      if (index < 0 || (event.shiftKey ? index === 0 : index === elements.length - 1)) {
        event.preventDefault()
        elements[event.shiftKey ? elements.length - 1 : 0]!.focus({ preventScroll: true })
      }
    }
    const focusin = (event: FocusEvent) => {
      if (top() && !container.contains(event.target as Node) && !ownPopup(event.target)) focusFirst(container)
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin, true)
    return () => {
      const wasTop = top()
      const index = dialogs.indexOf(container)
      if (index >= 0) dialogs.splice(index, 1)
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin, true)
      if (wasTop && previous?.isConnected) previous.focus({ preventScroll: true })
      else if (wasTop && dialogs.at(-1)) focusFirst(dialogs.at(-1)!)
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(<ModalLayerContext.Provider value={titleId}><div className="jot-overlay-root">
    <style>{jotStyles}</style>
    <div className="jot-modal-backdrop" onMouseDown={event => { backdropPress.current = event.target === event.currentTarget }}
      onClick={event => { if (event.target === event.currentTarget && backdropPress.current) onClose() }}>
      <div ref={dialog} className={`jot-modal${size === 'small' ? ' is-small' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="jot-modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="jot-icon-btn" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
            <JotActionIcon name="close" />
          </button>
        </div>
        <div className="jot-modal-body">{children}</div>
        {footer !== undefined && <div className="jot-modal-footer">{footer}</div>}
      </div>
    </div>
  </div></ModalLayerContext.Provider>, document.body)
}

export default Modal
