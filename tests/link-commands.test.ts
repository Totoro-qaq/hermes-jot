import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { TextSelection } from '@tiptap/pm/state'
import { applyLinkEdit, blockCredentialLinkEvent, linkHrefSegments, linkMarkHref, linkUnderCaret, normalizeLinkHref, openableLinkHref, openedLinkRange, readLinkDraft, removeLink } from '../src/client/link-commands.js'
import { translator } from '../src/client/i18n.js'
import { editorLinkEventAction, exportableLinkHref, resolveEditorLinkClick } from '../src/link-href.js'
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

test('the editor frame opens a link once for a click, Enter on a focused link, or a middle-click', () => {
  const href = 'https://example.com/a'
  const opened = { preventDefault: true, open: href }
  const ignored = { preventDefault: false, open: null }
  // Enter on a focused link in a read-only note is delivered as a primary-button click.
  assert.deepEqual(editorLinkEventAction({ type: 'click', button: 0 }, href, href), opened)
  assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button: 1 }, href, href), opened)
  assert.deepEqual(editorLinkEventAction({ type: 'click', button: 1 }, href, href), ignored, 'a click the browser adds for the middle button does not open a second time')
  assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button: 2 }, href, href), ignored, 'right-click stays with the browser')
  assert.deepEqual(editorLinkEventAction({ type: 'mouseup', button: 1 }, href, href), ignored)
  let middleOpens = 0
  for (const event of [{ type: 'mouseup', button: 1 }, { type: 'click', button: 1 }, { type: 'auxclick', button: 1 }]) {
    if (editorLinkEventAction(event, href, href).open) middleOpens++
  }
  assert.equal(middleOpens, 1)
  // A right-click delivers auxclick with button 2. It must neither open the link nor cancel the context menu.
  for (const target of [href, 'example.com/docs', '#section']) {
    for (const type of ['mousedown', 'contextmenu', 'mouseup', 'auxclick']) {
      assert.deepEqual(editorLinkEventAction({ type, button: 2 }, target, target), ignored, `${type} with the right button on ${target}`)
    }
  }
  for (const button of [2, 3, 4]) assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button }, href, href), ignored, `auxclick button ${button}`)
  assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button: 2 }, 'https://user:secret@example.com/a', 'https://example.com/a'), ignored)
  assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button: 1 }, 'https://user:secret@example.com/a', 'https://example.com/a'), { preventDefault: true, open: null })
  assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button: 1 }, '#section', '#section'), ignored)
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

test('saving a selection that mixes links checks each stretch and does not overwrite a later change', t => {
  const credential = 'https://user:secret@one.example/a'
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'one', marks: [{ type: 'link', attrs: { href: credential } }] },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'two', marks: [{ type: 'link', attrs: { href: 'https://two.example' } }] },
  ] }] })
  t.after(() => editor.destroy())
  assert.equal(validateRichDoc(editor.getJSON()).content[0]!.content![0]!.marks?.[0]?.attrs?.href, credential)
  const from = 1
  const to = editor.state.doc.content.size - 1
  const original = editor.state.doc.textBetween(from, to)
  assert.equal(original, 'one and two')
  const segments = linkHrefSegments(editor.state.doc, from, to)
  assert.deepEqual(segments, [
    { text: 'one', href: credential },
    { text: ' and ', href: null },
    { text: 'two', href: 'https://two.example' },
  ])
  assert.deepEqual(linkHrefSegments(editor.state.doc, 2, 3), [{ text: 'n', href: credential }])
  assert.deepEqual(linkHrefSegments(editor.state.doc, 3, 3), [])
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
  const two = { from: to - 3, to }
  editor.view.dispatch(editor.state.tr.addMark(two.from, two.to, editor.schema.marks.link!.create({ href: 'https://changed.example' })))
  const before = editor.getJSON()
  const input = { from, to, original, originalHref: null, originalSegments: segments, text: original, href: 'https://example.com/all' }
  assert.equal(applyLinkEdit(editor.state, undefined, { ...input, originalSegments: undefined }), true, 'one collapsed address cannot see the change')
  assert.equal(applyLinkEdit(editor.state, undefined, input), 'stale')
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, input), 'stale')
  assert.deepEqual(editor.getJSON(), before)
  assert.deepEqual(linkHrefSegments(editor.state.doc, two.from, two.to), [{ text: 'two', href: 'https://changed.example' }])
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { ...input, originalSegments: linkHrefSegments(editor.state.doc, from, to) }), true)
  assert.deepEqual(linkHrefSegments(editor.state.doc, from, to), [{ text: 'one and two', href: 'https://example.com/all' }])
})

