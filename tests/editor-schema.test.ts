import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Editor, getSchema } from '@tiptap/core'
import { history, closeHistory } from '@tiptap/pm/history'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { createJotExtensions, managedAttachmentUrl } from '../src/client/editor-extensions.js'
import { docToText, HIGHLIGHT_COLORS, TEXT_COLORS, StoreError, validateRichDoc } from '../src/model.js'
import { JotStore } from '../src/store.js'
import { appendExcerpt } from '../src/client/note-actions.js'

const content = { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Human notes' }] }] }
const headless = () => new Editor({ element: null, extensions: createJotExtensions(), content })
const rejected = (error: unknown) => error instanceof StoreError && error.code === 'INVALID_INPUT'

test('actual Tiptap table insert/add/delete commands always produce persistable table JSON', t => {
  const editor = headless()
  t.after(() => editor.destroy())
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  assert.equal(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true }), true)
  let table = validateRichDoc(editor.getJSON()).content.find(node => node.type === 'table')!
  assert.equal(table.content!.length, 2)
  assert.equal(table.content![0]!.content![0]!.type, 'tableHeader')
  assert.equal(editor.commands.addRowAfter(), true)
  assert.equal(editor.commands.addColumnAfter(), true)
  table = validateRichDoc(editor.getJSON()).content.find(node => node.type === 'table')!
  assert.equal(table.content!.length, 3)
  assert.equal(table.content![0]!.content!.length, 3)
  assert.equal(editor.commands.deleteRow(), true)
  assert.equal(editor.commands.deleteColumn(), true)
  table = validateRichDoc(editor.getJSON()).content.find(node => node.type === 'table')!
  assert.equal(table.content!.length, 2)
  assert.equal(table.content![0]!.content!.length, 2)
  assert.equal(editor.commands.deleteTable(), true)
  assert.ok(validateRichDoc(editor.getJSON()).content.every(node => node.type !== 'table'))
})

test('underline, finite text color, and highlight are editable, clearable, and undoable with real commands', t => {
  const editor = headless()
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  editor.commands.setTextSelection({ from: 1, to: 12 })
  assert.equal(editor.commands.toggleUnderline(), true)
  assert.equal(editor.commands.setColor(TEXT_COLORS[1]), true)
  assert.equal(editor.commands.setHighlight({ color: HIGHLIGHT_COLORS[0] }), true)
  const styled = validateRichDoc(editor.getJSON())
  const marks = styled.content[0]!.content![0]!.marks!
  assert.ok(marks.some(mark => mark.type === 'underline'))
  assert.ok(marks.some(mark => mark.type === 'textStyle' && mark.attrs?.color === TEXT_COLORS[1]))
  assert.ok(marks.some(mark => mark.type === 'highlight' && mark.attrs?.color === HIGHLIGHT_COLORS[0]))
  const unchanged = editor.getJSON()
  assert.equal(editor.commands.setColor('url(javascript:alert(1))'), false)
  assert.equal(editor.commands.setHighlight({ color: '#abcdef' }), false)
  assert.deepEqual(editor.getJSON(), unchanged)
  editor.view.dispatch(closeHistory(editor.state.tr))
  assert.equal(editor.commands.unsetColor(), true)
  assert.equal(editor.commands.unsetHighlight(), true)
  const cleared = validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks!
  assert.ok(cleared.every(mark => mark.type !== 'textStyle' && mark.type !== 'highlight'))
  assert.ok(cleared.some(mark => mark.type === 'underline'))
  assert.equal(editor.commands.undo(), true)
  assert.ok(validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks!.some(mark => mark.type === 'highlight'))
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(validateRichDoc(editor.getJSON()), styled)
  assert.equal(editor.commands.redo(), true)
  assert.equal(editor.commands.redo(), true)
  assert.ok(validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks!.every(mark => mark.type !== 'highlight'))
})

