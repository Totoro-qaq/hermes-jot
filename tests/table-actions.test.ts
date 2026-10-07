import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor, type JSONContent } from '@tiptap/core'
import { closeHistory, history, redoDepth, undoDepth } from '@tiptap/pm/history'
import { CellSelection, columnResizingPluginKey, TableMap } from '@tiptap/pm/tables'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { syncEditorContent } from '../src/client/editor-content.js'
import { persistableTableWidthPlugin } from '../src/client/table-view.js'
import { selectedTable, tableActionAllowed, tableActionTransaction, type TableAction } from '../src/client/table-actions.js'
import { docToText, MAX_DOC_BYTES, validateRichDoc } from '../src/model.js'

const paragraph = (text?: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })
const cell = (text?: string, attrs: Record<string, unknown> = {}) => ({ type: 'tableCell', attrs, content: [paragraph(text)] })
const table = (rows: number, columns: number) => ({ type: 'table', content: Array.from({ length: rows }, (_, row) => ({
  type: 'tableRow', content: Array.from({ length: columns }, (_, column) => cell(`${row}:${column}`)),
})) })
function create(content: JSONContent[]) {
  return new Editor({ element: null, extensions: createJotExtensions(), content: { type: 'doc', content } })
}
function select(editor: Editor, tablePos: number, row: number, column: number) {
  const map = TableMap.get(editor.state.doc.nodeAt(tablePos)!)
  const position = tablePos + 1 + map.map[row * map.width + column]!
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, position)))
  return selectedTable(editor.state)!
}
function apply(editor: Editor, action: TableAction) {
  const target = selectedTable(editor.state)!
  const tr = tableActionTransaction(editor.state, target, action)
  assert.ok(tr, `${action} must create a valid transaction`)
  editor.view.dispatch(closeHistory(tr))
  editor.view.dispatch(closeHistory(editor.state.tr))
  return validateRichDoc(editor.getJSON())
}

test('end plus appends to the captured table, even when the caret later enters a different table', t => {
  const editor = create([table(2, 2), paragraph('between'), table(2, 2)])
  t.after(() => editor.destroy())
  const originalText = editor.state.doc.textContent
  const target = select(editor, 0, 0, 0)
  const secondPos = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize
  select(editor, secondPos, 0, 0)
  const appendedRow = tableActionTransaction(editor.state, target, 'append-row')!
  editor.view.dispatch(appendedRow)
  const first = editor.state.doc.child(0)
  assert.equal(first.childCount, 3)
  assert.equal(first.child(0).textContent, '0:00:1')
  assert.equal(first.child(1).textContent, '1:01:1')
  assert.equal(first.lastChild!.textContent, '')
  assert.equal(editor.state.doc.child(2).childCount, 2)
  const newTarget = select(editor, 0, 0, 0)
  editor.view.dispatch(tableActionTransaction(editor.state, newTarget, 'append-column')!)
  assert.equal(TableMap.get(editor.state.doc.child(0)).width, 3)
  assert.equal(editor.state.doc.child(0).child(0).child(0).textContent, '0:0')
  assert.equal(editor.state.doc.child(0).child(0).lastChild!.textContent, '')
  assert.equal(editor.state.doc.child(2).child(0).childCount, 2)
  validateRichDoc(editor.getJSON())
  assert.equal(editor.state.doc.textContent, originalText)
})

test('row/column menus insert relative to the selected range and preserve a merged cell', t => {
  const editor = create([{ type: 'table', content: [
    { type: 'tableRow', content: [cell('merged', { colspan: 2, rowspan: 2, colwidth: [120, 140] }), cell('right top')] },
    { type: 'tableRow', content: [cell('right bottom')] },
    { type: 'tableRow', content: [cell('bottom left'), cell('bottom middle'), cell('bottom right')] },
  ] }])
  t.after(() => editor.destroy())
  select(editor, 0, 1, 2)
  apply(editor, 'row-before')
  assert.equal(editor.state.doc.child(0).child(0).child(0).attrs.rowspan, 3)
  assert.equal(editor.state.doc.child(0).child(2).textContent, 'right bottom')
  select(editor, 0, 3, 1)
  apply(editor, 'column-before')
  const merged = editor.state.doc.child(0).child(0).child(0)
  assert.equal(merged.attrs.colspan, 3)
  assert.deepEqual(merged.attrs.colwidth, [120, 88, 140])
  assert.equal(merged.textContent, 'merged')
  assert.equal(TableMap.get(editor.state.doc.child(0)).width, 4)
  assert.ok(docToText(validateRichDoc(editor.getJSON())).includes('bottom middle'))
})

