import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { applyLinkEdit, blockCredentialLinkEvent, linkMarkHref, linkUnderCaret, normalizeLinkHref, openableLinkHref, openedLinkRange, readLinkDraft, removeLink } from '../src/client/link-commands.js'
import { translator } from '../src/client/i18n.js'
import { exportableLinkHref, resolveEditorLinkClick } from '../src/link-href.js'
import { MAX_TEXT_LENGTH, validateRichDoc } from '../src/model.js'

const paragraph = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const headless = (content = paragraph('Hello world')) => new Editor({ element: null, extensions: createJotExtensions(), content })
const linkMark = (editor: Editor) => {
  const marks = validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks ?? []
  return marks.find(mark => mark.type === 'link')
}

test('link addresses keep the typed form and only add a scheme when the user left one off', () => {
  assert.equal(normalizeLinkHref('  HTTPS://Example.com/a  '), 'HTTPS://Example.com/a')
  assert.equal(normalizeLinkHref('example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeLinkHref('ada@example.com'), 'mailto:ada@example.com')
  assert.equal(normalizeLinkHref('+1 (555) 010-1234'), 'tel:+1(555)010-1234')
  assert.equal(normalizeLinkHref('mailto:ada@example.com'), 'mailto:ada@example.com')
  assert.equal(normalizeLinkHref('#section'), '#section')
  assert.equal(normalizeLinkHref('https://user:secret@example.com'), null)
  assert.equal(normalizeLinkHref('https://user@example.com/a'), null)
  assert.equal(openableLinkHref('https://user:secret@example.com/a'), null)
  assert.equal(normalizeLinkHref('javascript:alert(1)'), null)
  assert.equal(normalizeLinkHref('https://example.com/a b'), null)
  assert.equal(openableLinkHref('example.com'), 'https://example.com')
  assert.equal(openableLinkHref('ada@example.com'), 'mailto:ada@example.com')
  assert.equal(openableLinkHref('tel:+15550101'), null)
  assert.equal(openableLinkHref('#section'), null)
  assert.deepEqual(resolveEditorLinkClick('https://user:secret@example.com/a', 'https://example.com/a'), { preventDefault: true, open: null })
  assert.deepEqual(resolveEditorLinkClick('https://example.com/a', 'https://example.com/a'), { preventDefault: true, open: 'https://example.com/a' })
  assert.deepEqual(resolveEditorLinkClick('#section', '#section'), { preventDefault: false, open: null })
  assert.equal(exportableLinkHref('https://user:s3cret-token@example.com/a'), 'https://example.com/a')
  assert.equal(exportableLinkHref('https://example.com/a?b=1'), 'https://example.com/a?b=1')
})

test('a selection becomes a link, an existing link can change, and removing it keeps the words', t => {
  const editor = headless()
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  editor.commands.setTextSelection({ from: 1, to: 6 })
  editor.commands.toggleBold()
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'example.com', text: '' }), true)
  const linked = linkMark(editor)
  assert.equal(linked?.attrs?.href, 'https://example.com')
  assert.ok(validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks!.some(mark => mark.type === 'bold'))
  editor.commands.setTextSelection(2)
  assert.deepEqual(readLinkDraft(editor.state), { href: 'https://example.com', text: 'Hello' })
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/next', text: 'Hi' }), true)
  assert.equal(editor.state.doc.textBetween(0, editor.state.doc.content.size), 'Hi world')
  assert.equal(linkMark(editor)?.attrs?.href, 'https://example.com/next')
  editor.commands.setTextSelection(2)
  assert.equal(removeLink(editor.state, editor.view.dispatch), true)
  assert.equal(linkMark(editor), undefined)
  assert.equal(editor.state.doc.textBetween(0, editor.state.doc.content.size), 'Hi world')
  assert.equal(editor.commands.undo(), true)
  assert.equal(linkMark(editor)?.attrs?.href, 'https://example.com/next')
})

