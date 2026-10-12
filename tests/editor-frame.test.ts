import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceEditorFrame, guestEditorAction, initialEditorFrame, mountEditorSession, rememberEditorStamp, reportDroppedEdit } from '../src/hermes/editor-frame.js'
import { editorLoadOffersRetry, initialEditorLoad, reduceEditorLoad } from '../src/hermes/editor-load.js'

const doc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'From A' }] }] }

test('a late change after switching notes is dropped, including a return to the first note', () => {
  const noteA = initialEditorFrame('note-a')
  const changeA = { content: doc, revision: 4, documentId: 'note-a', generation: 0 }
  assert.deepEqual(guestEditorAction(noteA, 'change', changeA), { type: 'change', content: doc, revision: 4, documentId: 'note-a' })
  assert.deepEqual(guestEditorAction(noteA, 'selection', { text: 'From A', documentId: 'note-a', generation: 0 }), { type: 'selection', text: 'From A' })
  assert.deepEqual(guestEditorAction(noteA, 'selection', 'From A'), { type: 'drop', reason: 'shape' })
  const noteB = advanceEditorFrame(noteA, 'note-b')
  assert.deepEqual(noteB, { documentId: 'note-b', generation: 1 })
  assert.equal(advanceEditorFrame(noteB, 'note-b'), noteB)
  assert.deepEqual(guestEditorAction(noteB, 'change', changeA), { type: 'drop', reason: 'stamp' })
  assert.deepEqual(guestEditorAction(noteB, 'selection', { text: 'From A', documentId: 'note-a', generation: 0 }), { type: 'drop', reason: 'stamp' })
  assert.deepEqual(guestEditorAction(noteB, 'change', { content: doc, revision: 1, documentId: 'note-b', generation: 0 }), { type: 'drop', reason: 'stamp' })
  const fresh = { content: doc, revision: 1, documentId: 'note-b', generation: 1 }
  assert.equal(guestEditorAction(noteB, 'change', fresh).type, 'change')
  const back = advanceEditorFrame(noteB, 'note-a')
  assert.equal(back.generation, 2)
  assert.deepEqual(guestEditorAction(back, 'change', changeA), { type: 'drop', reason: 'stamp' })
  assert.equal(guestEditorAction(back, 'change', { ...changeA, generation: 2 }).type, 'change')
  assert.deepEqual(guestEditorAction(back, 'ready', null), { type: 'unhandled' })
  const previous = guestEditorAction(noteB, 'change', changeA, [noteA])
  assert.deepEqual(previous, { type: 'change', content: doc, revision: 4, documentId: 'note-a' })
})

test('a late flush from an earlier note is kept across two switches, including a return', () => {
  const noteA = initialEditorFrame('note-a')
  const noteB = advanceEditorFrame(noteA, 'note-b')
  const noteC = advanceEditorFrame(noteB, 'note-c')
  const recent = rememberEditorStamp(rememberEditorStamp([], noteA), noteB)
  const changeA = { content: doc, revision: 2, documentId: 'note-a', generation: 0 }
  const onC = guestEditorAction(noteC, 'change', changeA, recent)
  assert.deepEqual(onC, { type: 'change', content: doc, revision: 2, documentId: 'note-a' })
  const back = advanceEditorFrame(noteC, 'note-a')
  assert.equal(back.generation, 3)
  const onReturn = guestEditorAction(back, 'change', changeA, rememberEditorStamp(recent, noteC))
  assert.deepEqual(onReturn, { type: 'change', content: doc, revision: 2, documentId: 'note-a' })
  assert.equal(guestEditorAction(noteC, 'selection', { text: 'From A', documentId: 'note-a', generation: 0 }, recent).type, 'drop')
  assert.equal(guestEditorAction(noteC, 'change', { ...changeA, generation: 9 }, recent).type, 'drop')
  let crowded = [] as typeof recent
  for (let generation = 0; generation < 40; generation++) crowded = rememberEditorStamp(crowded, { documentId: `n${generation}`, generation })
  assert.equal(crowded.length, 32)
  assert.equal(guestEditorAction(noteC, 'change', { content: doc, revision: 1, documentId: 'n0', generation: 0 }, crowded).type, 'drop')
  assert.equal(guestEditorAction(noteC, 'change', { content: doc, revision: 1, documentId: 'n39', generation: 39 }, crowded).type, 'change')
})

