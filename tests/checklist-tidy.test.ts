import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { EditorState } from '@tiptap/pm/state'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { taskListsNeedTidy, tidyCompletedTasks, toggleTaskAtSelection } from '../src/client/list-commands.js'
import type { RichNode } from '../src/client/types.js'

const item = (text: string, checked: boolean, nested?: RichNode): RichNode => ({
  type: 'taskItem', attrs: { checked },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...(nested ? [nested] : [])],
})
const list = (...items: RichNode[]): RichNode => ({ type: 'taskList', content: items })
const labels = (editor: Editor) => {
  const names: string[] = []
  editor.state.doc.descendants(node => {
    if (node.type.name === 'taskItem') names.push(`${node.attrs.checked ? 'x' : ' '}:${node.textContent}`)
  })
  return names
}

test('completed items move under the open ones in each list, and one undo puts them back', t => {
  const nested = list(item('inner done', true), item('inner open', false))
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: {
    type: 'doc', content: [
      list(item('done first', true), item('open', false, nested), item('done second', true)),
      list(item('only open', false)),
    ],
  } })
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  const before = editor.getJSON()
  assert.equal(tidyCompletedTasks(editor.state), true)
  assert.equal(tidyCompletedTasks(editor.state, editor.view.dispatch), true)
  assert.deepEqual(labels(editor), [' :openinner openinner done', ' :inner open', 'x:inner done', 'x:done first', 'x:done second', ' :only open'])
  assert.equal(tidyCompletedTasks(editor.state), false)
  assert.equal(taskListsNeedTidy(editor.state.doc), false)
  assert.equal(taskListsNeedTidy(editor.state.doc), false)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(editor.getJSON(), before)
})

test('tidy is a separate undo step and leaves the cursor on the same item', t => {
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: {
    type: 'doc', content: [list(item('open', false), item('done', true), item('later', false))],
  } })
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  const at = (text: string) => {
    let position = -1
    editor.state.doc.descendants((node, pos) => {
      if (position >= 0) return false
      if (node.isText && node.text === text) position = pos + 1
    })
    editor.commands.setTextSelection(position)
  }
  const itemAtCursor = () => {
    const { $from } = editor.state.selection
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'taskItem') return $from.node(depth).textContent
    return ''
  }
  at('open')
  assert.equal(toggleTaskAtSelection(editor.state, editor.view.dispatch), true)
  at('done')
  const toggled = editor.getJSON()
  assert.equal(taskListsNeedTidy(editor.state.doc), true)
  assert.equal(tidyCompletedTasks(editor.state, editor.view.dispatch), true)
  assert.equal(itemAtCursor(), 'done')
  assert.deepEqual(labels(editor), [' :later', 'x:open', 'x:done'])
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(editor.getJSON(), toggled)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(labels(editor), [' :open', 'x:done', ' :later'])
})

test('a character typed immediately after tidy is its own undo', t => {
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: {
    type: 'doc', content: [list(item('done', true), item('open', false))],
  } })
  // A headless editor does not install extension plugins until it is mounted.
  editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }))
  t.after(() => editor.destroy())
  assert.equal(tidyCompletedTasks(editor.state, editor.view.dispatch), true)
  assert.deepEqual(labels(editor), [' :open', 'x:done'])
  editor.view.dispatch(editor.state.tr.insertText('Z'))
  assert.match(editor.getText(), /Z/u)
  assert.equal(editor.commands.undo(), true)
  assert.doesNotMatch(editor.getText(), /Z/u)
  assert.deepEqual(labels(editor), [' :open', 'x:done'])
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(labels(editor), ['x:done', ' :open'])
})
