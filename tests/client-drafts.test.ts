import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptSavedDraft, DraftStorage, draftFromNote, receiveLatestDraft, reconcileDraft, sameDraftGeneration } from '../src/client/drafts.js'
import type { DraftStorageBackend, NoteDraft } from '../src/client/drafts.js'
import type { Note } from '../src/client/types.js'

const note: Note = {
  id: 'note-1', title: 'Original', content: { type: 'doc', content: [{ type: 'paragraph' }] }, text: '',
  folderId: null, pinned: false, revision: 1, createdAt: '2026-10-02T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z', deletedAt: null,
}

describe('draft revision boundaries', () => {
  it('keeps unsaved content when an agent advances the remote revision', () => {
    const draft = { ...draftFromNote(note), title: 'Human draft', dirty: true }
    const result = reconcileDraft(draft, { ...note, title: 'Agent edit', revision: 2 })
    assert.equal(result.draft, draft)
    assert.equal(result.remoteChanged, true)
    assert.equal(result.draft.baseRevision, 1)
  })

  it('updates a clean editor from the authoritative remote version', () => {
    const result = reconcileDraft(draftFromNote(note), { ...note, title: 'Latest', revision: 2 })
    assert.equal(result.draft.title, 'Latest')
    assert.equal(result.draft.baseRevision, 2)
    assert.equal(result.remoteChanged, false)
  })

  it('does not swallow keystrokes typed while a save request is pending', () => {
    const submitted = { ...draftFromNote(note), title: 'First edit', dirty: true }
    const current = { ...submitted, title: 'Second edit' }
    const result = acceptSavedDraft(current, submitted, { ...note, title: 'First edit', revision: 2 })
    assert.equal(result.title, 'Second edit')
    assert.equal(result.dirty, true)
    assert.equal(result.baseRevision, 2)
  })

  it('marks only the exact submitted draft as saved', () => {
    const submitted = { ...draftFromNote(note), title: 'Saved edit', dirty: true }
    const result = acceptSavedDraft(submitted, submitted, { ...note, title: 'Saved edit', revision: 2 })
    assert.equal(result.dirty, false)
    assert.equal(result.baseRevision, 2)
  })
})

class FakeStorage implements DraftStorageBackend {
  private readonly items = new Map<string, string>()
  getItem(key: string) { return this.items.get(key) ?? null }
  setItem(key: string, value: string) { this.items.set(key, value) }
  removeItem(key: string) { this.items.delete(key) }
}

