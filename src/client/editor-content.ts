import type { Editor } from '@tiptap/core'
import type { RichDoc } from './types.js'

/** Saved canonical JSON can differ in property order while representing the same document. */
export function syncEditorContent(editor: Editor, value: RichDoc): boolean {
  const incoming = editor.schema.nodeFromJSON(value)
  const { doc } = editor.state
  if (doc.eq(incoming)) return false
  // Replace only the range that changed, so the caret and selection map through
  // it. Replacing the whole document would move them to the end of the note,
  // for example when an agent's change arrives while the note has focus.
  const start = doc.content.findDiffStart(incoming.content)
  const end = doc.content.findDiffEnd(incoming.content)
  if (start !== null && end) {
    let { a: endA, b: endB } = end
    const overlap = start - Math.min(endA, endB)
    if (overlap > 0) { endA += overlap; endB += overlap }
    const tr = editor.state.tr.replace(start, endA, incoming.slice(start, endB))
    if (tr.doc.eq(incoming)) {
      // A controlled update: no update event, so the value is not echoed back.
      editor.view.dispatch(tr.setMeta('preventUpdate', true))
      return true
    }
  }
  // emitUpdate prevents a controlled-value loop. Equal documents must be skipped
  // above: setContent still records a full replacement in history otherwise.
  editor.commands.setContent(value, { emitUpdate: false })
  return true
}
