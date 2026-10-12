import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { applyLinkEdit, captureLink, linkHrefSegments, linkUnderCaret, removeLink } from '../src/client/link-commands.js'
import { translator } from '../src/client/i18n.js'
import { editorLinkEventAction, exportableLinkHref, normalizeLinkHref, openableLinkHref } from '../src/link-href.js'
import { MAX_TEXT_LENGTH, validateRichDoc } from '../src/model.js'

const paragraph = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const headless = (content: object = paragraph('Hello world')) => new Editor({ element: null, extensions: createJotExtensions(), content })
const inline = (editor: Editor) => validateRichDoc(editor.getJSON()).content[0]!.content!
const hrefs = (editor: Editor) => inline(editor).map(node => node.marks?.find(mark => mark.type === 'link')?.attrs?.href ?? null)
const linked = (text: string, href: string, extra: object[] = []) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }, ...extra] })
const select = (editor: Editor, from: number, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
const end = (editor: Editor) => editor.state.doc.content.size - 1

test('link addresses keep the typed form, credentials are never opened, and exports drop them', () => {
  assert.equal(normalizeLinkHref('  HTTPS://Example.com/a  '), 'HTTPS://Example.com/a')
  assert.equal(normalizeLinkHref('example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeLinkHref('ada@example.com'), 'mailto:ada@example.com')
  assert.equal(normalizeLinkHref('+1 (555) 010-1234'), 'tel:+1(555)010-1234')
  assert.equal(normalizeLinkHref('#section'), '#section')
  assert.equal(normalizeLinkHref('https://user:secret@example.com'), null)
  assert.equal(normalizeLinkHref('https://user@example.com/a'), null)
  assert.equal(normalizeLinkHref('javascript:alert(1)'), null)
  assert.equal(normalizeLinkHref('https://example.com/a b'), null)
  assert.equal(normalizeLinkHref('https://'), null)
  assert.equal(openableLinkHref('example.com'), 'https://example.com')
  assert.equal(openableLinkHref('https://user:secret@example.com/a'), null)
  assert.equal(openableLinkHref('tel:+15550101'), null)
  assert.equal(openableLinkHref('#section'), null)
  assert.equal(exportableLinkHref('https://user:s3cret-token@example.com/a'), 'https://example.com/a')
  assert.equal(exportableLinkHref('https://example.com/a?b=1'), 'https://example.com/a?b=1')
})

test('the editor frame opens a link once for a click or a middle-click, and leaves right-click to the browser', () => {
  const href = 'https://example.com/a'
  const ignored = { preventDefault: false, open: null }
  // Enter on a focused link in a read-only note is delivered as a primary-button click.
  assert.deepEqual(editorLinkEventAction({ type: 'click', button: 0 }, href), { preventDefault: true, open: href })
  let middleOpens = 0
  for (const type of ['mouseup', 'click', 'auxclick']) if (editorLinkEventAction({ type, button: 1 }, href).open) middleOpens++
  assert.equal(middleOpens, 1, 'the click the browser adds for the middle button does not open again')
  for (const type of ['mousedown', 'contextmenu', 'mouseup', 'auxclick']) {
    assert.deepEqual(editorLinkEventAction({ type, button: 2 }, href), ignored, `${type} with the right button`)
  }
  for (const button of [3, 4]) assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button }, href), ignored)
  assert.deepEqual(editorLinkEventAction({ type: 'click', button: 0 }, 'https://user:secret@example.com/a'), { preventDefault: true, open: null })
  assert.deepEqual(editorLinkEventAction({ type: 'auxclick', button: 1 }, '#section'), ignored)
})

test('a credential link stays in the note and renders without an href', t => {
  const href = 'https://user:pass@example.com/a'
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [linked('secret', href)] }] })
  t.after(() => editor.destroy())
  assert.deepEqual(hrefs(editor), [href])
  const domAttrs = (value: string) => {
    const type = editor.schema.marks.link!
    const spec = type.spec.toDOM?.(type.create({ href: value }), true)
    assert.ok(Array.isArray(spec))
    return spec[1] as Record<string, unknown>
  }
  assert.equal(Object.hasOwn(domAttrs(href), 'href'), false)
  assert.equal(domAttrs('https://example.com/docs').href, 'https://example.com/docs')
})

test('a selection becomes a link, an existing link can change, and removing it keeps the words', t => {
  const editor = headless()
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  editor.commands.setTextSelection({ from: 1, to: 6 })
  editor.commands.toggleBold()
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'example.com', text: '' }), true)
  assert.equal(hrefs(editor)[0], 'https://example.com')
  assert.ok(inline(editor)[0]!.marks!.some(mark => mark.type === 'bold'))
  select(editor, 2)
  const opened = captureLink(editor.state)
  assert.equal(opened.href, 'https://example.com')
  assert.equal(opened.text, 'Hello')
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/next', text: 'Hi', captured: opened }), true)
  assert.equal(editor.state.doc.textContent, 'Hi world')
  assert.equal(hrefs(editor)[0], 'https://example.com/next')
  select(editor, 2)
  assert.equal(removeLink(editor.state, editor.view.dispatch), true)
  assert.deepEqual(hrefs(editor), [null, null])
  assert.equal(editor.state.doc.textContent, 'Hi world')
  assert.equal(editor.commands.undo(), true)
  assert.equal(hrefs(editor)[0], 'https://example.com/next')
})