test('removing a row or column crossed by a merged cell keeps its surviving content and valid spans', t => {
  const editor = create([{ type: 'table', content: [
    { type: 'tableRow', content: [cell('keep merged', { colspan: 2, rowspan: 2 }), cell('keep top')] },
    { type: 'tableRow', content: [cell('remove this row')] },
    { type: 'tableRow', content: [cell('remove this column'), cell('keep middle'), cell('keep right')] },
  ] }])
  t.after(() => editor.destroy())
  select(editor, 0, 1, 2)
  apply(editor, 'row-delete')
  assert.equal(editor.state.doc.child(0).child(0).child(0).attrs.rowspan, 1)
  select(editor, 0, 1, 0)
  const saved = apply(editor, 'column-delete')
  assert.equal(editor.state.doc.child(0).child(0).child(0).attrs.colspan, 1)
  assert.equal(editor.state.doc.child(0).child(0).child(0).textContent, 'keep merged')
  assert.ok(docToText(saved).includes('keep middle'))
  assert.ok(!docToText(saved).includes('remove this'))
})

test('auto fit clears every stored width while preserving marks/spans and supports real undo/redo', t => {
  const editor = create([{ type: 'table', content: [{ type: 'tableRow', content: [
    { ...cell('Formatted', { colspan: 2, colwidth: [220, 310] }), content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Formatted', marks: [{ type: 'bold' }, { type: 'highlight', attrs: { color: '#fef08a' } }] },
    ] }] }, cell('Other', { colwidth: [150] }),
  ] }] }])
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  const before = validateRichDoc(editor.getJSON())
  select(editor, 0, 0, 0)
  const fitted = apply(editor, 'fit')
  for (const node of fitted.content[0]!.content![0]!.content!) assert.equal(node.attrs!.colwidth, null)
  assert.equal(fitted.content[0]!.content![0]!.content![0]!.attrs!.colspan, 2)
  assert.deepEqual(fitted.content[0]!.content![0]!.content![0]!.content, before.content[0]!.content![0]!.content![0]!.content)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(validateRichDoc(editor.getJSON()), before)
  assert.equal(editor.commands.redo(), true)
  assert.deepEqual(validateRichDoc(editor.getJSON()), fitted)
})

test('canonical save responses preserve consecutive table undo/redo instead of adding empty history events', t => {
  const editor = create([table(4, 3), { type: 'paragraph', content: [
    { type: 'text', text: 'Marked note', marks: [{ type: 'bold' }] },
  ] }])
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  select(editor, 0, 0, 0)
  apply(editor, 'append-column')
  apply(editor, 'append-row')
  const dimensions = () => {
    const map = TableMap.get(editor.state.doc.child(0))
    return [map.height, map.width]
  }
  const saveResponse = () => {
    const canonical = validateRichDoc(editor.getJSON())
    assert.notEqual(JSON.stringify(canonical), JSON.stringify(editor.getJSON()), 'marked text has different canonical JSON key order')
    assert.equal(syncEditorContent(editor, canonical), false)
  }
  assert.deepEqual(dimensions(), [5, 4])
  assert.equal(undoDepth(editor.state), 2)
  saveResponse()
  assert.equal(undoDepth(editor.state), 2)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(dimensions(), [4, 4])
  saveResponse()
  assert.equal(undoDepth(editor.state), 1)
  assert.equal(redoDepth(editor.state), 1)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(dimensions(), [4, 3])
  saveResponse()
  assert.equal(undoDepth(editor.state), 0)
  assert.equal(redoDepth(editor.state), 2)
  assert.equal(editor.commands.redo(), true)
  assert.deepEqual(dimensions(), [4, 4])
  saveResponse()
  assert.equal(redoDepth(editor.state), 1)
  assert.equal(editor.commands.redo(), true)
  assert.deepEqual(dimensions(), [5, 4])
  saveResponse()
  assert.equal(redoDepth(editor.state), 0)
})