test('applying a link keeps mixed formatting and spaces, and covers a partly linked selection', t => {
  const mixed = new Editor({ element: null, extensions: createJotExtensions(), content: {
    type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: ' Hello', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' world ' },
    ] }],
  } })
  t.after(() => mixed.destroy())
  mixed.commands.setTextSelection({ from: 1, to: mixed.state.doc.content.size - 1 })
  const text = mixed.state.doc.textBetween(mixed.state.selection.from, mixed.state.selection.to)
  assert.equal(text, ' Hello world ')
  assert.equal(applyLinkEdit(mixed.state, mixed.view.dispatch, { href: 'https://example.com/a', text }), true)
  const nodes = validateRichDoc(mixed.getJSON()).content[0]!.content!
  assert.equal(nodes.map(node => node.text).join(''), ' Hello world ')
  assert.equal(nodes[0]!.text, ' Hello')
  assert.ok(nodes[0]!.marks!.some(mark => mark.type === 'bold'))
  assert.ok(nodes[0]!.marks!.some(mark => mark.type === 'link' && mark.attrs?.href === 'https://example.com/a'))
  assert.equal(nodes[1]!.text, ' world ')
  assert.equal(nodes[1]!.marks!.some(mark => mark.type === 'bold'), false)
  assert.ok(nodes[1]!.marks!.every(mark => mark.type !== 'bold'))
  assert.ok(nodes[1]!.marks!.some(mark => mark.type === 'link' && mark.attrs?.href === 'https://example.com/a'))

  const partial = new Editor({ element: null, extensions: createJotExtensions(), content: {
    type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hello', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }, { type: 'bold' }] },
      { type: 'text', text: ' world' },
    ] }],
  } })
  t.after(() => partial.destroy())
  partial.commands.setTextSelection({ from: 1, to: partial.state.doc.content.size - 1 })
  const partialText = partial.state.doc.textBetween(partial.state.selection.from, partial.state.selection.to)
  assert.equal(applyLinkEdit(partial.state, partial.view.dispatch, { href: 'https://example.com/a', text: partialText }), true)
  const parts = validateRichDoc(partial.getJSON()).content[0]!.content!
  assert.equal(parts.map(node => node.text).join(''), 'Hello world')
  for (const node of parts) assert.ok(node.marks!.some(mark => mark.type === 'link' && mark.attrs?.href === 'https://example.com/a'), node.text)
  assert.ok(parts[0]!.marks!.some(mark => mark.type === 'bold'))
  assert.ok(parts[1]!.marks!.every(mark => mark.type !== 'bold'))
})

test('an empty selection inserts the link, and a selection across paragraphs is refused', t => {
  const editor = headless()
  t.after(() => editor.destroy())
  editor.commands.setTextSelection(6)
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'notes.example', text: 'notes' }), true)
  assert.equal(editor.state.doc.textBetween(0, editor.state.doc.content.size), 'Hellonotes world')
  const across = new Editor({ element: null, extensions: createJotExtensions(), content: {
    type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
    ],
  } })
  t.after(() => across.destroy())
  across.commands.setTextSelection({ from: 1, to: across.state.doc.content.size - 1 })
  const before = across.getJSON()
  assert.equal(applyLinkEdit(across.state, across.view.dispatch, { href: 'https://example.com', text: 'Both' }), false)
  assert.deepEqual(across.getJSON(), before)
})

function linkDomAttrs(editor: Editor, href: string): Record<string, unknown> {
  const type = editor.schema.marks.link
  assert.ok(type)
  const spec = type.spec.toDOM?.(type.create({ href }))
  assert.ok(Array.isArray(spec))
  const attrs = spec[1]
  assert.equal(typeof attrs, 'object')
  assert.ok(attrs && !Array.isArray(attrs))
  return attrs as Record<string, unknown>
}