test('applying a link keeps mixed formatting and spaces, and covers a partly linked selection', t => {
  const mixed = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: ' Hello', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' world ' },
  ] }] })
  t.after(() => mixed.destroy())
  select(mixed, 1, end(mixed))
  assert.equal(applyLinkEdit(mixed.state, mixed.view.dispatch, { href: 'https://example.com/a', text: ' Hello world ' }), true)
  assert.deepEqual(inline(mixed).map(node => node.text), [' Hello', ' world '])
  assert.deepEqual(hrefs(mixed), ['https://example.com/a', 'https://example.com/a'])
  assert.ok(inline(mixed)[0]!.marks!.some(mark => mark.type === 'bold'))
  assert.ok(inline(mixed)[1]!.marks!.every(mark => mark.type !== 'bold'))

  const partial = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    linked('Hello', 'https://example.com/a', [{ type: 'bold' }]),
    { type: 'text', text: ' world' },
  ] }] })
  t.after(() => partial.destroy())
  select(partial, 1, end(partial))
  assert.equal(applyLinkEdit(partial.state, partial.view.dispatch, { href: 'https://example.com/a', text: 'Hello world' }), true)
  assert.deepEqual(hrefs(partial), ['https://example.com/a', 'https://example.com/a'])
})

test('an empty selection inserts the link with its stored marks, and an excluded mark or a cross-paragraph range is refused', t => {
  const editor = headless()
  t.after(() => editor.destroy())
  select(editor, 6)
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'notes.example', text: 'notes' }), true)
  assert.equal(editor.state.doc.textContent, 'Hellonotes world')

  const bold = headless({ type: 'doc', content: [{ type: 'paragraph' }] })
  t.after(() => bold.destroy())
  bold.view.dispatch(bold.state.tr.setStoredMarks([bold.schema.marks.bold!.create()]))
  assert.equal(applyLinkEdit(bold.state, bold.view.dispatch, { href: 'https://example.com/docs', text: 'docs' }), true)
  assert.deepEqual(inline(bold)[0]!.marks!.map(mark => mark.type).sort(), ['bold', 'link'])

  const cleared = headless()
  t.after(() => cleared.destroy())
  cleared.commands.setTextSelection({ from: 1, to: 6 })
  cleared.commands.toggleBold()
  select(cleared, 3)
  cleared.view.dispatch(cleared.state.tr.setStoredMarks([]))
  assert.equal(applyLinkEdit(cleared.state, cleared.view.dispatch, { href: 'https://example.com/x', text: 'X' }), true)
  assert.equal(inline(cleared).find(node => node.text === 'X')?.marks?.some(mark => mark.type === 'bold'), false)

  const coded = headless({ type: 'doc', content: [{ type: 'paragraph' }] })
  t.after(() => coded.destroy())
  coded.view.dispatch(coded.state.tr.setStoredMarks([coded.schema.marks.code!.create()]))
  const before = coded.getJSON()
  assert.equal(applyLinkEdit(coded.state, coded.view.dispatch, { href: 'https://example.com/fn', text: 'fn' }), false)
  assert.deepEqual(coded.getJSON(), before)

  const across = headless({ type: 'doc', content: [paragraph('One').content[0], paragraph('Two').content[0]] })
  t.after(() => across.destroy())
  select(across, 1, end(across))
  const unchanged = across.getJSON()
  assert.equal(applyLinkEdit(across.state, across.view.dispatch, { href: 'https://example.com', text: 'Both' }), false)
  assert.deepEqual(across.getJSON(), unchanged)
})

test('a link edit that exceeds the note length is refused on a dry run and on apply', t => {
  const editor = headless()
  t.after(() => editor.destroy())
  editor.commands.setTextSelection({ from: 1, to: 6 })
  const huge = 'x'.repeat(MAX_TEXT_LENGTH + 1)
  const before = editor.getJSON()
  assert.equal(applyLinkEdit(editor.state, undefined, { href: 'https://example.com', text: huge }), false)
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com', text: huge }), false)
  assert.equal(applyLinkEdit(editor.state, undefined, { href: 'https://example.com', text: 'hey' }), true)
  assert.deepEqual(editor.getJSON(), before)
})

test('the boundary between two links resolves to the link on the right', t => {
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [linked('left', 'https://left.example'), linked('right', 'https://right.example')] }] })
  t.after(() => editor.destroy())
  select(editor, 5)
  assert.equal(linkUnderCaret(editor.state)?.href, 'https://right.example')
  assert.equal(captureLink(editor.state).href, 'https://right.example')
  assert.equal(removeLink(editor.state, editor.view.dispatch), true)
  assert.equal(editor.state.doc.textContent, 'leftright')
  assert.deepEqual(hrefs(editor), ['https://left.example', null])
})