test('genuine external document changes still synchronize without re-emitting a controlled edit', t => {
  const editor = create([table(2, 2), paragraph('Before')])
  t.after(() => editor.destroy())
  let updates = 0
  editor.on('update', () => { updates++ })
  const external = validateRichDoc({ type: 'doc', content: [table(2, 3), paragraph('From another panel')] })
  assert.equal(syncEditorContent(editor, external), true)
  assert.deepEqual(validateRichDoc(editor.getJSON()), external)
  assert.equal(updates, 0)
  assert.equal(syncEditorContent(editor, external), false)
})

test('actual width normalization handles fractional drag coordinates and merged zero sentinels without transaction loops', t => {
  const editor = create([{ type: 'table', content: [{ type: 'tableRow', content: [cell('merged', { colspan: 3 })] }] }])
  editor.registerPlugin(persistableTableWidthPlugin())
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  const cellPosition = 2
  const original = editor.state.doc.nodeAt(cellPosition)!
  editor.view.dispatch(editor.state.tr.setNodeMarkup(cellPosition, null, { ...original.attrs, colwidth: [0, 123.75, 50_000] }))
  assert.deepEqual(editor.state.doc.nodeAt(cellPosition)!.attrs.colwidth, [88, 124, 5_000])
  validateRichDoc(editor.getJSON())
  const stable = editor.state.doc
  const result = editor.state.applyTransaction(editor.state.tr)
  assert.equal(result.transactions.length, 1)
  assert.strictEqual(result.state.doc, stable)
  assert.equal(editor.commands.undo(), true)
  assert.equal(editor.state.doc.nodeAt(cellPosition)!.attrs.colwidth, null)
})

test('row, column, document node limits and stale targets reject growth before changing the draft', t => {
  for (const [rows, columns, action] of [[200, 2, 'append-row'], [2, 50, 'append-column']] as const) {
    const editor = create([table(rows, columns)])
    t.after(() => editor.destroy())
    const target = select(editor, 0, 0, 0)
    assert.equal(tableActionAllowed(editor.state, target, action), false)
    assert.equal(tableActionTransaction(editor.state, target, action), null)
    validateRichDoc(editor.getJSON())
  }
  const full = create([table(2, 2), ...Array.from({ length: 9_983 }, () => paragraph())])
  t.after(() => full.destroy())
  const target = select(full, 0, 0, 0)
  validateRichDoc(full.getJSON())
  assert.equal(tableActionAllowed(full.state, target, 'append-row'), false)
  assert.equal(tableActionTransaction(full.state, target, 'append-column'), null)
  const editor = create([table(2, 2)])
  t.after(() => editor.destroy())
  const oldTarget = select(editor, 0, 0, 0)
  apply(editor, 'append-row')
  assert.equal(tableActionTransaction(editor.state, oldTarget, 'append-column'), null)
})

test('initially read-only editors still install resize with editable guards, so permissions can change without remount', t => {
  const editor = new Editor({ element: null, extensions: createJotExtensions(), editable: false,
    content: { type: 'doc', content: [table(2, 2)] } })
  t.after(() => editor.destroy())
  const resize = editor.extensionManager.plugins.find(plugin => plugin.spec.key === columnResizingPluginKey)
  assert.ok(resize)
  assert.ok(resize.props.handleDOMEvents?.mousemove)
  // A previous editable handle must not let the upstream mousedown path dispatch
  // a resize after permission was revoked. The guard runs before it reads state.
  const blocked = resize.props.handleDOMEvents!.mousedown!.call(resize, { editable: false } as never, {} as MouseEvent)
  assert.equal(blocked, false)
})

