import { useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from './layers.js'
import { jotStyles } from './styles.js'
import { ModalLayerContext } from './Modal.js'
import { JotActionIcon, type JotActionIconName } from './icons.js'

export interface ActionMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  icon?: JotActionIconName
  /** A defined value marks this item as a radio choice within its menu. */
  checked?: boolean
}
/** Non-interactive structure: a divider or a small group caption. */
export type ActionMenuEntry = ActionMenuItem | { separator: true } | { heading: string }
const isItem = (entry: ActionMenuEntry): entry is ActionMenuItem => 'onSelect' in entry
/** Dividers never lead, trail or repeat, whichever optional groups a caller included. */
export function tidyMenuEntries(entries: readonly ActionMenuEntry[]): ActionMenuEntry[] {
  const result: ActionMenuEntry[] = []
  for (const entry of entries) {
    if ('separator' in entry && (!result.length || 'separator' in result.at(-1)!)) continue
    result.push(entry)
  }
  while (result.length && 'separator' in result.at(-1)!) result.pop()
  return result
}
export interface ActionMenuProps {
  triggerLabel: string
  items: readonly ActionMenuEntry[]
  /** Context menus open on mount at this point and do not add a trigger. */
  position?: { x: number; y: number }
  /** In context mode the caller can unmount the menu when this fires. */
  onClose?: () => void
  triggerIcon?: JotActionIconName
  triggerClassName?: string
}

export function ActionMenu({ triggerLabel, items: entries, position, onClose, triggerIcon = 'more', triggerClassName }: ActionMenuProps) {
  const items = tidyMenuEntries(entries)
  const id = useId()
  const modalOwner = useContext(ModalLayerContext)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const previousFocus = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(Boolean(position))
  const isOpen = useRef(open)
  isOpen.current = open
  const initialFocus = useRef(true)
  const [active, setActive] = useState(() => items.findIndex(item => isItem(item) && !item.disabled))
  const [coordinates, setCoordinates] = useState<{ left: number; top: number } | null>(null)
  const closeCallback = useRef(onClose)
  closeCallback.current = onClose
  const enabled = items.flatMap((item, index) => isItem(item) && !item.disabled ? [index] : [])
  // Align labels when only some rows carry an icon (for example radio choices).
  const iconSlot = items.some(item => isItem(item) && item.icon)

  const close = useCallback((restore = true) => {
    if (!isOpen.current) return
    isOpen.current = false
    setOpen(false)
    const target = trigger.current ?? previousFocus.current
    if (restore && target?.isConnected) target.focus({ preventScroll: true })
    closeCallback.current?.()
  }, [])
  const show = (last = false) => {
    initialFocus.current = true
    isOpen.current = true
    setActive(last ? enabled.at(-1) ?? -1 : enabled[0] ?? -1)
    setCoordinates(null)
    setOpen(true)
  }

  useEffect(() => {
    if (position) { initialFocus.current = true; isOpen.current = true; setOpen(true); setCoordinates(null); setActive(items.findIndex(item => isItem(item) && !item.disabled)) }
  }, [position?.x, position?.y])

  useEffect(() => {
    if (!open || !menu.current) return
    const element = menu.current
    const document = element.ownerDocument
    const view = document.defaultView
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const relocate = () => {
      if (!view) return
      const bounds = element.getBoundingClientRect()
      const anchor = trigger.current?.getBoundingClientRect()
      // Menus grow toward the inline end: under the trigger's end edge, or from the pointer (leftward in Arabic).
      const owner = trigger.current ?? previousFocus.current
      const rtl = owner ? view.getComputedStyle(owner).direction === 'rtl' : false
      const x = position ? position.x - (rtl ? bounds.width : 0) : anchor ? (rtl ? anchor.left : anchor.right - bounds.width) : 8
      const y = position?.y ?? (anchor ? anchor.bottom + 4 : 8)
      setCoordinates({
        left: Math.min(Math.max(8, x), Math.max(8, view.innerWidth - bounds.width - 8)),
        top: Math.min(Math.max(8, y), Math.max(8, view.innerHeight - bounds.height - 8)),
      })
    }
    relocate()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!element.contains(target) && !trigger.current?.contains(target)) close()
    }
    const focusOutside = (event: FocusEvent) => {
      const target = event.target as Node
      if (!element.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', focusOutside, true)
    view?.addEventListener('resize', relocate)
    view?.addEventListener('scroll', relocate, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', focusOutside, true)
      view?.removeEventListener('resize', relocate)
      view?.removeEventListener('scroll', relocate, true)
      // Releasing a context menu or whole plugin must also restore focus.
      const target = trigger.current ?? previousFocus.current
      if (element.contains(document.activeElement) && target?.isConnected) target.focus({ preventScroll: true })
    }
  }, [open, position?.x, position?.y, close])

  useEffect(() => {
    // A hidden popup cannot receive browser focus. Wait for measured/clamped
    // coordinates to render before handing keyboard ownership to the menu.
    if (!open || !coordinates || !initialFocus.current) return
    initialFocus.current = false
    ;(buttons.current.get(active) ?? menu.current)?.focus({ preventScroll: true })
  }, [open, coordinates, active])

  useEffect(() => {
    if (!open) return
    if (!enabled.includes(active)) {
      const next = enabled[0] ?? -1
      setActive(next)
      ;(buttons.current.get(next) ?? menu.current)?.focus({ preventScroll: true })
    }
  }, [items, open, active])

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); return }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const current = enabled.indexOf(active)
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
      : enabled[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]
    if (next === undefined) return
    setActive(next); buttons.current.get(next)?.focus({ preventScroll: true })
  }

  const popup = open && typeof document !== 'undefined' ? createPortal(<div className="jot-overlay-root" data-jot-modal-layer={modalOwner ?? undefined}>
    <style>{jotStyles}</style>
    <div ref={menu} id={id} role="menu" aria-label={triggerLabel} className="jot-menu" tabIndex={-1} onKeyDown={keyboard}
      style={{ position: 'fixed', left: coordinates?.left ?? 0, top: coordinates?.top ?? 0,
        right: 'auto', visibility: coordinates ? 'visible' : 'hidden', maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', zIndex: modalOwner ? 60 : 40 }}>
      {items.map((item, index) => {
        if (!isItem(item)) return 'separator' in item
          ? <div key={index} role="separator" />
          : <div key={index} role="presentation" className="jot-menu-heading">{item.heading}</div>
        return <button type="button" key={index} role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked} disabled={item.disabled}
          className={item.danger ? 'jot-danger' : undefined} tabIndex={index === active ? 0 : -1}
          ref={element => { if (element) buttons.current.set(index, element); else buttons.current.delete(index) }}
          onFocus={() => setActive(index)} onClick={() => { close(); item.onSelect() }}>
          {item.icon ? <JotActionIcon name={item.icon} className="jot-menu-item-icon" />
            : iconSlot && <span aria-hidden="true" className="jot-menu-item-icon-slot" />}
          <span className="jot-menu-item-label">{item.label}</span>
          {item.checked && <span aria-hidden="true" className="jot-menu-item-check">✓</span>}
        </button>
      })}
    </div>
  </div>, document.body) : null

  return <span className="jot-menu-anchor">
    {!position && <button ref={trigger} type="button" className={['jot-icon-btn', triggerClassName].filter(Boolean).join(' ')} aria-label={triggerLabel} title={triggerLabel}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault(); event.stopPropagation(); show(event.key === 'ArrowUp')
      }}>
      <JotActionIcon name={triggerIcon} />
    </button>}
    {popup}
  </span>
}

export default ActionMenu
