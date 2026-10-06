import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from './layers.js'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { ActionMenu, type ActionMenuItem } from './ActionMenu.js'
import { JotActionIcon } from './icons.js'
import { selectedTable, tableActionAllowed, tableActionTransaction, type TableAction, type TableTarget } from './table-actions.js'

interface ChromeGeometry {
  column: number; row: number; bottom: number; middle: number
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
export function TableControls({ editor, readOnly, en }: { editor: Editor; readOnly: boolean; en: boolean }) {
  const target = selectedTable(editor.state)
  const current = useRef<TableTarget | null>(target)
  current.current = target
  const documentVersion = useRef({ doc: editor.state.doc, version: 0 })
  if (documentVersion.current.doc !== editor.state.doc) documentVersion.current = { doc: editor.state.doc, version: documentVersion.current.version + 1 }
  const menuKey = `${documentVersion.current.version}:${target?.tablePos}:${target?.top}:${target?.bottom}:${target?.left}:${target?.right}`
  const [chrome, setChrome] = useState<TableChrome | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => { setNotice('') }, [target?.tablePos, target?.table])
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
      const clampX = (x: number) => Math.max(gutter, Math.min(bounds.width - gutter - 28, x))
      const geometry: ChromeGeometry = {
        column: clampX(cellBounds.left + cellBounds.width / 2 - bounds.left - 14),
        row: Math.max(gutter, rowBounds.top + rowBounds.height / 2 - bounds.top - 14),
        bottom: tableBounds.bottom - bounds.top,
        middle: gutter + area.width / 2 - 14,
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
  }, [editor, target?.tablePos, target?.table, target?.top, target?.bottom, target?.left, target?.right, readOnly])

  if (!target || readOnly || !chrome) return null
  const run = (action: TableAction) => {
    // Menus can outlive the render that opened them; recheck live permissions.
    if (readOnly || !editor.isEditable) return
    const transaction = tableActionTransaction(editor.state, target, action)
    if (!transaction) {
      if (action !== 'fit') setNotice(en ? 'This change exceeds the note or table limit.' : '已达到表格或笔记容量上限，无法继续添加。')
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
  const columnLabel = en ? `Columns ${range(target.left, target.right)} actions` : `第 ${range(target.left, target.right)} 列操作`
  const rowLabel = en ? `Rows ${range(target.top, target.bottom)} actions` : `第 ${range(target.top, target.bottom)} 行操作`
  const canRow = tableActionAllowed(editor.state, target, 'append-row')
  const canColumn = tableActionAllowed(editor.state, target, 'append-column')
  const disabledTitle = en ? 'Table or note capacity limit reached' : '已达到表格或笔记容量上限'
  const geometry = chrome.geometry
  return createPortal(<div className="jot-table-chrome" role="group" aria-label={en ? 'Edit table' : '编辑表格'}>
    <span className="jot-table-column-indicator" aria-hidden="true" style={{ left: geometry.columnStart, width: geometry.columnWidth }} />
    <span className="jot-table-row-indicator" aria-hidden="true" style={{ top: geometry.rowStart, height: geometry.rowHeight }} />
    <span className="jot-table-column-menu" style={{ left: geometry.column }}>
      <ActionMenu key={`column:${menuKey}`} triggerLabel={columnLabel} items={[
        item(en ? 'Insert column before' : '在前面添加列', 'column-before'),
        item(en ? 'Insert column after' : '在后面添加列', 'column-after'),
        item(en ? `Delete ${target.right - target.left} column(s)` : `删除 ${target.right - target.left} 列`, 'column-delete', true),
      ]} />
    </span>
    <span className="jot-table-row-menu" style={{ top: geometry.row }}>
      <ActionMenu key={`row:${menuKey}`} triggerLabel={rowLabel} items={[
        item(en ? 'Insert row above' : '在上方添加行', 'row-before'),
        item(en ? 'Insert row below' : '在下方添加行', 'row-after'),
        item(en ? `Delete ${target.bottom - target.top} row(s)` : `删除 ${target.bottom - target.top} 行`, 'row-delete', true),
      ]} />
    </span>
    <span className="jot-table-options">
      <ActionMenu key={`table:${menuKey}`} triggerLabel={en ? 'Table options' : '表格选项'} triggerIcon="table" items={[
        item(en ? 'Auto fit to available width' : '自动适应宽度', 'fit'),
        item(en ? 'Delete table' : '删除表格', 'delete', true),
      ]} />
    </span>
    <button type="button" className="jot-icon-btn jot-table-append-column" disabled={!canColumn}
      aria-label={en ? 'Append column at end of table' : '在表格末尾添加列'} title={canColumn ? en ? 'Append column' : '在表格末尾添加列' : disabledTitle}
      style={{ top: geometry.row }} onMouseDown={event => event.preventDefault()} onClick={() => run('append-column')}>
      <JotActionIcon name="plus" />
    </button>
    <button type="button" className="jot-icon-btn jot-table-append-row" disabled={!canRow}
      aria-label={en ? 'Append row at end of table' : '在表格末尾添加行'} title={canRow ? en ? 'Append row' : '在表格末尾添加行' : disabledTitle}
      style={{ top: geometry.bottom, left: geometry.middle }} onMouseDown={event => event.preventDefault()} onClick={() => run('append-row')}>
      <JotActionIcon name="plus" />
    </button>
    {notice && <span className="jot-table-notice" role="status">{notice}</span>}
  </div>, chrome.mount)
}
