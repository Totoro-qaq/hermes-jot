import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { JotStore, StoreError } from '../src/store.js'
import { docFromText, validateRichDoc } from '../src/model.js'
import { draftFromNote } from '../src/client/drafts.js'
import { editHumanDraft, parkedDraftForLateEdit, parkedEditorChange, planFreshNoteRelease, takeUntouchedFreshNote } from '../src/client/draft-lifecycle.js'

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

test('a late edit to a conflicted draft is kept in the draft and is not treated as a clean save', () => {
  const parked = draftFromNote({ id: 'note-a', title: 'A', content: docFromText('Before'), text: 'Before', folderId: null, pinned: false, revision: 3, createdAt: '', updatedAt: '', deletedAt: null })
  assert.equal(parkedEditorChange(parked, docFromText('Before'), true), 'unchanged')
  assert.equal(parkedEditorChange(parked, docFromText('After'), true), 'keep-conflict')
  assert.equal(parkedEditorChange(parked, docFromText('After'), false), 'save')
  assert.equal(parkedEditorChange(undefined, docFromText('After'), true), 'unchanged')
  const stored = docFromText('Before')
  stored.content[0]!.content![0]!.marks = [{ type: 'link', attrs: { href: 'https://example.com' } }]
  const fromEditor = structuredClone(stored)
  fromEditor.content[0]!.content![0]!.marks = [{ type: 'link', attrs: { href: 'https://example.com', target: null, rel: null, class: null, title: null } }]
  assert.equal(parkedEditorChange({ ...parked, content: stored }, fromEditor, false), 'unchanged')
  const withDefaults = structuredClone(stored)
  withDefaults.content[0]!.content![0]!.marks = [
    { type: 'italic' },
    { type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow' } },
  ]
  const reordered = structuredClone(stored)
  reordered.content[0]!.content![0]!.marks = [
    { type: 'link', attrs: { href: 'https://example.com' } },
    { type: 'italic' },
  ]
  assert.equal(parkedEditorChange({ ...parked, content: reordered }, withDefaults, false), 'unchanged')
})

test('a new note is not purged until its editor flush settles, and a late edit puts the text back', () => {
  const fresh = new Set(['note-a'])
  assert.equal(planFreshNoteRelease('note-a', fresh, true), 'wait')
  assert.equal(fresh.has('note-a'), true)
  const note = { id: 'note-a', title: '', content: docFromText(''), text: '', folderId: null, pinned: false, revision: 1, createdAt: '', updatedAt: '', deletedAt: null }
  const revived = parkedDraftForLateEdit(undefined, note, true)
  assert.ok(revived)
  const edited = editHumanDraft(revived!, { content: docFromText('typed before the switch') }, fresh)
  assert.equal(edited.content.content?.[0]?.content?.[0]?.text, 'typed before the switch')
  assert.equal(fresh.has('note-a'), false)
  assert.equal(takeUntouchedFreshNote(note.id, fresh, { note, draft: edited, saving: false, keptDrafts: false }), false)
  assert.equal(planFreshNoteRelease('note-a', fresh, true), 'ready')
  assert.equal(parkedDraftForLateEdit(undefined, note, false), undefined)
  const untouched = new Set(['note-b'])
  assert.equal(planFreshNoteRelease('note-b', untouched, false), 'ready')
  assert.equal(takeUntouchedFreshNote('note-b', untouched, { note: { ...note, id: 'note-b' }, draft: draftFromNote({ ...note, id: 'note-b' }), saving: false, keptDrafts: false }), true)
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