describe('recovery shared by two mounted editors', () => {
  it('keeps a wide dirty draft through compact clean polling and recovers past its stale clean map', () => {
    const backend = new FakeStorage()
    const wide = new DraftStorage(backend)
    const compact = new DraftStorage(backend)
    const compactMap = new Map<string, NoteDraft>([[note.id, draftFromNote(note)]])
    const wideDraft = wide.persist(wide.edit(draftFromNote(note), { title: 'Wide unsaved work' }))
    for (let poll = 0; poll < 5; poll++) compact.persist(draftFromNote(note))
    // The wide panel closes. The still-mounted compact panel selects again.
    const recovered = compact.read(note, compactMap.get(note.id))
    assert.equal(recovered.title, 'Wide unsaved work')
    assert.equal(recovered.draftId, wideDraft.draftId)
    assert.equal(recovered.baseRevision, 1)
    assert.equal(recovered.dirty, true)
  })

  it('preserves two independently edited dirty variants instead of last-write-wins storage', () => {
    const backend = new FakeStorage()
    const wide = new DraftStorage(backend)
    const compact = new DraftStorage(backend)
    wide.persist(wide.edit(draftFromNote(note), { title: 'Wide variant' }))
    compact.persist(compact.edit(draftFromNote(note), { title: 'Compact variant' }))
    assert.deepEqual(wide.all(note.id).map(item => item.title).sort(), ['Compact variant', 'Wide variant'])
  })

  it('forks two panels that edit a recovered draft from the same older view', () => {
    const backend = new FakeStorage()
    const wide = new DraftStorage(backend)
    const compact = new DraftStorage(backend)
    wide.persist(wide.edit(draftFromNote(note), { title: 'Recovered draft' }))
    const wideView = wide.read(note)
    const compactView = compact.read(note)
    wide.persist(wide.edit(wideView, { title: 'Wide latest' }))
    compact.persist(compact.edit(compactView, { title: 'Compact independent edit' }))
    assert.deepEqual(wide.all(note.id).map(item => item.title).sort(), ['Compact independent edit', 'Wide latest'])
  })

  it('an asynchronous earlier save cannot delete either new typing or a sibling conflict draft', async () => {
    const backend = new FakeStorage()
    const wide = new DraftStorage(backend)
    const compact = new DraftStorage(backend)
    const submitted = wide.persist(wide.edit(draftFromNote(note), { title: 'Sent to save' }))
    let resolveSave!: (value: Note) => void
    const pending = new Promise<Note>(resolve => { resolveSave = resolve })
    const current = wide.persist(wide.edit(submitted, { title: 'Typed during save' }))
    compact.persist(compact.edit(draftFromNote(note), { title: 'Other panel conflict' }))
    compact.persist(draftFromNote(note))
    resolveSave({ ...note, title: 'Sent to save', revision: 2 })
    const result = wide.saved(current, submitted, await pending)
    assert.equal(result.title, 'Typed during save')
    assert.equal(result.baseRevision, 2)
    assert.equal(result.dirty, true)
    assert.deepEqual(compact.all(note.id).map(item => item.title).sort(), ['Other panel conflict', 'Typed during save'])
  })

  it('an acknowledged exact save clears only its matching draft, leaving the other panel recovery intact', () => {
    const backend = new FakeStorage()
    const wide = new DraftStorage(backend)
    const compact = new DraftStorage(backend)
    const submitted = wide.persist(wide.edit(draftFromNote(note), { title: 'Saved wide work' }))
    compact.persist(compact.edit(draftFromNote(note), { title: 'Unsaved compact work' }))
    assert.equal(wide.saved(submitted, submitted, { ...note, title: submitted.title, revision: 2 }).dirty, false)
    assert.deepEqual(wide.all(note.id).map(item => item.title), ['Unsaved compact work'])
  })

  it('a pending load-latest response preserves typing made after the click', async () => {
    const storage = new DraftStorage(new FakeStorage())
    const requested = storage.persist(storage.edit(draftFromNote(note), { title: 'Clicked recovery draft' }))
    let resolveGet!: (value: Note) => void
    const pendingGet = new Promise<Note>(resolve => { resolveGet = resolve })
    const current = storage.persist(storage.edit(requested, { title: 'Typed while loading' }))
    resolveGet({ ...note, title: 'Latest remote version', revision: 2 })
    // This is the same completion helper used by App after its GET resolves.
    const result = receiveLatestDraft(requested, current, await pendingGet, storage)
    assert.equal(result.replaced, false)
    assert.equal(result.draft, current)
    assert.equal(storage.read(note).title, 'Typed while loading')
    assert.equal(storage.read(note).editVersion, current.editVersion)
  })

  it('a pending load-latest response cannot clear or switch away from note B', async () => {
    const storage = new DraftStorage(new FakeStorage())
    const requestedA = storage.persist(storage.edit(draftFromNote(note), { title: 'A draft' }))
    let resolveGet!: (value: Note) => void
    const pendingGet = new Promise<Note>(resolve => { resolveGet = resolve })
    const noteB = { ...note, id: 'note-2', title: 'B' }
    const currentB = storage.persist(storage.edit(draftFromNote(noteB), { title: 'B unsaved work' }))
    resolveGet({ ...note, title: 'A latest', revision: 2 })
    const result = receiveLatestDraft(requestedA, currentB, await pendingGet, storage)
    assert.equal(result.replaced, false)
    assert.equal(result.draft, currentB)
    assert.equal(storage.read(noteB).title, 'B unsaved work')
    assert.equal(storage.all(note.id).length, 0)
  })

  it('a pending save for variant A cannot advance variant B and bypass its conflict', async () => {
    const storage = new DraftStorage(new FakeStorage())
    const submittedA = storage.persist(storage.edit(draftFromNote(note), { title: 'A version being saved' }))
    let resolveSave!: (value: Note) => void
    const pendingSave = new Promise<Note>(resolve => { resolveSave = resolve })
    // The selector switches this note's editor to an independent recovery branch.
    const selectedB = storage.persist(storage.edit(draftFromNote(note), { title: 'B independent recovery' }))
    resolveSave({ ...note, title: submittedA.title, revision: 2 })
    const server = await pendingSave
    const result = storage.saved(selectedB, submittedA, server)
    assert.equal(result.draftId, selectedB.draftId)
    assert.equal(result.baseRevision, 1)
    assert.equal(result.title, selectedB.title)
    assert.equal(result.dirty, true)
    assert.equal(reconcileDraft(result, server).remoteChanged, true)
    // A subsequent save still carries the old revision and must fail CAS.
    assert.notEqual(result.baseRevision, server.revision)
    assert.deepEqual(storage.all(note.id).map(item => item.title), ['B independent recovery'])
  })

  it('a delete completion clears only the unchanged captured editor generation', async () => {
    const requested = draftFromNote(note)
    let resolveDelete!: () => void
    const pendingDelete = new Promise<void>(resolve => { resolveDelete = resolve })
    let current: NoteDraft | null = { ...draftFromNote({ ...note, id: 'note-2' }), title: 'B still editing', dirty: true }
    resolveDelete()
    await pendingDelete
    // App uses this exact guard before changing the selected editor/list view.
    if (sameDraftGeneration(current, requested)) current = null
    assert.equal(current?.noteId, 'note-2')
    assert.equal(current?.title, 'B still editing')
  })
})
