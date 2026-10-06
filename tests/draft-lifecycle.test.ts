import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { JotStore, StoreError } from '../src/store.js'
import { docFromText, validateRichDoc } from '../src/model.js'
import { draftFromNote } from '../src/client/drafts.js'
import { editHumanDraft, takeUntouchedFreshNote } from '../src/client/draft-lifecycle.js'

async function storeFor(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jot-draft-lifecycle-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return new JotStore({ directory })
}

test('a saved pin or folder edit prevents a blank new note from being permanently auto-purged', async t => {
  const store = await storeFor(t)
  const folder = await store.createFolder('User folder')
  for (const patch of [{ pinned: true }, { folderId: folder.id }]) {
    const note = await store.createNote({})
    const fresh = new Set([note.id])
    const edited = editHumanDraft(draftFromNote(note), patch, fresh)
    const saved = await store.updateNote(note.id, note.revision, patch)
    assert.equal(edited.dirty, true)
    if (takeUntouchedFreshNote(note.id, fresh, {
      note: saved, draft: draftFromNote(saved), saving: false, keptDrafts: false,
    })) await store.purgeNotes([{ id: saved.id, revision: saved.revision }])
    assert.deepEqual(await store.getNote(note.id), saved, 'leaving the note preserves the saved metadata and note')
  }
})

test('writing and then clearing a new note does not restore untouched cleanup eligibility', async t => {
  const store = await storeFor(t)
  const note = await store.createNote({})
  const fresh = new Set([note.id])
  const written = editHumanDraft(draftFromNote(note), { content: docFromText('Written by the user') }, fresh)
  const firstSave = await store.updateNote(note.id, note.revision, { content: validateRichDoc(written.content) })
  const cleared = editHumanDraft(draftFromNote(firstSave), { content: docFromText('') }, fresh)
  const saved = await store.updateNote(note.id, firstSave.revision, { content: validateRichDoc(cleared.content) })
  if (takeUntouchedFreshNote(note.id, fresh, {
    note: saved, draft: draftFromNote(saved), saving: false, keptDrafts: false,
  })) await store.purgeNotes([{ id: saved.id, revision: saved.revision }])
  assert.deepEqual(await store.getNote(note.id), saved)
})

test('leaving a genuinely untouched empty note still cleans it up exactly once', async t => {
  const store = await storeFor(t)
  const note = await store.createNote({})
  const fresh = new Set([note.id])
  const state = { note, draft: draftFromNote(note), saving: false, keptDrafts: false }
  assert.equal(takeUntouchedFreshNote(note.id, fresh, state), true)
  await store.purgeNotes([{ id: note.id, revision: note.revision }])
  assert.equal(takeUntouchedFreshNote(note.id, fresh, state), false)
  await assert.rejects(store.getNote(note.id), error => error instanceof StoreError && error.code === 'NOT_FOUND')
})