test('finite CSS palette aliases canonicalize while arbitrary style fields are refused', () => {
  const styled = structuredClone(content) as any
  styled.content[0].content[0].marks = [{ type: 'textStyle', attrs: { color: 'rgb(220, 38, 38)' } },
    { type: 'highlight', attrs: { color: '#FEF08A' } }]
  const canonical = validateRichDoc(styled)
  assert.equal(canonical.content[0]!.content![0]!.marks![0]!.attrs!.color, '#dc2626')
  assert.equal(canonical.content[0]!.content![0]!.marks![1]!.attrs!.color, '#fef08a')
  for (const attrs of [{ color: 'expression(x)' }, { color: 'rgba(220,38,38,0.2)' }, { color: '#abcdef' },
    { color: '#dc2626', fontFamily: 'external' }]) {
    styled.content[0].content[0].marks = [{ type: 'textStyle', attrs }]
    assert.throws(() => validateRichDoc(styled), rejected)
  }
})

test('table cells retain rich formatting and derive searchable tab-separated row text', () => {
  const paragraph = (text: string, color?: string) => ({ type: 'paragraph', content: [{ type: 'text', text,
    ...(color ? { marks: [{ type: 'textStyle', attrs: { color } }] } : {}) }] })
  const input = { type: 'doc', content: [{ type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Item')] }, { type: 'tableHeader', content: [paragraph('Details')] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Meeting', '#2563eb')] }, { type: 'tableCell', content: [paragraph('Friday')] }] },
  ] }] }
  const canonical = validateRichDoc(input)
  assert.equal(docToText(canonical), 'Item\tDetails\nMeeting\tFriday')
  assert.equal(canonical.content[0]!.content![1]!.content![0]!.content![0]!.content![0]!.marks![0]!.attrs!.color, '#2563eb')
})

test('canonical table attributes detach mutable column-width arrays from the input', () => {
  const colwidth = [120]
  const canonical = validateRichDoc({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', attrs: { colwidth }, content: [{ type: 'paragraph' }] },
  ] }] }] })
  colwidth[0] = 999_999
  assert.deepEqual(canonical.content[0]!.content![0]!.content![0]!.attrs!.colwidth, [120])
})

test('malformed table grids, unbounded spans, and arbitrary cell CSS are rejected', () => {
  const cell = () => ({ type: 'tableCell', content: [{ type: 'paragraph' }] })
  const make = (rows: unknown[]) => ({ type: 'doc', content: [{ type: 'table', content: rows }] })
  assert.throws(() => validateRichDoc(make([{ type: 'tableRow', content: [cell(), cell()] }, { type: 'tableRow', content: [cell()] }])), rejected)
  assert.throws(() => validateRichDoc(make([{ type: 'tableRow' }])), rejected)
  for (const attrs of [{ colspan: 1_000 }, { rowspan: 2 }, { colspan: 2, colwidth: [80] },
    { align: 'url(external)' }, { style: 'background:url(external)' }]) {
    assert.throws(() => validateRichDoc(make([{ type: 'tableRow', content: [{ ...cell(), attrs }] }])), rejected)
  }
  // A fully covered row is valid even though it contains no new cells.
  assert.doesNotThrow(() => validateRichDoc(make([{ type: 'tableRow', content: [{ ...cell(), attrs: { rowspan: 2 } }] }, { type: 'tableRow' }])))
})

test('managed images and attachment cards carry ids and descriptions, never arbitrary source paths', () => {
  const attachmentId = 'a'.repeat(32)
  const input = { type: 'doc', content: [{ type: 'image', attrs: { attachmentId, alt: 'Screenshot' } },
    { type: 'attachment', attrs: { attachmentId, caption: 'Meeting.pdf' } }] }
  const canonical = validateRichDoc(input)
  const schema = getSchema(createJotExtensions())
  const parsed = schema.nodeFromJSON(canonical)
  assert.equal(parsed.child(0).type.name, 'image')
  assert.equal(parsed.child(1).type.name, 'attachment')
  assert.equal(docToText(canonical), 'Screenshot\nMeeting.pdf')
  assert.equal(managedAttachmentUrl(attachmentId), `/jot/api/attachments/${attachmentId}/content`)
  for (const attrs of [{ attachmentId, src: 'https://external.invalid/pixel.png' }, { attachmentId, path: '/private/file' },
    { attachmentId: '../escape' }, { attachmentId: 'A'.repeat(32) }]) {
    assert.throws(() => validateRichDoc({ type: 'doc', content: [{ type: 'image', attrs }] }), rejected)
  }
})