test('a credential link is rendered without an href, and click and middle-click are cancelled', t => {
  const href = 'https://user:pass@example.com/a'
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'secret', marks: [{ type: 'link', attrs: { href } }] }] }] })
  t.after(() => editor.destroy())
  assert.equal(linkMark(editor)?.attrs?.href, href, 'a stored credential address stays in the note')
  const blocked = linkDomAttrs(editor, href)
  assert.equal(Object.hasOwn(blocked, 'href'), false)
  assert.equal(linkDomAttrs(editor, 'https://example.com/docs').href, 'https://example.com/docs')
  let prevented = 0
  const prevent = () => { prevented++ }
  assert.equal(blockCredentialLinkEvent({ type: 'click', preventDefault: prevent }, href, false), true)
  assert.equal(blockCredentialLinkEvent({ type: 'auxclick', preventDefault: prevent }, 'https://user@example.com/a', false), true)
  assert.equal(prevented, 2)
  assert.equal(blockCredentialLinkEvent({ type: 'click', preventDefault: prevent }, 'https://example.com', false), false)
  assert.equal(blockCredentialLinkEvent({ type: 'auxclick', preventDefault: prevent }, 'https://example.com', false), false)
  assert.equal(blockCredentialLinkEvent({ type: 'mousedown', preventDefault: prevent }, href, false), false)
  assert.equal(blockCredentialLinkEvent({ type: 'auxclick', preventDefault: prevent }, href, true), false)
  assert.equal(prevented, 2)
})

test('the boundary between two links resolves to the link on the right', t => {
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'left', marks: [{ type: 'link', attrs: { href: 'https://left.example' } }] },
    { type: 'text', text: 'right', marks: [{ type: 'link', attrs: { href: 'https://right.example' } }] },
  ] }] })
  t.after(() => editor.destroy())
  let boundary = -1
  editor.state.doc.descendants((node, position) => {
    if (boundary < 0 && node.isText && node.text === 'right') boundary = position
  })
  assert.ok(boundary > 0)
  assert.equal(linkMarkHref(editor.state, boundary), 'https://right.example')
  assert.equal(linkMarkHref(editor.state, boundary + 1), 'https://right.example')
  assert.equal(linkMarkHref(editor.state, boundary - 1), 'https://left.example')
  editor.commands.setTextSelection(boundary)
  assert.equal(readLinkDraft(editor.state)?.href, 'https://right.example')
  assert.equal(linkUnderCaret(editor.state)?.href, 'https://right.example')
  assert.equal(removeLink(editor.state, editor.view.dispatch), true)
  assert.equal(editor.state.doc.textBetween(0, editor.state.doc.content.size), 'leftright')
  const nodes = validateRichDoc(editor.getJSON()).content[0]!.content!
  assert.equal(nodes[0]!.text, 'left')
  assert.equal(nodes[0]!.marks?.[0]?.attrs?.href, 'https://left.example')
  assert.equal(nodes[1]!.text, 'right')
  assert.equal(nodes[1]!.marks, undefined)
})

test('inserting a link at the caret keeps stored marks such as bold', t => {
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph' }] })
  t.after(() => editor.destroy())
  assert.equal(editor.state.selection.empty, true)
  editor.view.dispatch(editor.state.tr.setStoredMarks([editor.schema.marks.bold!.create()]))
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/docs', text: 'docs' }), true)
  assert.equal(editor.state.doc.textContent, 'docs')
  const marks = validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks!.map(mark => mark.type).sort()
  assert.deepEqual(marks, ['bold', 'link'])

  const coded = headless({ type: 'doc', content: [{ type: 'paragraph' }] })
  t.after(() => coded.destroy())
  coded.view.dispatch(coded.state.tr.setStoredMarks([coded.schema.marks.code!.create()]))
  const before = coded.getJSON()
  assert.equal(applyLinkEdit(coded.state, undefined, { href: 'https://example.com/fn', text: 'fn' }), false)
  assert.deepEqual(coded.getJSON(), before)
  assert.equal(applyLinkEdit(coded.state, coded.view.dispatch, { href: 'https://example.com/fn', text: 'fn' }), false)
  assert.deepEqual(coded.getJSON(), before)

  const neighbor = headless()
  t.after(() => neighbor.destroy())
  neighbor.commands.setTextSelection({ from: 1, to: 6 })
  neighbor.commands.toggleBold()
  neighbor.commands.setTextSelection(3)
  neighbor.view.dispatch(neighbor.state.tr.setStoredMarks([]))
  assert.equal(applyLinkEdit(neighbor.state, neighbor.view.dispatch, { href: 'https://example.com/x', text: 'X' }), true)
  const pieces = validateRichDoc(neighbor.getJSON()).content[0]!.content!
  const inserted = pieces.find(node => node.text === 'X')
  assert.ok(inserted)
  assert.equal(inserted.marks?.some(mark => mark.type === 'bold'), false)
  assert.ok(inserted.marks?.some(mark => mark.type === 'link'))
})