test('saving or removing a link does not overwrite an address that changed after the popover opened', t => {
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [linked('docs', 'https://example.com/docs')] }] })
  t.after(() => editor.destroy())
  select(editor, 2)
  const opened = captureLink(editor.state)
  editor.view.dispatch(editor.state.tr.addMark(opened.from, opened.to, editor.schema.marks.link!.create({ href: 'https://other.example/docs' })))
  const before = editor.getJSON()
  assert.equal(applyLinkEdit(editor.state, undefined, { href: 'https://example.com/new', text: 'docs', captured: opened }), 'stale')
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/new', text: 'docs', captured: opened }), 'stale')
  assert.equal(removeLink(editor.state, editor.view.dispatch, opened), false)
  assert.deepEqual(editor.getJSON(), before)
  assert.equal(translator('zh')('The note changed. Open the link again.'), '正文已变化，请重新打开链接。')
  const reopened = captureLink(editor.state)
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/new', text: 'guide', captured: reopened }), true)
  assert.equal(editor.state.doc.textContent, 'guide')
  assert.deepEqual(hrefs(editor), ['https://example.com/new'])
  select(editor, 2)
  assert.equal(removeLink(editor.state, editor.view.dispatch, captureLink(editor.state)), true)
  assert.deepEqual(hrefs(editor), [null])
})

test('saving a selection that mixes links checks each stretch, including a credential one', t => {
  const credential = 'https://user:secret@one.example/a'
  const editor = headless({ type: 'doc', content: [{ type: 'paragraph', content: [
    linked('one', credential), { type: 'text', text: ' and ' }, linked('two', 'https://two.example'),
  ] }] })
  t.after(() => editor.destroy())
  select(editor, 1, end(editor))
  const opened = captureLink(editor.state)
  assert.equal(opened.href, null)
  assert.deepEqual(opened.segments, [
    { text: 'one', href: credential },
    { text: ' and ', href: null },
    { text: 'two', href: 'https://two.example' },
  ])
  assert.deepEqual(linkHrefSegments(editor.state.doc, 2, 3), [{ text: 'n', href: credential }])
  editor.view.dispatch(editor.state.tr.addMark(opened.to - 3, opened.to, editor.schema.marks.link!.create({ href: 'https://changed.example' })))
  const before = editor.getJSON()
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/all', text: opened.text, captured: opened }), 'stale')
  assert.deepEqual(editor.getJSON(), before)
  assert.equal(applyLinkEdit(editor.state, editor.view.dispatch, { href: 'https://example.com/all', text: opened.text, captured: captureLink(editor.state) }), true)
  assert.deepEqual(linkHrefSegments(editor.state.doc, opened.from, opened.to), [{ text: 'one and two', href: 'https://example.com/all' }])
})

test('changing the address of a link that spans a line break keeps the break and links the text on both sides', t => {
  const old = 'https://old.example'
  const next = 'https://new.example'
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [
    linked('one', old, [{ type: 'bold' }]),
    { type: 'hardBreak' },
    { type: 'text', text: 'two', marks: [{ type: 'link', attrs: { href: old, title: 'Old docs' } }] },
  ] }] }

  const popover = headless(content)
  t.after(() => popover.destroy())
  select(popover, 1, end(popover))
  const opened = captureLink(popover.state)
  assert.deepEqual(opened.segments, [{ text: 'onetwo', href: old }])
  assert.equal(applyLinkEdit(popover.state, popover.view.dispatch, { href: next, text: opened.text, captured: opened }), true)
  assert.deepEqual(inline(popover).map(node => node.type), ['text', 'hardBreak', 'text'])
  assert.equal(inline(popover)[1]!.marks, undefined, 'the line break carries no marks')
  assert.deepEqual(hrefs(popover), [next, null, next])
  assert.deepEqual(inline(popover)[0]!.marks?.map(mark => mark.type).sort(), ['bold', 'link'])

  const selected = headless(content)
  t.after(() => selected.destroy())
  select(selected, 1, end(selected))
  assert.equal(applyLinkEdit(selected.state, selected.view.dispatch, { href: next, text: '' }), true)
  assert.deepEqual(hrefs(selected), [next, null, next])

  const fromBreak = headless(content)
  t.after(() => fromBreak.destroy())
  assert.equal(fromBreak.state.doc.nodeAt(4)?.type.name, 'hardBreak')
  select(fromBreak, 4, end(fromBreak))
  assert.equal(applyLinkEdit(fromBreak.state, fromBreak.view.dispatch, { href: next, text: '' }), true, 'a range that starts on the break is still applied')
  assert.deepEqual(hrefs(fromBreak), [old, null, next])
  assert.equal(inline(fromBreak)[2]!.marks?.find(mark => mark.type === 'link')?.attrs?.title, 'Old docs', 'the link keeps its other attributes')
})
