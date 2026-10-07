import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor, type JSONContent } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { applySlashItem, filterSlashItems, SLASH_ITEMS, slashMatch } from '../src/client/slash-menu.js'
import { shortcutHelpSections, shortcutLabel, withShortcut } from '../src/client/shortcut-labels.js'
import { validateRichDoc } from '../src/model.js'

const paragraph = (value?: string) => ({ type: 'paragraph', ...(value ? { content: [{ type: 'text', text: value }] } : {}) })
function create(content: JSONContent[]) {
  return new Editor({ element: null, extensions: createJotExtensions(), content: { type: 'doc', content } })
}
/** Caret at the end of the first paragraph whose text is exactly `value`. */
function endOf(editor: Editor, value: string) {
  let position = -1
  editor.state.doc.descendants((node, at) => {
    if (position < 0 && node.type.name === 'paragraph' && node.textContent === value) position = at + 1 + node.content.size
  })
  assert.ok(position >= 0, `missing paragraph ${value}`)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)))
}
const ids = (query: string, attachments = false) => filterSlashItems(query, { attachments }).map(item => item.id)

test('the slash menu opens only on a line holding nothing but "/" or "、" and its filter', t => {
  const editor = create([paragraph('/'), paragraph('、bt'), paragraph('日期 10/5'), paragraph('/ 空格'), paragraph('/标题'),
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('/db')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('/x')] }] }] }])
  t.after(() => editor.destroy())
  endOf(editor, '/')
  assert.deepEqual(slashMatch(editor.state), { from: 1, to: 2, query: '' })
  endOf(editor, '、bt')
  assert.equal(slashMatch(editor.state)?.query, 'bt', 'the Chinese input method\'s 、 is the same key')
  endOf(editor, '日期 10/5')
  assert.equal(slashMatch(editor.state), null, 'a slash inside a sentence keeps writing')
  endOf(editor, '/ 空格')
  assert.equal(slashMatch(editor.state), null, 'a space ends the filter')
  endOf(editor, '/标题')
  assert.equal(slashMatch(editor.state)?.query, '标题')
  endOf(editor, '/db')
  assert.equal(slashMatch(editor.state)?.query, 'db', 'list items can become other blocks too')
  endOf(editor, '/x')
  assert.equal(slashMatch(editor.state), null, 'tables keep the slash literal')
  endOf(editor, '/标题')
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, editor.state.selection.from - 1)))
  assert.equal(slashMatch(editor.state), null, 'the caret must sit after the filter')
})

test('filters match Chinese labels, English words and pinyin initials, with label prefixes first', () => {
  assert.deepEqual(ids(''), SLASH_ITEMS.filter(item => item.id !== 'attachment').map(item => item.id))
  assert.ok(ids('', true).includes('attachment'), 'the file item appears only where uploads are possible')
  assert.deepEqual(ids('bt'), ['heading1', 'heading2', 'heading3'])
  assert.deepEqual(ids('标题 2'), ['heading2'])
  assert.equal(ids('h2')[0], 'heading2')
  assert.equal(ids('待办')[0], 'taskList')
  assert.equal(ids('db')[0], 'taskList')
  assert.equal(ids('todo')[0], 'taskList')
  assert.equal(ids('表格')[0], 'table')
  assert.equal(ids('fgx')[0], 'horizontalRule')
  assert.deepEqual(ids('lb'), ['bulletList', 'orderedList'])
  assert.deepEqual(ids('Quote'), ['blockquote'], 'English matching ignores case')
  assert.deepEqual(ids('zzz'), [])
})

test('choosing an item removes the typed trigger and produces persistable blocks', t => {
  const editor = create([paragraph('前文'), paragraph('/bt'), paragraph('、'), paragraph('/table'), paragraph('/db')])
  t.after(() => editor.destroy())
  endOf(editor, '/bt')
  assert.equal(applySlashItem(editor, slashMatch(editor.state)!, 'heading2', { focus: false }), true)
  endOf(editor, '、')
  assert.equal(applySlashItem(editor, slashMatch(editor.state)!, 'horizontalRule', { focus: false }), true)
  endOf(editor, '/table')
  assert.equal(applySlashItem(editor, slashMatch(editor.state)!, 'table', { focus: false }), true)
  endOf(editor, '/db')
  let requested = 0
  assert.equal(applySlashItem(editor, slashMatch(editor.state)!, 'taskList', { focus: false, requestAttachment: () => requested++ }), true)
  assert.equal(requested, 0, 'only the file item opens the picker')
  const doc = validateRichDoc(editor.getJSON())
  // Tiptap may add a trailing paragraph after the final block; the converted blocks come first.
  assert.deepEqual(doc.content.slice(0, 5).map(block => block.type), ['paragraph', 'heading', 'horizontalRule', 'table', 'taskList'])
  assert.equal(doc.content[1]!.attrs?.level, 2)
  assert.equal(editor.state.doc.textContent.includes('/'), false, 'no trigger text is left behind')
  assert.equal(editor.state.doc.textContent.includes('、'), false)
})

test('the file item clears its trigger before asking the host for a file', t => {
  const editor = create([paragraph('/tp')])
  t.after(() => editor.destroy())
  endOf(editor, '/tp')
  let requested = 0
  assert.equal(applySlashItem(editor, slashMatch(editor.state)!, 'attachment', { focus: false, requestAttachment: () => requested++ }), true)
  assert.equal(requested, 1)
  assert.equal(editor.state.doc.textContent, '')
})

test('shortcut labels follow each platform\'s conventions', () => {
  assert.equal(shortcutLabel('heading2', true), '⌥⌘2')
  assert.equal(shortcutLabel('heading2', false), 'Ctrl+Alt+2')
  assert.equal(shortcutLabel('bulletList', true), '⇧⌘8')
  assert.equal(shortcutLabel('bulletList', false), 'Ctrl+Shift+8')
  assert.equal(shortcutLabel('toggleTask', true), '⌘↩')
  assert.equal(shortcutLabel('toggleTask', false), 'Ctrl+Enter')
  assert.equal(shortcutLabel('moveUp', true), '⌥⇧↑')
  assert.equal(shortcutLabel('moveDown', false), 'Alt+Shift+↓')
  assert.equal(shortcutLabel('searchLibrary', false), '/')
  assert.equal(withShortcut('待办清单', 'taskList', true), '待办清单 (⇧⌘9)')
  assert.equal(withShortcut('插入表格', undefined, true), '插入表格')
  for (const locale of ['zh', 'en'] as const) for (const apple of [true, false]) {
    const sections = shortcutHelpSections(locale, apple)
    assert.ok(sections.length >= 5)
    for (const section of sections) for (const row of section.rows) {
      assert.ok(row.label && row.keys.length && row.keys.every(Boolean), `${locale}/${apple}: ${row.label}`)
    }
  }
  assert.ok(shortcutHelpSections('zh', true).some(section => section.rows.some(row => row.keys.includes('、'))))
})
