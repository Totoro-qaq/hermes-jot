import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { tidyCompletedTasks } from '../src/client/list-commands.js'
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
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(editor.getJSON(), before)
})