test('Escape cancels a live resize without changing the document or undo history, and restores transient DOM widths', t => {
  const editor = create([table(2, 2)])
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  const resize = editor.extensionManager.plugins.find(plugin => plugin.spec.key === columnResizingPluginKey)!
  editor.registerPlugin(resize)
  const saved = validateRichDoc(editor.getJSON())
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: 2 }))
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: 100, startWidth: 88 } }))
  const previous = editor.state
  assert.equal(resize.props.handleKeyDown!.call(resize, editor.view, { key: 'Escape', isComposing: true } as KeyboardEvent), false)
  assert.ok(columnResizingPluginKey.getState(editor.state)!.dragging, 'IME cancellation belongs to the input method')
  let prevented = false
  const handled = resize.props.handleKeyDown!.call(resize, editor.view, {
    key: 'Escape', preventDefault() { prevented = true },
  } as KeyboardEvent)
  assert.equal(handled, true)
  assert.equal(prevented, true)
  assert.equal(columnResizingPluginKey.getState(editor.state)!.dragging, null)
  assert.deepEqual(validateRichDoc(editor.getJSON()), saved)
  assert.equal(editor.commands.undo(), false)
  assertCancelledResizeDom(resize, editor, previous)
  assert.equal(resize.props.handleKeyDown!.call(resize, editor.view, { key: 'Escape' } as KeyboardEvent), false)
})

test('revoking edit permission mid-drag restores DOM to persisted widths without making an edit', t => {
  const editor = create([table(2, 2)])
  t.after(() => editor.destroy())
  const resize = editor.extensionManager.plugins.find(plugin => plugin.spec.key === columnResizingPluginKey)!
  editor.registerPlugin(resize)
  const saved = validateRichDoc(editor.getJSON())
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: 2 }))
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: 100, startWidth: 88 } }))
  const previous = editor.state
  editor.setEditable(false, false)
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1, setDragging: null }))
  assert.deepEqual(validateRichDoc(editor.getJSON()), saved)
  assertCancelledResizeDom(resize, editor, previous)
})

function assertCancelledResizeDom(resize: import('@tiptap/pm/state').Plugin, editor: Editor, previous: typeof editor.state) {
  // Model the colgroup after upstream displayColumnWidth writes a live drag.
  const columns = [0, 1].map(() => ({ style: { width: '320px', minWidth: '', setProperty(property: string, value: string) {
    if (property === 'width') this.width = value
    if (property === 'min-width') this.minWidth = value
  } }, nextSibling: null as unknown }))
  columns[0]!.nextSibling = columns[1]
  const colgroup = { children: columns, firstChild: columns[0] }
  const tableDOM = { style: { width: '640px', minWidth: '' }, querySelector: () => colgroup }
  class Shell { querySelector() { return tableDOM } }
  const oldElement = globalThis.HTMLElement
  try {
    globalThis.HTMLElement = Shell as unknown as typeof HTMLElement
    const view = { state: editor.state, nodeDOM: () => new Shell() }
    resize.spec.view!(view as never).update!(view as never, previous)
    assert.deepEqual(columns.map(column => column.style.width), ['', ''])
    assert.deepEqual(columns.map(column => column.style.minWidth), ['88px', '88px'])
    assert.equal(tableDOM.style.width, '')
    assert.equal(tableDOM.style.minWidth, '176px')
  } finally { globalThis.HTMLElement = oldElement }
}

function nearByteLimitEditor() {
  const rows = Array.from({ length: 200 }, () => ({ type: 'tableRow', content: [cell()] }))
  const references = Array.from({ length: 800 }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: 'x',
    marks: [{ type: 'link', attrs: { href: 'https://example.org', title: `${String(index).padStart(4, '0')}${'a'.repeat(996)}` } }],
  }] }))
  const editor = create([{ type: 'table', content: rows }, ...references, paragraph('p')])
  const bytes = new TextEncoder().encode(JSON.stringify(validateRichDoc(editor.getJSON()))).byteLength
  const filler = 'p'.repeat(MAX_DOC_BYTES - 100 - bytes + 1)
  editor.view.dispatch(editor.state.tr.insertText(filler, editor.state.doc.content.size - 2, editor.state.doc.content.size - 1))
  assert.equal(new TextEncoder().encode(JSON.stringify(validateRichDoc(editor.getJSON()))).byteLength, MAX_DOC_BYTES - 100)
  return editor
}

