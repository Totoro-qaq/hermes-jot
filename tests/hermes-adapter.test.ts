import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHermesApi } from '../src/hermes/api.js'
import { createPersistence } from '../src/hermes/persistence.js'
import { createControllers } from '../src/hermes/controllers.js'
import { EditorSync } from '../src/hermes/editor-sync.js'
import { draftFromNote } from '../src/client/drafts.js'
import { docFromText } from '../src/model.js'
import type { PluginContext } from '@hermes/plugin-sdk'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const save = () => async () => {}

test('a delayed older snapshot cannot overwrite the newer poll or its ETag', async () => {
  const a = deferred<unknown>(), b = deferred<unknown>()
  const requests: any[] = []
  const ctx = { rest: (_: string, options: unknown) => { requests.push(options); return requests.length === 1 ? a.promise : requests.length === 2 ? b.promise : Promise.resolve({ status: 304 }) } } as unknown as PluginContext
  const api = createHermesApi(ctx, () => true, save)
  const old = api.getState(), fresh = api.getState()
  const state = { version: 1, notes: [], folders: [], agentEnabled: true }
  b.resolve({ status: 200, headers: { etag: 'new' }, data: state })
  assert.equal(await fresh, state)
  a.resolve({ status: 200, headers: { etag: 'old' }, data: { ...state, agentEnabled: false } })
  assert.equal(await old, state)
  assert.equal(await api.getState(), state)
  assert.equal(requests[2].body.etag, 'new')
})

test('profile changes while reading an upload cannot send bytes to the new profile', async () => {
  const bytes = deferred<ArrayBuffer>()
  let owner = true, calls = 0
  const api = createHermesApi({ rest: async () => { calls++; return {} } } as unknown as PluginContext, () => owner, save)
  const upload = api.uploadAttachment({ name: 'private.txt', type: 'text/plain', arrayBuffer: () => bytes.promise } as File)
  owner = false
  bytes.resolve(new ArrayBuffer(1))
  await assert.rejects(upload, /profile changed/)
  assert.equal(calls, 0)
})

test('export download retains the initiating profile even if selection changes while it runs', async () => {
  const response = deferred<unknown>()
  let owner = true
  const captures: boolean[] = [], files: string[] = []
  const api = createHermesApi({ rest: () => response.promise } as unknown as PluginContext, () => owner, () => {
    captures.push(owner)
    return async path => { files.push(path) }
  })
  const exported = api.exportNote({ title: 'A', content: docFromText('Original profile') }, 'txt')
  owner = false
  response.resolve({ status: 200, file: { path: '/profile-a/downloads/note.txt', filename: 'note.txt' } })
  await (await exported).save!()
  assert.deepEqual(captures, [true])
  assert.deepEqual(files, ['/profile-a/downloads/note.txt'])
})

test('cloned note ids do not share draft recovery or last-note preferences across profiles', () => {
  const values = new Map<string, string>()
  const backing = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const a = createPersistence('["local","A"]', backing), b = createPersistence('["local","B"]', backing)
  const note = { id: 'same-id', title: 'Original', content: docFromText('Text'), text: 'Text', revision: 1, folderId: null, pinned: false, createdAt: '', updatedAt: '', deletedAt: null }
  a.drafts.persist(a.drafts.edit(draftFromNote(note), { title: 'Private A draft' }))
  a.preferences.set('last-note', note.id)
  assert.equal(b.drafts.all(note.id).length, 0)
  assert.equal(b.preferences.get('last-note'), null)
  assert.equal(createPersistence('["local","A"]', backing).drafts.all(note.id)[0].title, 'Private A draft')
})

test('queued capture and expand requests cannot cross a profile switch or replay when returning', () => {
  const controls = createControllers(() => {})
  const a = controls.forOwner('A')
  a.select('frame-a', 'Private editor selection A')
  a.bus.send({ action: 'capture', target: 'compact', text: 'Private selection A', recipient: a.recipient })
  a.handoff.open('cloned-note-id', 'private-draft-a', 1)
  controls.retainOwner('B')
  const b = controls.forOwner('B')
  assert.equal(b.bus.getSnapshot(), undefined)
  assert.equal(b.handoff.getSnapshot().noteId, null)
  assert.equal(a.recipient.signal.aborted, true)
  assert.equal(a.selectedText, '')
  assert.equal(a.bus.claim(1, 'compact', a.recipient), false)
  const returned = controls.forOwner('A')
  assert.equal(returned.bus.getSnapshot(), undefined)
  assert.equal(returned.handoff.getSnapshot().noteId, null)
  assert.equal(returned.selectedText, '')
  controls.dispose()
})