test('changing the address of a link that spans a line break keeps the break and links the text on both sides', t => {
  const old = 'https://old.example'
  const next = 'https://new.example'
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'one', marks: [{ type: 'link', attrs: { href: old } }, { type: 'bold' }] },
    { type: 'hardBreak' },
    { type: 'text', text: 'two', marks: [{ type: 'link', attrs: { href: old, title: 'Old docs' } }] },
  ] }] }
  const inline = (editor: Editor) => validateRichDoc(editor.getJSON()).content[0]!.content!
  const hrefs = (editor: Editor) => inline(editor).map(node => node.marks?.find(mark => mark.type === 'link')?.attrs?.href ?? null)

  const popover = headless(content)
  t.after(() => popover.destroy())
  const from = 1
  const to = popover.state.doc.content.size - 1
  const original = popover.state.doc.textBetween(from, to)
  assert.equal(original, 'onetwo')
  const segments = linkHrefSegments(popover.state.doc, from, to)
  assert.deepEqual(segments, [{ text: 'onetwo', href: old }])
  const input = { from, to, original, originalHref: old, originalSegments: segments, text: original, href: next }
  assert.equal(applyLinkEdit(popover.state, undefined, { ...input, href: old }), true, 'the same address is already applied')
  assert.equal(applyLinkEdit(popover.state, undefined, input), true)
  assert.equal(applyLinkEdit(popover.state, popover.view.dispatch, input), true)
  assert.deepEqual(inline(popover).map(node => node.type), ['text', 'hardBreak', 'text'])
  assert.equal(inline(popover)[1]!.marks, undefined, 'the line break carries no marks')
  assert.deepEqual(hrefs(popover), [next, null, next])
  assert.deepEqual(inline(popover)[0]!.marks?.map(mark => mark.type).sort(), ['bold', 'link'])
  assert.deepEqual(linkHrefSegments(popover.state.doc, from, to), [{ text: 'onetwo', href: next }])

  const selected = headless(content)
  t.after(() => selected.destroy())
  selected.view.dispatch(selected.state.tr.setSelection(TextSelection.create(selected.state.doc, 1, selected.state.doc.content.size - 1)))
  assert.equal(applyLinkEdit(selected.state, selected.view.dispatch, { href: next, text: '' }), true)
  assert.deepEqual(inline(selected).map(node => node.type), ['text', 'hardBreak', 'text'])
  assert.deepEqual(hrefs(selected), [next, null, next])

  const fromBreak = headless(content)
  t.after(() => fromBreak.destroy())
  const breakAt = 4
  assert.equal(fromBreak.state.doc.nodeAt(breakAt)?.type.name, 'hardBreak')
  const end = fromBreak.state.doc.content.size - 1
  assert.equal(applyLinkEdit(fromBreak.state, fromBreak.view.dispatch, {
    from: breakAt, to: end, original: 'two', originalSegments: [{ text: 'two', href: old }], text: 'two', href: next,
  }), true, 'a range that starts on the break is still applied')
  assert.deepEqual(hrefs(fromBreak), [old, null, next])
  assert.equal(inline(fromBreak)[1]!.marks, undefined)
  assert.equal(inline(fromBreak)[2]!.marks?.find(mark => mark.type === 'link')?.attrs?.title, 'Old docs', 'the link keeps its other attributes')
})
