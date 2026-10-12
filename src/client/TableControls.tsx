import { useEffect, useLayoutEffect, useRef, useState } from 'react'
// This component is bundled only into the isolated editor, whose ReactDOM owns
// the table node view. Unlike menus, its controls must stay in that exact mount.
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { ActionMenu, type ActionMenuItem } from './ActionMenu.js'
import { JotActionIcon } from './icons.js'
import { translator, type JotLocale } from './i18n.js'
import { abandonWidthAnnouncement, columnDividerDelta, columnWidthChange, explicitColumnWidth, flushWidthAnnouncement, nudgeTableColumn, planWidthAnnouncement, selectedTable, TABLE_CELL_MAX_WIDTH, TABLE_CELL_MIN_WIDTH, TABLE_COLUMN_NUDGE, tableActionAllowed, tableActionTransaction, type ColumnWidthSample, type TableAction, type TableTarget, type WidthAnnouncementClock } from './table-actions.js'

interface ChromeGeometry {
  /** The table's end edge, where the append-column button and table options sit: left of the table in RTL. */
  rtl: boolean
  column: number; row: number; bottom: number; middle: number; end: number
  columnStart: number; columnWidth: number; rowStart: number; rowHeight: number
}
interface TableChrome { mount: HTMLElement; geometry: ChromeGeometry }
/** The widest --jot-table-gutter: the controls live in this band outside the table. */
export const TABLE_GUTTER = 20
/** Narrow panes shrink the band to their body padding so tables stay aligned with the text. */
export function tableGutter(shell: Element): number {
  const value = Number.parseFloat(shell.ownerDocument.defaultView?.getComputedStyle(shell).paddingTop ?? '')
  return Number.isFinite(value) && value > 0 ? Math.min(TABLE_GUTTER, value) : TABLE_GUTTER
}
const equalGeometry = (a: ChromeGeometry, b: ChromeGeometry) => Object.keys(a).every(key => a[key as keyof ChromeGeometry] === b[key as keyof ChromeGeometry])