test('a late change stays labeled with the note that was mounted, after the frame has moved on', () => {
  const frame = { documentId: 'note-a', generation: 0 }
  const docA = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'A' }] }] }
  const typed = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'A!' }] }] }
  const docB = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'B' }] }] }
  const sessionA = mountEditorSession({ documentId: frame.documentId, generation: frame.generation }, docA, 0)
  assert.equal(sessionA.pendingChange(docA), null)
  frame.documentId = 'note-b'
  frame.generation = 1
  const sessionB = mountEditorSession({ documentId: frame.documentId, generation: frame.generation }, docB, 0)
  const late = sessionA.pendingChange(typed)
  assert.ok(late)
  assert.equal(late.documentId, 'note-a')
  assert.equal(late.generation, 0)
  assert.equal(late.content, typed)
  assert.notEqual(late.documentId, frame.documentId)
  assert.equal(sessionA.pendingChange(typed), null)
  const accepted = guestEditorAction({ documentId: 'note-b', generation: 1 }, 'change', late, [{ documentId: 'note-a', generation: 0 }])
  assert.deepEqual(accepted, { type: 'change', content: typed, revision: late.revision, documentId: 'note-a' })
  assert.equal(sessionA.hostUpdate(docA, 0), typed)
  assert.equal(sessionB.hostUpdate(docB, 0), docB)
  assert.equal(sessionB.pendingChange(docB), null)
  const stored = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'B', marks: [{ type: 'link' as const, attrs: { href: 'https://example.com' } }] }] }] }
  const fromEditor = { type: 'doc' as const, content: [{ content: [{ marks: [{ attrs: { title: null, href: 'https://example.com', class: null, rel: null, target: null }, type: 'link' }], text: 'B', type: 'text' }], type: 'paragraph' }] }
  const linked = mountEditorSession({ documentId: 'note-b', generation: 1 }, stored, 0)
  assert.equal(linked.pendingChange(fromEditor), null)
  assert.equal(linked.pendingChange(docB)?.documentId, 'note-b')
  const selection = sessionA.selection('from A')
  assert.equal(selection.documentId, 'note-a')
  assert.equal(guestEditorAction({ documentId: 'note-b', generation: 1 }, 'selection', selection, [{ documentId: 'note-a', generation: 0 }]).type, 'drop')
})

test('a protocol mismatch drops the edit and is logged', () => {
  const calls: unknown[][] = []
  const original = console.debug
  console.debug = (...args: unknown[]) => { calls.push(args) }
  try {
    const dropped = guestEditorAction(initialEditorFrame('note-a'), 'change', { protocol: 99, content: doc, revision: 1, documentId: 'note-a', generation: 0 })
    assert.deepEqual(dropped, { type: 'drop', reason: 'protocol' })
    if (dropped.type === 'drop') reportDroppedEdit(dropped.reason, { protocol: 99, documentId: 'note-a', generation: 0 })
    assert.equal(calls.length, 1)
    assert.match(String(calls[0]?.[0]), /dropped a change/u)
  } finally { console.debug = original }
})

test('Retry asks for another load only after a failure, then a success clears the error', () => {
  let state = reduceEditorLoad(initialEditorLoad, { type: 'start' })
  assert.equal(editorLoadOffersRetry(state), false)
  state = reduceEditorLoad(state, { type: 'failed' })
  assert.equal(editorLoadOffersRetry(state), true)
  assert.equal(state.attempt, 0)
  const ignored = reduceEditorLoad(state, { type: 'retry' })
  assert.equal(ignored.attempt, 1)
  assert.equal(reduceEditorLoad(initialEditorLoad, { type: 'retry' }).attempt, 0)
  state = reduceEditorLoad(ignored, { type: 'start' })
  assert.equal(state.error, '')
  assert.equal(editorLoadOffersRetry(state), false)
  state = reduceEditorLoad(state, { type: 'loaded', source: 'blob:editor' })
  assert.equal(state.source, 'blob:editor')
  assert.equal(state.error, '')
  const missing = reduceEditorLoad(state, { type: 'missing-loader' })
  assert.equal(missing.error, 'unavailable')
  assert.equal(editorLoadOffersRetry(missing), false)
})
