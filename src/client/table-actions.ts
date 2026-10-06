import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { addColumn, isInTable, removeColumn, removeRow, rowIsHeader, selectedRect, TableMap, tableNodeTypes, type TableRect } from '@tiptap/pm/tables'
import { MAX_DOC_BYTES, validateRichDoc } from '../model.js'

export const TABLE_CELL_MIN_WIDTH = 88
export const TABLE_CELL_MAX_WIDTH = 5_000
export const TABLE_MAX_ROWS = 200
export const TABLE_MAX_COLUMNS = 50

export type TableAction = 'row-before' | 'row-after' | 'row-delete' | 'column-before' | 'column-after' | 'column-delete'
  | 'append-row' | 'append-column' | 'fit' | 'delete'
export interface TableTarget extends TableRect { tablePos: number }

export function normalizeTableWidths(tr: Transaction): Transaction {
  tr.doc.descendants((node, position) => {
    if (!['cell', 'header_cell'].includes(node.type.spec.tableRole) || !Array.isArray(node.attrs.colwidth)) return
    const widths = node.attrs.colwidth.map((width: number) => Math.min(TABLE_CELL_MAX_WIDTH,
      Math.max(TABLE_CELL_MIN_WIDTH, Math.round(Number.isFinite(width) ? width : TABLE_CELL_MIN_WIDTH))))
    if (widths.some((width: number, index: number) => width !== node.attrs.colwidth[index])) {
      tr.setNodeMarkup(position, null, { ...node.attrs, colwidth: widths })
    }
  })
  return tr
}

export function selectedTable(state: EditorState): TableTarget | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  return { ...rect, tablePos: rect.tableStart - 1 }
}

const documentCapacity = new WeakMap<ProseMirrorNode, { nodes: number; bytes: number }>()
function capacity(doc: ProseMirrorNode) {
  let result = documentCapacity.get(doc)
  if (!result) {
    let nodes = 0
    doc.descendants(() => { nodes++ })
    result = { nodes, bytes: new TextEncoder().encode(JSON.stringify(doc.toJSON())).byteLength }
    documentCapacity.set(doc, result)
  }
  return result
}

/** Cheap UI guards; the final transaction is also checked by the real persistence validator. */
export function tableActionAllowed(state: EditorState, target: TableTarget, action: TableAction): boolean {
  const current = state.doc.nodeAt(target.tablePos)
  if (!current || current.type.spec.tableRole !== 'table' || !current.eq(target.table)) return false
  if (action === 'row-delete') return target.bottom - target.top < target.map.height
  if (action === 'column-delete') return target.right - target.left < target.map.width
  const row = action === 'row-before' || action === 'row-after' || action === 'append-row'
  const column = action === 'column-before' || action === 'column-after' || action === 'append-column'
  if (!row && !column) return true
  if (row && target.map.height >= TABLE_MAX_ROWS || column && target.map.width >= TABLE_MAX_COLUMNS) return false
  // Blank row/column cells contain one paragraph. This conservative bound also covers spanning cells.
  const addedNodes = row ? 1 + 2 * target.map.width : 2 * target.map.height
  const currentCapacity = capacity(state.doc)
  return currentCapacity.nodes + addedNodes <= 10_000 && currentCapacity.bytes + addedNodes * 160 <= MAX_DOC_BYTES
}

function insertRow(tr: Transaction, { map, tableStart, table }: TableRect, row: number) {
  let position = tableStart
  for (let index = 0; index < row; index++) position += table.child(index).nodeSize
  const types = tableNodeTypes(table.type.schema)
  let reference: number | null = row > 0 ? -1 : 0
  if (rowIsHeader(map, table, row + reference)) reference = row === 0 || row === map.height ? null : 0
  const cells: ProseMirrorNode[] = []
  for (let column = 0; column < map.width;) {
    // Index by the logical column: advancing across a colspan must also advance
    // the map index. The upstream addRow loop currently misses that combination.
    const index = row * map.width + column
    if (row > 0 && row < map.height && map.map[index] === map.map[index - map.width]) {
      const cellPosition = map.map[index]!
      const cell = table.nodeAt(cellPosition)!
      tr.setNodeMarkup(tableStart + cellPosition, null, { ...cell.attrs, rowspan: cell.attrs.rowspan + 1 })
      column += cell.attrs.colspan
    } else {
      const type = reference === null ? types.cell : table.nodeAt(map.map[index + reference * map.width]!)!.type
      cells.push(type.createAndFill()!)
      column++
    }
  }
  return tr.insert(position, types.row.create(null, cells))
}

/** Target the captured table/range, never a later toolbar cursor or a different table. */
export function tableActionTransaction(state: EditorState, target: TableTarget, action: TableAction): Transaction | null {
  if (!tableActionAllowed(state, target, action)) return null
  const tr = state.tr
  let rect: TableRect = { ...target }
  switch (action) {
    case 'row-before': insertRow(tr, rect, rect.top); break
    case 'row-after': insertRow(tr, rect, rect.bottom); break
    case 'append-row': insertRow(tr, rect, rect.map.height); break
    case 'column-before': addColumn(tr, rect, rect.left); break
    case 'column-after': addColumn(tr, rect, rect.right); break
    case 'append-column': addColumn(tr, rect, rect.map.width); break
    case 'row-delete':
      for (let row = rect.bottom - 1; row >= rect.top; row--) {
        removeRow(tr, rect, row)
        const table = tr.doc.nodeAt(target.tablePos)!
        rect = { ...rect, table, map: TableMap.get(table) }
      }
      break
    case 'column-delete':
      for (let column = rect.right - 1; column >= rect.left; column--) {
        removeColumn(tr, rect, column)
        const table = tr.doc.nodeAt(target.tablePos)!
        rect = { ...rect, table, map: TableMap.get(table) }
      }
      break
    case 'fit':
      target.table.descendants((node, position) => {
        if ((node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') && node.attrs.colwidth !== null) {
          tr.setNodeMarkup(target.tableStart + position, null, { ...node.attrs, colwidth: null })
        }
      })
      break
    case 'delete': tr.delete(target.tablePos, target.tablePos + target.table.nodeSize); break
  }
  if (!tr.docChanged) return null
  normalizeTableWidths(tr)
  // Spanning-cell edits preserve content. Reject any
  // byte/node/grid overflow before it can enter the human draft or autosave queue.
  try { validateRichDoc(tr.doc.toJSON()) } catch { return null }
  return tr.scrollIntoView()
}
