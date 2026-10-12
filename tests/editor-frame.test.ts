import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { acceptEditorRevision, acknowledgedRevision, guestEditorAction, mountEditorSession, nextEditorFrame, rememberEditorStamp, reportDroppedEdit, type EditorRevision } from '../src/hermes/editor-frame.js'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { sameEditorDocument } from '../src/rich-equal.js'

const text = (value: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: value }] }] })
const doc = text('From A')

test('edits after reopening a note are saved, and a late echo from the earlier visit is not', () => {
  const first = nextEditorFrame('note-a')
  const other = nextEditorFrame('note-b')
  const reopened = nextEditorFrame('note-a')
  assert.ok(first.generation < other.generation && other.generation < reopened.generation)
  let known: EditorRevision | undefined
  const apply = (incoming: EditorRevision) => {
    if (!acceptEditorRevision(known, incoming)) return false
    known = incoming
    return true
  }
  assert.equal(apply({ generation: first.generation, revision: 9 }), true)
  assert.equal(apply({ generation: reopened.generation, revision: 1 }), true, 'the reopened editor counts revisions from 1 again')
  assert.equal(apply({ generation: first.generation, revision: 10 }), false, 'the earlier visit cannot overwrite newer edits')
  assert.equal(apply({ generation: reopened.generation, revision: 0 }), false)
  assert.equal(apply({ generation: reopened.generation, revision: 2 }), true)
  assert.equal(acknowledgedRevision(known, reopened), 2)
  assert.equal(acknowledgedRevision(known, first), 0, 'another generation’s revision is not acknowledged')

  const again = nextEditorFrame('note-a')
  const session = mountEditorSession(again, doc)
  assert.equal(session.hostUpdate(doc, acknowledgedRevision(known, again)), doc, 'the first paint shows the host document')
  const typed = session.change(text('newer'))
  assert.equal(typed.revision, 1, 'the previous generation’s revision is not adopted')
  assert.equal(apply({ generation: again.generation, revision: typed.revision }), true)
  assert.equal(session.hostUpdate(text('stale echo'), 0), typed.content, 'an echo older than the keystroke is ignored')
  assert.equal(session.hostUpdate(typed.content, typed.revision), typed.content)

  assert.deepEqual(guestEditorAction(reopened, 'change', { content: doc, revision: 3, documentId: 'note-a', generation: first.generation }), { type: 'drop', reason: 'stamp' })
  assert.deepEqual(guestEditorAction(reopened, 'change', { content: doc, revision: 3, documentId: 'note-a', generation: reopened.generation }),
    { type: 'change', content: doc, revision: 3, documentId: 'note-a', generation: reopened.generation })
  assert.deepEqual(guestEditorAction(reopened, 'ready', null), { type: 'unhandled' })
})

test('a late change or flush from a recent note keeps its own stamp, and selections only count for the open note', () => {
  const noteA = nextEditorFrame('note-a')
  const noteB = nextEditorFrame('note-b')
  const noteC = nextEditorFrame('note-c')
  const recent = rememberEditorStamp(rememberEditorStamp([], noteA), noteB)
  const sessionA = mountEditorSession(noteA, text('A'))
  assert.equal(sessionA.pendingChange(text('A')), null, 'leaving an unchanged note sends nothing')
  const late = sessionA.pendingChange(text('A!'))
  assert.ok(late)
  assert.equal(sessionA.pendingChange(text('A!')), null)
  assert.deepEqual(guestEditorAction(noteC, 'change', late, recent),
    { type: 'change', content: late.content, revision: late.revision, documentId: 'note-a', generation: noteA.generation })
  assert.deepEqual(guestEditorAction(noteC, 'flushed', { protocol: 1, documentId: 'note-a', generation: noteA.generation }, recent),
    { type: 'flushed', documentId: 'note-a', generation: noteA.generation })
  assert.equal(guestEditorAction(noteC, 'flushed', { documentId: 'note-a', generation: noteC.generation }, recent).type, 'drop')
  assert.equal(guestEditorAction(noteC, 'selection', sessionA.selection('A'), recent).type, 'drop')
  assert.deepEqual(guestEditorAction(noteC, 'selection', { text: 'C', documentId: 'note-c', generation: noteC.generation }), { type: 'selection', text: 'C' })
  assert.deepEqual(guestEditorAction(noteC, 'selection', 'C'), { type: 'drop', reason: 'shape' })

  let crowded: ReturnType<typeof rememberEditorStamp> = []
  for (let index = 0; index < 40; index++) crowded = rememberEditorStamp(crowded, nextEditorFrame(`n${index}`))
  assert.equal(crowded.length, 32)
  assert.equal(guestEditorAction(noteC, 'change', { content: doc, revision: 1, ...crowded[0]! }, crowded).type, 'change')
  assert.equal(guestEditorAction(noteC, 'change', { content: doc, revision: 1, documentId: 'n0', generation: crowded[0]!.generation - 8 }, crowded).type, 'drop')
})

test('opening a note does not look edited when the editor fills schema defaults', () => {
  const stored = { type: 'doc' as const, content: [
    { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Hi', marks: [
      { type: 'bold' as const },
      { type: 'link' as const, attrs: { href: 'https://example.com' } },
    ] }] },
    { type: 'orderedList' as const, content: [{ type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'One' }] }] }] },
  ] }
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: stored })
  try {
    assert.equal(sameEditorDocument(stored, editor.getJSON()), true)
    assert.equal(mountEditorSession(nextEditorFrame('note-a'), stored).pendingChange(editor.getJSON() as typeof stored), null)
    const renumbered = structuredClone(stored)
    renumbered.content[1] = { ...renumbered.content[1], attrs: { start: 3 } }
    assert.equal(sameEditorDocument(stored, renumbered), false)
  } finally { editor.destroy() }
})

test('a protocol mismatch drops the edit and is logged', () => {
  const calls: unknown[][] = []
  const original = console.debug
  console.debug = (...args: unknown[]) => { calls.push(args) }
  try {
    const frame = nextEditorFrame('note-a')
    const dropped = guestEditorAction(frame, 'change', { protocol: 99, content: doc, revision: 1, ...frame })
    assert.deepEqual(dropped, { type: 'drop', reason: 'protocol' })
    if (dropped.type === 'drop') reportDroppedEdit(dropped.reason, { protocol: 99, ...frame })
    assert.equal(calls.length, 1)
    assert.match(String(calls[0]?.[0]), /dropped a change/u)
  } finally { console.debug = original }
})