test('whole-column width metadata cannot turn a near-limit valid note into an unsavable draft, and its live DOM is restored', t => {
  const editor = nearByteLimitEditor()
  const widths = persistableTableWidthPlugin()
  editor.registerPlugin(widths)
  t.after(() => editor.destroy())
  const previous = editor.state
  const before = validateRichDoc(editor.getJSON())
  const resize = editor.state.tr
  editor.state.doc.descendants((node, position) => {
    if (node.type.spec.tableRole === 'cell') resize.setNodeMarkup(position, null, { ...node.attrs, colwidth: [5_000] })
  })
  assert.throws(() => validateRichDoc(resize.doc.toJSON()), /byte limit/u)
  const repaired = editor.state.applyTransaction(resize)
  assert.equal(repaired.transactions.length, 2, 'one width repair, with no appendTransaction loop')
  editor.view.dispatch(resize)
  assert.deepEqual(validateRichDoc(editor.getJSON()), before)

  // Model the live DOM left by upstream displayColumnWidth. A final document
  // equal to its old value need not re-run TableView.update, so plugin.view must
  // actively clear this transient width using the production DOM sync path.
  const column = { style: { width: '5000px', minWidth: '', setProperty(property: string, value: string) {
    if (property === 'width') this.width = value
    if (property === 'min-width') this.minWidth = value
  } }, nextSibling: null }
  const colgroup = { children: [column], firstChild: column }
  const tableDOM = { style: { width: '5000px', minWidth: '' }, querySelector: () => colgroup }
  class Shell { querySelector() { return tableDOM } }
  const oldElement = globalThis.HTMLElement
  try {
    globalThis.HTMLElement = Shell as unknown as typeof HTMLElement
    const view = { state: editor.state, nodeDOM: () => new Shell() }
    widths.spec.view!(view as never).update!(view as never, previous)
    assert.equal(column.style.width, '')
    assert.equal(column.style.minWidth, '88px')
    assert.equal(tableDOM.style.width, '')
    assert.equal(tableDOM.style.minWidth, '88px')
  } finally { globalThis.HTMLElement = oldElement }
})

test('width capacity recovery preserves simultaneous text and continues to allow an already oversized human draft', t => {
  const editor = nearByteLimitEditor()
  editor.registerPlugin(persistableTableWidthPlugin())
  t.after(() => editor.destroy())
  const oldText = editor.state.doc.textContent
  const transaction = editor.state.tr.insertText('t'.repeat(101), editor.state.doc.content.size - 1)
  transaction.doc.descendants((node, position) => {
    if (node.type.spec.tableRole === 'cell') transaction.setNodeMarkup(position, null, { ...node.attrs, colwidth: [5_000] })
  })
  editor.view.dispatch(transaction)
  assert.equal(editor.state.doc.textContent, `${oldText}${'t'.repeat(101)}`)
  editor.state.doc.descendants(node => {
    if (node.type.spec.tableRole === 'cell') assert.equal(node.attrs.colwidth, null)
  })
  assert.throws(() => validateRichDoc(editor.getJSON()), /byte limit/u)
  editor.view.dispatch(editor.state.tr.insertText('still typing', editor.state.doc.content.size - 1))
  assert.equal(editor.state.doc.textContent, `${oldText}${'t'.repeat(101)}still typing`)
})

test('a synchronized external change keeps the caret where the user left it', t => {
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'milk' }] }] }] },
  ] } })
  t.after(() => editor.destroy())
  let updates = 0
  editor.on('update', () => { updates++ })
  // The caret sits after "First" while an agent's checklist item arrives at the end.
  editor.commands.setTextSelection(6)
  const appended = validateRichDoc({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'milk' }] }] },
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bread' }] }] },
    ] },
  ] })
  assert.equal(syncEditorContent(editor, appended), true)
  assert.deepEqual(validateRichDoc(editor.getJSON()), appended)
  assert.equal(editor.state.selection.from, 6)
  // A change before the caret maps it along with the text.
  const prefixed = validateRichDoc({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Very first paragraph' }] }, appended.content[1]!,
  ] })
  assert.equal(syncEditorContent(editor, prefixed), true)
  assert.deepEqual(validateRichDoc(editor.getJSON()), prefixed)
  assert.equal(editor.state.selection.from, 11)
  assert.equal(updates, 0)
})
