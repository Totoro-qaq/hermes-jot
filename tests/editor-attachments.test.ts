import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { insertManagedAttachment } from '../src/client/editor-attachments.js'

test('sequential image and file uploads retain every prior attachment', () => {
  const editor = new Editor({ element: null, extensions: createJotExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph' }] } })
  try {
    assert.equal(insertManagedAttachment(editor, 'image', 'a'.repeat(32), 'image.png'), true)
    assert.equal(insertManagedAttachment(editor, 'attachment', 'b'.repeat(32), 'brief.pdf'), true)
    assert.equal(insertManagedAttachment(editor, 'image', 'c'.repeat(32), 'second.png'), true)
    assert.deepEqual(editor.getJSON().content?.filter(node => ['image', 'attachment'].includes(node.type!))
      .map(node => [node.type, node.attrs?.attachmentId]),
    [['image', 'a'.repeat(32)], ['attachment', 'b'.repeat(32)], ['image', 'c'.repeat(32)]])
  } finally { editor.destroy() }
})
