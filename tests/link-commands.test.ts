import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { applyLinkEdit, normalizeLinkHref, openableLinkHref, readLinkDraft, removeLink } from '../src/client/link-commands.js'
import { validateRichDoc } from '../src/model.js'

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
  assert.equal(normalizeLinkHref('javascript:alert(1)'), null)
  assert.equal(normalizeLinkHref('https://example.com/a b'), null)
  assert.equal(openableLinkHref('example.com'), 'https://example.com')
  assert.equal(openableLinkHref('ada@example.com'), 'mailto:ada@example.com')
  assert.equal(openableLinkHref('tel:+15550101'), null)
  assert.equal(openableLinkHref('#section'), null)
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