test('styled table and attachment references survive storage restart without losing content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jot-schema-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const editor = headless()
  t.after(() => editor.destroy())
  editor.commands.setTextSelection({ from: 1, to: 12 })
  editor.commands.setColor(TEXT_COLORS[4])
  editor.commands.setHighlight({ color: HIGHLIGHT_COLORS[1] })
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
  const content = validateRichDoc(editor.getJSON())
  content.content.push({ type: 'image', attrs: { attachmentId: 'b'.repeat(32), alt: 'Local photo' } })
  const store = new JotStore({ directory })
  const saved = await store.createNote({ title: 'Personal note', content })
  assert.deepEqual((await new JotStore({ directory }).getNote(saved.id)).content, content)
})

test('a captured source link survives actual editor defaults, table editing, and persistence roundtrip', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jot-link-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const captured = appendExcerpt(content, 'Captured text', 'https://example.org/article')
  const store = new JotStore({ directory })
  const saved = await store.createNote({ content: validateRichDoc(captured) })
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: saved.content })
  t.after(() => editor.destroy())
  assert.deepEqual(Object.keys(editor.schema.marks.link!.spec.attrs!).sort(), ['class', 'href', 'rel', 'target', 'title'])
  const beforeTable = validateRichDoc(editor.getJSON())
  const source = beforeTable.content.at(-1)!.content!.find(node => node.marks?.some(mark => mark.type === 'link'))!
  assert.equal(source.marks!.find(mark => mark.type === 'link')!.attrs!.title, null)
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  assert.equal(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true }), true)
  const updated = await store.updateNote(saved.id, saved.revision, { content: validateRichDoc(editor.getJSON()) })
  assert.ok(updated.content.content.some(node => node.type === 'table'))
  assert.deepEqual((await new JotStore({ directory }).getNote(updated.id)).content, updated.content)
})

test('link titles accept null or bounded text without widening URL and attribute permissions', () => {
  const linked = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Link', marks: [{ type: 'link', attrs }] },
  ] }] })
  assert.doesNotThrow(() => validateRichDoc(linked({ href: 'https://example.org', title: null })))
  assert.doesNotThrow(() => validateRichDoc(linked({ href: 'https://example.org', title: 'A source page' })))
  for (const attrs of [{ href: 'javascript:alert(1)', title: 'Harmless-looking title' },
    { href: 'https://example.org', title: 'x'.repeat(1_001) },
    { href: 'https://example.org', onclick: 'alert(1)' }]) assert.throws(() => validateRichDoc(linked(attrs)), rejected)
})

test('the actual ProseMirror clipboard parser preserves a managed file card instead of consuming it as a generic link', () => {
  const attachmentId = 'c'.repeat(32)
  const attributes: Record<string, string> = { 'data-type': 'jot-attachment', 'data-jot-attachment-id': attachmentId,
    href: `${managedAttachmentUrl(attachmentId)}?download=1` }
  // Minimal DOM fixture implementing the standard APIs this parser consumes.
  // Both selectors match, so the real parser must resolve their precedence.
  const text = { nodeType: 3, nodeName: '#text', nodeValue: 'Meeting.pdf', textContent: 'Meeting.pdf', nextSibling: null, parentNode: null as unknown }
  const anchor = { nodeType: 1, nodeName: 'A', tagName: 'A', childNodes: [text], firstChild: text, nextSibling: null,
    parentNode: null as unknown, textContent: 'Meeting.pdf', style: {}, contains: () => false,
    getAttribute: (name: string) => attributes[name] ?? null,
    matches: (selector: string) => selector === 'a[href]' || selector === 'a[data-type="jot-attachment"]' }
  text.parentNode = anchor
  const container = { nodeType: 1, nodeName: 'DIV', childNodes: [anchor], firstChild: anchor }
  anchor.parentNode = container
  const schema = getSchema(createJotExtensions())
  const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(container as unknown as globalThis.Node)
  const canonical = validateRichDoc(parsed.toJSON())
  assert.equal(canonical.content[0]!.type, 'attachment')
  assert.equal(canonical.content[0]!.attrs!.attachmentId, attachmentId)
  assert.equal(canonical.content[0]!.attrs!.caption, 'Meeting.pdf')
  assert.equal(canonical.content[0]!.marks, undefined)
})
