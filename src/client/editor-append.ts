import type { Editor } from '@tiptap/core'
import { history } from '@tiptap/pm/history'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { RichNode } from './types.js'

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])
const emptyParagraph = (node: ProseMirrorNode | null) => node?.type.name === 'paragraph' && node.content.size === 0
// The same key and empty state as StarterKit's UndoRedo plugin, which comes from this module.
const blankHistory = history()

/**
 * Start a new undo history. prosemirror-history has no reset command; a transaction
 * that carries its key sets the plugin's state, the way its own undo does. Every
 * other plugin sees an ordinary transaction without steps.
 */
function clearHistory(view: EditorView) {
  const key = blankHistory.spec.key!
  if (!key.get(view.state)) return
  view.dispatch(view.state.tr.setMeta(key, { historyState: blankHistory.spec.state!.init({} as never, view.state) }))
}

/**
 * Apply a remote append to the live document in one transaction, the way the
 * server's appendBlocks does: a blank document is replaced and a list that
 * continues the final list of the same kind joins it. The empty paragraph that
 * Tiptap keeps after a final list or table is not content and stays last.
 */
export function appendEditorBlocks(editor: Pick<Editor, 'state' | 'view'>, blocks: readonly RichNode[]): boolean {
  const { state } = editor
  let nodes: ProseMirrorNode[]
  try {
    nodes = blocks.map(block => {
      const node = state.schema.nodeFromJSON(block)
      node.check()
      return node
    })
  } catch { return false }
  if (!nodes.length || nodes.some(node => !node.isBlock)) return false
  const { doc } = state
  const tr = state.tr
  if (doc.childCount === 1 && emptyParagraph(doc.firstChild)) tr.replaceWith(0, doc.content.size, nodes)
  else {
    const trailing = doc.childCount > 1 && emptyParagraph(doc.lastChild) && doc.child(doc.childCount - 2).type.name !== 'paragraph'
    const last = doc.child(doc.childCount - (trailing ? 2 : 1))
    let end = doc.content.size - (trailing ? doc.lastChild!.nodeSize : 0)
    const first = nodes[0]!
    if (LIST_TYPES.has(last.type.name) && last.type === first.type) {
      tr.insert(end - 1, first.content)
      end += first.content.size
      nodes = nodes.slice(1)
    }
    if (nodes.length) tr.insert(end, nodes)
  }
  if (!tr.docChanged) return false
  // Another author's text is not the user's to undo.
  tr.setMeta('addToHistory', false)
  editor.view.dispatch(tr)
  // The user's earlier steps would be mapped through it: undoing a pasted final
  // list the agent's items joined, or a clear the agent's text replaced, would
  // delete that text too, and autosave would store the loss at the agent's
  // revision. Undo history starts again after a merge.
  clearHistory(editor.view)
  return true
}
