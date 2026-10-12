import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceEditorFrame, guestEditorAction, initialEditorFrame } from '../src/hermes/editor-frame.js'
import { editorLoadOffersRetry, initialEditorLoad, reduceEditorLoad } from '../src/hermes/editor-load.js'

const doc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'From A' }] }] }

test('a late change after switching notes is dropped, including a return to the first note', () => {
  const noteA = initialEditorFrame('note-a')
  const changeA = { content: doc, revision: 4, documentId: 'note-a', generation: 0 }
  assert.deepEqual(guestEditorAction(noteA, 'change', changeA), { type: 'change', content: doc, revision: 4 })
  assert.deepEqual(guestEditorAction(noteA, 'selection', { text: 'From A', documentId: 'note-a', generation: 0 }), { type: 'selection', text: 'From A' })
  assert.deepEqual(guestEditorAction(noteA, 'selection', 'From A'), { type: 'drop' })
  const noteB = advanceEditorFrame(noteA, 'note-b')
  assert.deepEqual(noteB, { documentId: 'note-b', generation: 1 })
  assert.equal(advanceEditorFrame(noteB, 'note-b'), noteB)
  assert.deepEqual(guestEditorAction(noteB, 'change', changeA), { type: 'drop' })
  assert.deepEqual(guestEditorAction(noteB, 'selection', { text: 'From A', documentId: 'note-a', generation: 0 }), { type: 'drop' })
  assert.deepEqual(guestEditorAction(noteB, 'change', { content: doc, revision: 1, documentId: 'note-b', generation: 0 }), { type: 'drop' })
  const fresh = { content: doc, revision: 1, documentId: 'note-b', generation: 1 }
  assert.equal(guestEditorAction(noteB, 'change', fresh).type, 'change')
  const back = advanceEditorFrame(noteB, 'note-a')
  assert.equal(back.generation, 2)
  assert.deepEqual(guestEditorAction(back, 'change', changeA), { type: 'drop' })
  assert.equal(guestEditorAction(back, 'change', { ...changeA, generation: 2 }).type, 'change')
  assert.deepEqual(guestEditorAction(back, 'ready', null), { type: 'unhandled' })
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