/** A React portal into the TableView's non-document controls, not a document node. */
export function TableControls({ editor, readOnly, locale }: { editor: Editor; readOnly: boolean; locale: JotLocale }) {
  const t = translator(locale)
  const target = selectedTable(editor.state)
  const current = useRef<TableTarget | null>(target)
  current.current = target
  const documentVersion = useRef({ doc: editor.state.doc, version: 0 })
  if (documentVersion.current.doc !== editor.state.doc) documentVersion.current = { doc: editor.state.doc, version: documentVersion.current.version + 1 }
  const menuKey = `${documentVersion.current.version}:${target?.tablePos}:${target?.top}:${target?.bottom}:${target?.left}:${target?.right}`
  const [chrome, setChrome] = useState<TableChrome | null>(null)
  const [notice, setNotice] = useState('')
  const [columnWidth, setColumnWidth] = useState(TABLE_CELL_MIN_WIDTH)
  const [widthMessage, setWidthMessage] = useState('')
  const seenWidth = useRef<ColumnWidthSample | null>(null)
  const announceClock = useRef<WidthAnnouncementClock | null>(null)
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const widthSample: ColumnWidthSample | null = target
    ? { key: `${target.tablePos}:${target.right}`, width: explicitColumnWidth(target.table, target.right - 1) }
    : null
  const widthText = (width: number) => t('Column {column} width {width} pixels', { column: target?.right ?? '', width })
  useEffect(() => {
    if (!widthSample) {
      if (announceTimer.current) clearTimeout(announceTimer.current)
      announceTimer.current = null
      announceClock.current = abandonWidthAnnouncement(announceClock.current)
      return
    }
    const next = columnWidthChange(seenWidth.current, widthSample)
    const switched = Boolean(seenWidth.current && seenWidth.current.key !== widthSample.key)
    seenWidth.current = widthSample
    if (switched) {
      if (announceTimer.current) clearTimeout(announceTimer.current)
      announceTimer.current = null
      if (announceClock.current) announceClock.current = { ...announceClock.current, pending: null }
    }
    if (next === null) return
    const plan = planWidthAnnouncement(announceClock.current, next, Date.now())
    announceClock.current = plan.clock
    if (plan.announce !== null) setWidthMessage(widthText(plan.announce))
    if (plan.waitMs != null) {
      if (announceTimer.current) clearTimeout(announceTimer.current)
      const wait = plan.waitMs
      announceTimer.current = setTimeout(() => {
        announceTimer.current = null
        const flushed = flushWidthAnnouncement(announceClock.current ?? { lastAt: 0, pending: null }, Date.now())
        announceClock.current = flushed.clock
        if (flushed.announce !== null) setWidthMessage(widthText(flushed.announce))
      }, wait)
    }
  }, [widthSample?.key, widthSample?.width, locale, target?.right])
  useEffect(() => () => { if (announceTimer.current) clearTimeout(announceTimer.current) }, [])

  useEffect(() => { setNotice('') }, [target?.tablePos, target?.table])
  // Also measured again when the locale changes: its direction mirrors the table without resizing it.
  useLayoutEffect(() => {
    if (!target || readOnly) { setChrome(null); return }
    const shell = editor.view.nodeDOM(target.tablePos)
    if (!(shell instanceof HTMLElement)) { setChrome(null); return }
    const controls = shell.querySelector<HTMLElement>('.jot-table-chrome-mount')
    const viewport = shell.querySelector<HTMLElement>('.jot-table-viewport')
    const table = shell.querySelector<HTMLTableElement>('table')
    if (!controls || !viewport || !table) { setChrome(null); return }
    shell.dataset.jotTableActive = 'true'
    const measure = () => {
      const selected = current.current
      if (!selected || !shell.isConnected) return
      const cell = editor.view.nodeDOM(selected.tableStart + selected.map.map[selected.top * selected.map.width + selected.left]!)
      if (!(cell instanceof HTMLElement)) return
      const bounds = shell.getBoundingClientRect()
      const area = viewport.getBoundingClientRect()
      const tableBounds = table.getBoundingClientRect()
      const cellBounds = cell.getBoundingClientRect()
      const rowBounds = table.rows[selected.top]?.getBoundingClientRect() ?? cellBounds
      const gutter = tableGutter(shell)
      const visibleLeft = Math.max(tableBounds.left, area.left)
      const visibleRight = Math.min(tableBounds.right, area.right)
      const clampX = (x: number) => Math.max(gutter, Math.min(bounds.width - gutter - 28, x))
      const rtl = shell.ownerDocument.defaultView?.getComputedStyle(shell).direction === 'rtl'
      const explicit = explicitColumnWidth(selected.table, selected.right - 1)
      const columnElement = table.querySelectorAll('col')[selected.right - 1] as HTMLElement | undefined
      const raw = columnElement?.offsetWidth || cell.offsetWidth || TABLE_CELL_MIN_WIDTH
      const measured = explicit ?? Math.max(TABLE_CELL_MIN_WIDTH, Math.round(raw))
      setColumnWidth(previous => previous === measured ? previous : measured)
      const geometry: ChromeGeometry = {
        rtl,
        column: clampX(cellBounds.left + cellBounds.width / 2 - bounds.left - 14),
        row: Math.max(gutter, rowBounds.top + rowBounds.height / 2 - bounds.top - 14),
        bottom: tableBounds.bottom - bounds.top,
        middle: visibleLeft - bounds.left + Math.max(0, visibleRight - visibleLeft) / 2 - 14,
        end: rtl ? Math.max(0, visibleLeft - bounds.left - gutter) : Math.min(bounds.width - gutter, visibleRight - bounds.left),
        columnStart: Math.max(gutter, cellBounds.left - bounds.left),
        columnWidth: Math.max(0, Math.min(cellBounds.right, area.right) - Math.max(cellBounds.left, area.left)),
        rowStart: cellBounds.top - bounds.top,
        rowHeight: cellBounds.height,
      }
      setChrome(previous => previous?.mount === controls && equalGeometry(previous.geometry, geometry) ? previous : { mount: controls, geometry })
    }
    measure()
    // Measuring does not dispatch or write table widths. The equality guard also
    // keeps resize observations from becoming React/layout feedback loops.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(shell); observer?.observe(table)
    viewport.addEventListener('scroll', measure, { passive: true })
    const win = shell.ownerDocument.defaultView
    win?.addEventListener('resize', measure)
    return () => {
      observer?.disconnect(); viewport.removeEventListener('scroll', measure); win?.removeEventListener('resize', measure)
      delete shell.dataset.jotTableActive
    }
  }, [editor, target?.tablePos, target?.table, target?.top, target?.bottom, target?.left, target?.right, readOnly, locale])

  if (!target || readOnly || !chrome) return null
  const run = (action: TableAction) => {
    // Menus can outlive the render that opened them; recheck live permissions.
    if (readOnly || !editor.isEditable) return
    const transaction = tableActionTransaction(editor.state, target, action)
    if (!transaction) {
      if (action !== 'fit') setNotice(t('This change exceeds the note or table limit.'))
      editor.commands.focus()
      return
    }
    editor.view.dispatch(closeHistory(transaction))
    editor.view.dispatch(closeHistory(editor.state.tr))
    editor.commands.focus()
  }
  const item = (label: string, action: TableAction, danger = false): ActionMenuItem => ({
    label, onSelect: () => run(action), disabled: !tableActionAllowed(editor.state, target, action), danger,
    icon: danger ? 'trash' : action === 'fit' ? 'table' : 'plus',
  })
  const range = (start: number, end: number) => end === start + 1 ? `${start + 1}` : `${start + 1}–${end}`
  const columns = { range: range(target.left, target.right) }
  const rows = { range: range(target.top, target.bottom) }
  const columnLabel = target.right - target.left === 1 ? t('Column {range} actions', columns) : t('Columns {range} actions', columns)
  const rowLabel = target.bottom - target.top === 1 ? t('Row {range} actions', rows) : t('Rows {range} actions', rows)
  const canRow = tableActionAllowed(editor.state, target, 'append-row')
  const canColumn = tableActionAllowed(editor.state, target, 'append-column')
  const disabledTitle = t('Table or note capacity limit reached')
  const geometry = chrome.geometry
  const nudgeColumn = (delta: number) => {
    if (readOnly || !editor.isEditable) return
    const transaction = nudgeTableColumn(editor.state, target, target.right - 1, delta, columnWidth)
    if (!transaction) return
    editor.view.dispatch(closeHistory(transaction))
    editor.view.dispatch(closeHistory(editor.state.tr))
  }
  const shownWidth = Math.min(TABLE_CELL_MAX_WIDTH, Math.max(TABLE_CELL_MIN_WIDTH, columnWidth))
  // The stylesheet places the row controls at the physical left; in RTL the table starts at the right.
  const rowSide = geometry.rtl ? { left: 'auto', right: 0 } : {}
  return createPortal(<div className="jot-table-chrome" role="group" aria-label={t('Edit table')}>
    <span className="jot-table-column-indicator" aria-hidden="true" style={{ left: geometry.columnStart, width: geometry.columnWidth }} />
    {/* pointer-events:none：这条 8 像素分隔条盖在列边上，鼠标拖动要落到单元格边框上。 */}
    <div className="jot-table-column-resize" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t('Resize column {column}', { column: target.right })}
      aria-valuemin={TABLE_CELL_MIN_WIDTH} aria-valuemax={TABLE_CELL_MAX_WIDTH} aria-valuenow={shownWidth}
      style={{ left: geometry.columnStart + geometry.columnWidth }}
      onKeyDown={event => {
        const direction = columnDividerDelta(event)
        if (direction == null) return
        event.preventDefault()
        event.stopPropagation()
        nudgeColumn(direction * TABLE_COLUMN_NUDGE)
      }} />
    <span className="jot-table-row-indicator" aria-hidden="true" style={{ top: geometry.rowStart, height: geometry.rowHeight,
      ...geometry.rtl ? { left: 'auto', right: 'calc(var(--jot-table-gutter) - 2px)' } : {} }} />
    <span className="jot-table-column-menu" style={{ left: geometry.column }}>
      <ActionMenu key={`column:${menuKey}`} triggerLabel={columnLabel} items={[
        item(t('Insert column before'), 'column-before'),
        item(t('Insert column after'), 'column-after'),
        item(t('Delete {count} columns', { count: target.right - target.left }), 'column-delete', true),
      ]} />
    </span>
    <span className="jot-table-row-menu" style={{ top: geometry.row, ...rowSide }}>
      <ActionMenu key={`row:${menuKey}`} triggerLabel={rowLabel} items={[
        item(t('Insert row above'), 'row-before'),
        item(t('Insert row below'), 'row-after'),
        item(t('Delete {count} rows', { count: target.bottom - target.top }), 'row-delete', true),
      ]} />
    </span>
    <span className="jot-table-options" style={{ left: geometry.end, right: 'auto' }}>
      <ActionMenu key={`table:${menuKey}`} triggerLabel={t('Table options')} triggerIcon="table" items={[
        item(t('Auto fit to available width'), 'fit'),
        item(t('Delete table'), 'delete', true),
      ]} />
    </span>
    <button type="button" className="jot-icon-btn jot-table-append-column" disabled={!canColumn}
      aria-label={t('Append column at end of table')} title={canColumn ? t('Append column') : disabledTitle}
      style={{ top: geometry.row, left: geometry.end, right: 'auto' }} onMouseDown={event => event.preventDefault()} onClick={() => run('append-column')}>
      <JotActionIcon name="plus" />
    </button>
    <button type="button" className="jot-icon-btn jot-table-append-row" disabled={!canRow}
      aria-label={t('Append row at end of table')} title={canRow ? t('Append row') : disabledTitle}
      style={{ top: geometry.bottom, left: geometry.middle }} onMouseDown={event => event.preventDefault()} onClick={() => run('append-row')}>
      <JotActionIcon name="plus" />
    </button>
    {notice && <span className="jot-table-notice" role="status">{notice}</span>}
    <span className="jot-table-width-status" role="status" aria-live="polite">{widthMessage}</span>
  </div>, chrome.mount)
}
