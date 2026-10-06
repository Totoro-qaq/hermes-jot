import { Extension } from '@tiptap/core'
import { Table, TableView, updateColumns } from '@tiptap/extension-table'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { columnResizing, columnResizingPluginKey } from '@tiptap/pm/tables'
import type { EditorView } from '@tiptap/pm/view'
import { normalizeTableWidths, TABLE_CELL_MIN_WIDTH } from './table-actions.js'
import { StoreError, validateRichDoc } from '../model.js'

function syncTableColumns(node: ProseMirrorNode, colgroup: HTMLTableColElement, table: HTMLTableElement, minimum: number) {
  updateColumns(node, colgroup, table, minimum)
  // Auto fit and rejected live drags must remove stale width properties as well.
  let column = 0
  node.firstChild?.forEach(cell => {
    for (let span = 0; span < cell.attrs.colspan; span++, column++) {
      const col = colgroup.children[column] as HTMLTableColElement | undefined
      if (!col) continue
      const width = cell.attrs.colwidth?.[span]
      col.style.width = width ? `${Math.max(minimum, width)}px` : ''
      col.style.minWidth = width ? '' : `${minimum}px`
    }
  })
}

function restoreTableAfterResize(view: EditorView, handle: number) {
  if (handle < 0 || handle > view.state.doc.content.size) return
  const resolved = view.state.doc.resolve(handle)
  for (let depth = resolved.depth; depth > 0; depth--) {
    const node = resolved.node(depth)
    if (node.type.spec.tableRole !== 'table') continue
    const shell = view.nodeDOM(resolved.before(depth))
    if (!(shell instanceof HTMLElement)) return
    const table = shell.querySelector<HTMLTableElement>('table')
    const colgroup = table?.querySelector<HTMLTableColElement>('colgroup')
    if (table && colgroup) syncTableColumns(node, colgroup, table, TABLE_CELL_MIN_WIDTH)
    return
  }
}

/** Controls stay outside contentDOM, so neither clipboard nor serialization includes them. */
export class JotTableView extends TableView {
  constructor(node: ProseMirrorNode, cellMinWidth: number, view?: EditorView, attributes: Record<string, unknown> = {}) {
    super(node, cellMinWidth, view, attributes)
    this.dom.classList.add('jot-table-shell')
    const viewport = document.createElement('div')
    viewport.className = 'jot-table-viewport'
    this.dom.appendChild(viewport)
    viewport.appendChild(this.table)
    const chrome = document.createElement('div')
    chrome.className = 'jot-table-chrome-mount'
    chrome.contentEditable = 'false'
    chrome.dataset.jotTableChrome = ''
    this.dom.appendChild(chrome)
    this.syncColumns()
  }

  private syncColumns() {
    // Upstream updateColumns sets min-width on auto columns but can leave a previous
    // width property behind. Clearing it makes Auto fit truly reset a dragged table.
    syncTableColumns(this.node, this.colgroup, this.table, this.cellMinWidth)
  }

  update(node: ProseMirrorNode) {
    if (!super.update(node)) return false
    this.syncColumns()
    return true
  }

  stopEvent(event: Event) {
    return event.target instanceof Element && Boolean(event.target.closest('[data-jot-table-chrome]'))
  }
}

/** Keep resize available after switching a read-only note back to editing. */
export const JotTable = Table.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? []
    if (this.options.resizable && !this.editor.isEditable) plugins.unshift(columnResizing({
      handleWidth: this.options.handleWidth, cellMinWidth: this.options.cellMinWidth,
      defaultCellMinWidth: this.options.cellMinWidth, View: this.options.View,
      lastColumnResizable: this.options.lastColumnResizable,
    }))
    return plugins.map(plugin => {
      if (plugin.spec.key !== columnResizingPluginKey) return plugin
      // Upstream mousemove checks editable, but mousedown also needs a guard if
      // permissions changed while an old resize handle was still active.
      const handlers = plugin.props.handleDOMEvents ?? {}
      return new Plugin({ ...plugin.spec, view: view => {
        const original = plugin.spec.view?.(view)
        return {
          update(current, previous) {
            original?.update?.(current, previous)
            const before = columnResizingPluginKey.getState(previous)
            const after = columnResizingPluginKey.getState(current.state)
            // Cancelling a drag only changes plugin metadata. NodeView.update
            // need not run, so discard the upstream live DOM width explicitly.
            if (before?.dragging && !after?.dragging) restoreTableAfterResize(current, before.activeHandle)
          },
          destroy() { original?.destroy?.() },
        }
      }, props: { ...plugin.props, handleKeyDown(view, event) {
        if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229
          && columnResizingPluginKey.getState(view.state)?.dragging) {
          view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }))
          event.preventDefault()
          return true
        }
        return plugin.props.handleKeyDown?.call(plugin, view, event) ?? false
      }, handleDOMEvents: {
        ...handlers,
        mousedown: (view, event) => view.editable ? handlers.mousedown?.call(plugin, view, event) : false,
      } } })
    })
  },
  addNodeView() { return this.options.resizable ? null : this.parent?.() ?? null },
})

