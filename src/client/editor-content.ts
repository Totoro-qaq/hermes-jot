import type { Editor } from '@tiptap/core'
import type { RichDoc } from './types.js'

/** Saved canonical JSON can differ in property order while representing the same document. */
export function syncEditorContent(editor: Editor, value: RichDoc): boolean {
  const incoming = editor.schema.nodeFromJSON(value)
  if (editor.state.doc.eq(incoming)) return false
  // emitUpdate prevents a controlled-value loop. Equal documents must be skipped
  // above: setContent still records a full replacement in history otherwise.
  editor.commands.setContent(value, { emitUpdate: false })
  return true
}