test('a delayed host echo or theme update cannot erase keystrokes already typed in the editor', () => {
  const sync = new EditorSync()
  const initial = docFromText('Start'), first = docFromText('Start A'), second = docFromText('Start AB')
  sync.prepareHostUpdate(initial, 0)()
  const sentFirst = sync.edited(first)
  const sentSecond = sync.edited(second)
  assert.equal(sync.prepareHostUpdate(initial, 0)(), second)
  assert.equal(sync.prepareHostUpdate(first, sentFirst.revision)(), second)
  assert.equal(sync.prepareHostUpdate(second, sentSecond.revision)(), second)
  const humanUndo = docFromText('Undo applied by user')
  assert.equal(sync.prepareHostUpdate(humanUndo, sentSecond.revision)(), humanUndo)
  assert.equal(sync.edited(second).revision, sentSecond.revision + 1)
})

test('closing one editor cannot erase the other editor selection, and new focus clears an old range', () => {
  const controls = createControllers(() => {})
  const state = controls.forOwner('A')
  state.select('compact', 'Selected in the side panel')
  state.select('wide', 'Selected in the workspace')
  state.select('compact', null)
  assert.equal(state.selectedText, 'Selected in the workspace')
  state.select('compact', '')
  assert.equal(state.selectedText, '')
  controls.dispose()
})


test('a host echo queued before typing is checked when React applies it, not when it arrives', () => {
  const sync = new EditorSync()
  const initial = docFromText('Start'), first = docFromText('Start A'), second = docFromText('Start AB')
  sync.prepareHostUpdate(initial, 0)()
  const sent = sync.edited(first)
  const pendingReactEffect = sync.prepareHostUpdate(first, sent.revision)
  sync.edited(second)
  assert.equal(pendingReactEffect(), second)
  assert.equal(pendingReactEffect(), second, 'replayed effects must also retain newer input')
})

test('importing uploads to the import route with the folder and a long timeout', async () => {
  const calls: Array<{ path: string; options: any }> = []
  const imported = { notes: 2, attachments: 0, folders: 0, noteIds: ['a', 'b'], skipped: [] }
  const api = createHermesApi({ rest: async (path: string, options: unknown) => { calls.push({ path, options }); return { status: 200, data: imported } } } as unknown as PluginContext, () => true, save)
  const bytes = new TextEncoder().encode('# Hello').buffer
  const file = { name: 'Notes & ideas.md', type: 'text/markdown', arrayBuffer: async () => bytes } as File
  assert.equal(await api.importNotes!(file, { folderId: 'f/1 2' }), imported)
  await api.importNotes!(file, { folderId: null })
  assert.equal(calls[0].path, '/import?folderId=f%2F1%202')
  assert.equal(calls[1].path, '/import?folderId=')
  assert.deepEqual(calls[0].options, { method: 'POST', upload: { filename: 'Notes & ideas.md', contentType: 'text/markdown', bytes }, timeoutMs: 300_000 })
})

test('an import error is raised, and a profile change while reading the file sends nothing', async () => {
  const api = createHermesApi({ rest: async () => ({ status: 413, error: { code: 'REQUEST_TOO_LARGE', message: 'Too large' } }) } as unknown as PluginContext, () => true, save)
  await assert.rejects(api.importNotes!({ name: 'a.zip', type: '', arrayBuffer: async () => new ArrayBuffer(1) } as File, { folderId: null }),
    (error: any) => error.status === 413 && error.code === 'REQUEST_TOO_LARGE')
  const bytes = deferred<ArrayBuffer>()
  let owner = true, calls = 0
  const other = createHermesApi({ rest: async () => { calls++; return {} } } as unknown as PluginContext, () => owner, save)
  const pending = other.importNotes!({ name: 'a.md', type: '', arrayBuffer: () => bytes.promise } as File, { folderId: null })
  owner = false
  bytes.resolve(new ArrayBuffer(1))
  await assert.rejects(pending, /profile changed/)
  assert.equal(calls, 0)
})

test('a state read that started before an import is retried rather than returned stale', async () => {
  const stale = deferred<unknown>()
  const state = (notes: number) => ({ version: 1, notes: Array.from({ length: notes }, () => ({})), folders: [], agentEnabled: false })
  let reads = 0
  const ctx = { rest: (path: string) => {
    if (path.startsWith('/import')) return Promise.resolve({ status: 200, data: { notes: 1, attachments: 0, folders: 0, noteIds: ['x'], skipped: [] } })
    reads++
    return reads === 1 ? stale.promise : Promise.resolve({ status: 200, headers: { etag: 'after' }, data: state(1) })
  } } as unknown as PluginContext
  const api = createHermesApi(ctx, () => true, save)
  const reading = api.getState()
  await api.importNotes!({ name: 'a.md', type: '', arrayBuffer: async () => new ArrayBuffer(1) } as File, { folderId: null })
  stale.resolve({ status: 200, headers: { etag: 'before' }, data: state(0) })
  assert.equal((await reading).notes.length, 1)
  assert.equal(reads, 2)
})