test('a link edit that exceeds the note length is refused on a dry run and on apply', t => {
  const editor = headless()
  t.after(() => editor.destroy())
  editor.commands.setTextSelection({ from: 1, to: 6 })
  const huge = 'x'.repeat(MAX_TEXT_LENGTH + 1)
  const before = editor.getJSON()
  assert.equal(applyLinkEdit(editor.state, undefined, { href: 'https://example.com', text: huge }), false)
  assert.deepEqual(editor.getJSON(), before)
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com', text: huge }), false)
  assert.deepEqual(editor.getJSON(), before)
  assert.equal(applyLinkEdit(editor.state, undefined, { href: 'https://example.com', text: 'hey' }), true)
  assert.deepEqual(editor.getJSON(), before)
})

test('remove uses the address from when the popover opened, not the address typed afterwards', t => {
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com/docs' } }] },
  ] }] })
  t.after(() => editor.destroy())
  const found = linkUnderCaret(editor.state)
  assert.ok(found)
  const opened = { from: found.from, to: found.to, original: found.text, originalHref: found.href }
  assert.equal(removeLink(editor.state, editor.view.dispatch, {
    from: opened.from, to: opened.to, original: opened.original, href: 'https://edited.example',
  }), false)
  assert.equal(linkUnderCaret(editor.state)?.href, 'https://example.com/docs')
  assert.deepEqual(openedLinkRange(opened), {
    from: found.from, to: found.to, original: 'docs', href: 'https://example.com/docs',
  })
  assert.equal(removeLink(editor.state, editor.view.dispatch, openedLinkRange(opened)), true)
  assert.equal(linkUnderCaret(editor.state), null)
  assert.equal(editor.state.doc.textContent, 'docs')
})

test('saving a link does not overwrite an address that changed after the popover opened', t => {
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com/docs' } }] },
  ] }] })
  t.after(() => editor.destroy())
  const found = linkUnderCaret(editor.state)
  assert.ok(found)
  const link = editor.schema.marks.link!
  editor.view.dispatch(editor.state.tr.addMark(found.from, found.to, link.create({ href: 'https://other.example/docs' })))
  const before = editor.getJSON()
  const conflict = {
    from: found.from, to: found.to, original: 'docs', originalHref: 'https://example.com/docs',
    text: 'docs', href: 'https://example.com/new',
  }
  assert.equal(applyLinkEdit(editor.state, undefined, conflict), 'stale')
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, conflict), 'stale')
  assert.deepEqual(editor.getJSON(), before)
  assert.equal(linkUnderCaret(editor.state)?.href, 'https://other.example/docs')
  assert.equal(translator('en')('The note changed. Open the link again.'), 'The note changed. Open the link again.')
  assert.equal(translator('zh')('The note changed. Open the link again.'), '正文已变化，请重新打开链接。')
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, {
    from: found.from, to: found.to, original: 'docs', originalHref: 'https://other.example/docs',
    text: 'guide', href: 'https://example.com/new',
  }), true)
  assert.equal(editor.state.doc.textContent, 'guide')
  assert.equal(linkUnderCaret(editor.state)?.href, 'https://example.com/new')
})
