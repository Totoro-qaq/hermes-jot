import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'

/** Adding files after an atom must not silently replace the previous upload. */
export function insertManagedAttachment(editor: Editor, type: 'image' | 'attachment', id: string, description = ''): boolean {
  const content = { type, attrs: { attachmentId: id, [type === 'image' ? 'alt' : 'caption']: description } }
  const { selection } = editor.state
  if (selection instanceof NodeSelection && ['image', 'attachment'].includes(selection.node.type.name)) {
    return editor.commands.insertContentAt(selection.to, content)
  }
  return editor.commands.insertContent(content)
}