/** Mouse coordinates can be fractional, and merged-cell resize uses zero sentinels. */
export const PersistableTableWidths = Extension.create({
  name: 'jotPersistableTableWidths',
  addProseMirrorPlugins() { return [persistableTableWidthPlugin()] },
})

interface WidthRestore { version: number; tables: number[] }
const widthRestoreKey = new PluginKey<WidthRestore>('jot-table-width-capacity')

export function persistableTableWidthPlugin() {
  return new Plugin<WidthRestore>({
    key: widthRestoreKey,
    state: {
      init: () => ({ version: 0, tables: [] }),
      apply: (transaction, previous) => {
        const tables = transaction.getMeta(widthRestoreKey) as number[] | undefined
        return tables ? { version: previous.version + 1, tables } : previous
      },
    },
    view: () => ({ update(view, previous) {
      const restored = widthRestoreKey.getState(view.state)
      if (!restored || restored.version === widthRestoreKey.getState(previous)?.version) return
      // A rejected width-only drag can leave a document equal to the old one,
      // allowing ProseMirror to reuse its NodeView without calling update().
      // Refresh its DOM explicitly so the transient live-drag width disappears.
      for (const position of restored.tables) {
        const node = view.state.doc.nodeAt(position)
        const shell = view.nodeDOM(position)
        if (!node || !(shell instanceof HTMLElement)) continue
        const table = shell.querySelector<HTMLTableElement>('table')
        const colgroup = table?.querySelector<HTMLTableColElement>('colgroup')
        if (table && colgroup) syncTableColumns(node, colgroup, table, TABLE_CELL_MIN_WIDTH)
      }
    } }),
    appendTransaction(transactions, previous, state) {
    if (!transactions.some(transaction => transaction.docChanged)) return null
    if (transactions.every(transaction => transaction.getMeta(widthRestoreKey))) return null
    const tr = normalizeTableWidths(state.tr)
    const mapping = new Mapping()
    for (const transaction of transactions) mapping.appendMapping(transaction.mapping)
    const inverse = mapping.invert()
    const growing: Array<{ position: number; before: number[] | null }> = []
    tr.doc.descendants((node, position) => {
      if (!['cell', 'header_cell'].includes(node.type.spec.tableRole) || !Array.isArray(node.attrs.colwidth)) return
      const old = previous.doc.nodeAt(inverse.map(position))
      const before = old && old.type.spec.tableRole === node.type.spec.tableRole && old.attrs.colspan === node.attrs.colspan
        ? old.attrs.colwidth as number[] | null : null
      if (JSON.stringify(node.attrs.colwidth).length > JSON.stringify(before).length) growing.push({ position, before })
    })
    if (growing.length) {
      try { validateRichDoc(tr.doc.toJSON()) } catch (error) {
        if (error instanceof StoreError && error.message === 'Document exceeds the byte limit') {
          const tables = new Set<number>()
          for (const { position, before } of growing) {
            const node = tr.doc.nodeAt(position)!
            tr.setNodeMarkup(position, null, { ...node.attrs, colwidth: before })
            const resolved = tr.doc.resolve(position)
            for (let depth = resolved.depth; depth > 0; depth--) if (resolved.node(depth).type.spec.tableRole === 'table') {
              tables.add(resolved.before(depth)); break
            }
          }
          // Only column widths are restored. Text and other simultaneous edits,
          // including an already oversized human draft, remain untouched.
          tr.setMeta(widthRestoreKey, [...tables])
        }
      }
    }
    return tr.docChanged ? tr : null
  } })
}
