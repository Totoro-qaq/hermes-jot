import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { docFromText, docToText, validateRichDoc, type RichDoc } from '../src/model.js'
import { JotStore, StoreError, STATE_FILENAME, BACKUP_FILENAME, LOCK_FILENAME } from '../src/store.js'

async function fixture(t: TestContext): Promise<{ directory: string; store: JotStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jot-store-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return { directory, store: new JotStore({ directory }) }
}
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof StoreError && error.code === expected
}

const markedDoc: RichDoc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Confirmed requirements', marks: [{ type: 'bold' }] }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Keep the existing sidebar.', marks: [{ type: 'italic' }] }] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Review handoff' }] },
  ] }] },
  { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const ok = true' }] },
] }

test('starts blank and persists documents, folders, pins, and agent preference across restart', async t => {
  const { directory, store } = await fixture(t)
  assert.deepEqual(await store.readState(), { version: 1, notes: [], folders: [], agentEnabled: false })
  const folder = await store.createFolder('Work')
  const note = await store.createNote({ title: 'Plan', content: markedDoc, folderId: folder.id, pinned: true })
  await store.setAgentEnabled(true)
  const restarted = new JotStore({ directory })
  assert.deepEqual(await restarted.getNote(note.id), note)
  const state = await restarted.readState()
  assert.equal(state.agentEnabled, true)
  assert.equal(state.folders[0]?.name, 'Work')
  assert.equal(state.notes[0]?.pinned, true)
  assert.equal(note.text, 'Confirmed requirements\nKeep the existing sidebar.\n[ ] Review handoff\nconst ok = true')
  assert.deepEqual(note.content, markedDoc)
})

test('folder deletion preserves active and deleted notes and invalidates their previous revisions', async t => {
  const { store } = await fixture(t)
  const folder = await store.createFolder('Work')
  assert.equal((await store.renameFolder(folder.id, 'Project')).name, 'Project')
  const active = await store.createNote({ title: 'Active', folderId: folder.id })
  const trash = await store.createNote({ title: 'Trash', content: docFromText('Keep me'), folderId: folder.id })
  const deleted = await store.deleteNote(trash.id, trash.revision)
  await store.deleteFolder(folder.id)
  assert.deepEqual((await store.readState()).folders, [])
  assert.equal((await store.getNote(active.id)).folderId, null)
  assert.equal((await store.getNote(trash.id)).text, 'Keep me')
  assert.equal((await store.getNote(trash.id)).folderId, null)
  await assert.rejects(store.updateNote(active.id, active.revision, { title: 'Stale' }), code('REVISION_CONFLICT'))
  await assert.rejects(store.restoreNote(trash.id, deleted.revision), code('REVISION_CONFLICT'))
  const latest = await store.getNote(trash.id)
  const restored = await store.restoreNote(trash.id, latest.revision)
  assert.equal(restored.text, 'Keep me')
  assert.equal(restored.deletedAt, null)
})

test('title matches outrank newer pinned body matches; empty queries use pin and recent update order', async t => {
  const { store } = await fixture(t)
  const title = await store.createNote({ title: 'RIVER roadmap', content: docFromText('Accepted design') })
  const body = await store.createNote({ title: 'Meeting', content: docFromText('Discuss river'), pinned: true })
  assert.deepEqual((await store.search('river')).map(note => note.id), [title.id, body.id])
  assert.equal((await store.search(''))[0]?.id, body.id)
  const folder = await store.createFolder('One')
  const moved = await store.updateNote(title.id, title.revision, { folderId: folder.id })
  assert.deepEqual((await store.search('', folder.id)).map(note => note.id), [title.id])
  assert.deepEqual((await store.search('', null)).map(note => note.id), [body.id])
  await store.deleteNote(moved.id, moved.revision)
  assert.deepEqual((await store.search('river')).map(note => note.id), [body.id])
})

test('CAS protects human and agent edits across different store instances', async t => {
  const { directory, store } = await fixture(t)
  await store.setAgentEnabled(true)
  const original = await store.createNote({ content: docFromText('Original') })
  const second = new JotStore({ directory })
  const outcomes = await Promise.allSettled([
    store.updateNote(original.id, original.revision, { appendText: 'Human' }, 'user'),
    second.updateNote(original.id, original.revision, { appendText: 'Agent' }, 'agent'),
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  assert.ok(rejected?.status === 'rejected' && code('REVISION_CONFLICT')(rejected.reason))
  const latest = await second.getNote(original.id)
  assert.equal(latest.revision, 2)
  assert.ok(latest.text === 'Original\nHuman' || latest.text === 'Original\nAgent')
})

test('concurrent independent creates never overwrite each other', async t => {
  const { directory, store } = await fixture(t)
  const second = new JotStore({ directory })
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 === 0 ? store : second).createNote({ title: `Note ${index}` })))
  const restarted = new JotStore({ directory })
  const state = await restarted.readState()
  assert.equal(state.notes.length, 12)
  assert.deepEqual(new Set(state.notes.map(note => note.id)), new Set(created.map(note => note.id)))
})

test('lockfile also protects concurrent writers in separate Node processes', async t => {
  const { directory, store } = await fixture(t)
  const run = promisify(execFile)
  const script = `const { JotStore } = await import(process.argv[1]);
    await new JotStore({ directory: process.argv[2] }).createNote({ title: process.argv[3] });`
  const moduleUrl = new URL('../src/store.ts', import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, (_, index) => run(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', script, moduleUrl, directory, `Process ${index}`,
  ], { timeout: 15_000 })))
  const state = await store.readState()
  assert.deepEqual(state.notes.map(note => note.title).sort(), ['Process 0', 'Process 1', 'Process 2', 'Process 3'])
})

test('every agent read and mutation is gated by the latest persisted preference', async t => {
  const { directory, store } = await fixture(t)
  const other = new JotStore({ directory })
  const note = await store.createNote({ title: 'Private', content: docFromText('Secret') })
  const folder = await store.createFolder('Private')
  const operations = [
    () => store.readState('agent'), () => store.search('', undefined, 'agent'),
    () => store.getNote(note.id, 'agent'), () => store.createNote({ title: 'Agent' }, 'agent'),
    () => store.updateNote(note.id, note.revision, { appendText: 'Agent' }, 'agent'),
    () => store.deleteNote(note.id, note.revision, 'agent'), () => store.restoreNote(note.id, note.revision, 'agent'),
    () => store.createFolder('Agent', 'agent'), () => store.renameFolder(folder.id, 'Agent', 'agent'),
    () => store.deleteFolder(folder.id, 'agent'),
  ]
  for (const operation of operations) await assert.rejects(operation(), code('AGENT_DISABLED'))
  await assert.rejects(store.setAgentEnabled(true, 'agent'), code('HUMAN_ONLY'))
  await other.setAgentEnabled(true)
  assert.equal((await store.getNote(note.id, 'agent')).text, 'Secret')
  await other.setAgentEnabled(false)
  for (const operation of operations) await assert.rejects(operation(), code('AGENT_DISABLED'))
  assert.equal((await store.getNote(note.id)).revision, note.revision)
})

test('agent append preserves rich formatting and soft deletion keeps content private until restore', async t => {
  const { store } = await fixture(t)
  await store.setAgentEnabled(true)
  const original = await store.createNote({ title: 'Confirmed', content: markedDoc })
  const updated = await store.updateNote(original.id, original.revision, { appendText: 'Next decision\nNext step' }, 'agent')
  assert.deepEqual(updated.content.content.slice(0, original.content.content.length), original.content.content)
  assert.ok(updated.text.endsWith('\nNext decision\nNext step'))
  const deleted = await store.deleteNote(updated.id, updated.revision, 'agent')
  assert.ok(!('content' in deleted) && !('text' in deleted))
  assert.equal((await store.readState('agent')).notes.length, 0)
  await assert.rejects(store.getNote(updated.id, 'agent'), code('NOT_FOUND'))
  assert.equal((await store.getNote(updated.id)).text, updated.text)
  const restored = await store.restoreNote(updated.id, deleted.revision)
  assert.equal((await store.getNote(updated.id, 'agent')).text, restored.text)
})

test('failed backup replacement leaves disk and all store views unchanged; next retry succeeds', async t => {
  const { directory, store } = await fixture(t)
  const original = await store.createNote({ title: 'Before', content: docFromText('Keep') })
  const beforeBytes = await readFile(join(directory, STATE_FILENAME), 'utf8')
  // A real filesystem failure at the backup rename, after the new main temp file was written.
  await mkdir(join(directory, BACKUP_FILENAME))
  await assert.rejects(store.updateNote(original.id, original.revision, { title: 'Should not commit' }), code('PERSISTENCE_ERROR'))
  assert.equal(await readFile(join(directory, STATE_FILENAME), 'utf8'), beforeBytes)
  assert.deepEqual(await store.getNote(original.id), original)
  assert.deepEqual(await new JotStore({ directory }).getNote(original.id), original)
  assert.ok((await readdir(directory)).every(name => name === STATE_FILENAME || name === BACKUP_FILENAME))
  await rm(join(directory, BACKUP_FILENAME), { recursive: true })
  const updated = await store.updateNote(original.id, original.revision, { title: 'After' })
  assert.equal(updated.revision, 2)
  assert.equal(await readFile(join(directory, BACKUP_FILENAME), 'utf8'), beforeBytes)
})

test('corrupt or incompatible state is refused and never silently replaced with an empty database', async t => {
  const { directory, store } = await fixture(t)
  const note = await store.createNote({ content: docFromText('Important') })
  await store.updateNote(note.id, note.revision, { title: 'Important' })
  const backup = await readFile(join(directory, BACKUP_FILENAME), 'utf8')
  await writeFile(join(directory, STATE_FILENAME), '{invalid-json', 'utf8')
  await assert.rejects(store.readState(), code('CORRUPT_STATE'))
  await assert.rejects(store.createNote({ title: 'No overwrite' }), code('CORRUPT_STATE'))
  assert.equal(await readFile(join(directory, STATE_FILENAME), 'utf8'), '{invalid-json')
  assert.equal(await readFile(join(directory, BACKUP_FILENAME), 'utf8'), backup)
  await rm(join(directory, STATE_FILENAME))
  await assert.rejects(store.readState(), code('CORRUPT_STATE'))
  await writeFile(join(directory, STATE_FILENAME), JSON.stringify({ version: 2, notes: [], folders: [], agentEnabled: false }))
  await assert.rejects(store.readState(), code('CORRUPT_STATE'))
})

test('document boundaries reject HTML nodes, unsafe links, malformed nesting, and unknown fields', async t => {
  const { store } = await fixture(t)
  assert.equal(docToText(docFromText('one\r\n\r\ntwo')), 'one\n\ntwo')
  const badDocuments = [
    { type: 'doc', content: [{ type: 'html', text: '<script>bad()</script>' }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] },
    { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: 'yes' }, content: [{ type: 'paragraph' }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    { type: 'doc', html: '<p>x</p>', content: [{ type: 'paragraph' }] },
  ]
  for (const content of badDocuments) {
    assert.throws(() => validateRichDoc(content), code('INVALID_INPUT'))
    await assert.rejects(store.createNote({ content: content as RichDoc }), code('INVALID_INPUT'))
  }
  const note = await store.createNote({})
  await assert.rejects(store.updateNote(note.id, note.revision, { text: 'Bypass' } as never), code('INVALID_INPUT'))
  assert.equal((await store.getNote(note.id)).revision, 1)
})

test('a leftover lock is reported explicitly and leaves storage untouched', async t => {
  const { directory } = await fixture(t)
  await writeFile(join(directory, LOCK_FILENAME), JSON.stringify({ pid: -1, createdAt: 'old' }))
  const store = new JotStore({ directory, lockTimeoutMs: 30 })
  await assert.rejects(store.readState(), code('LOCK_TIMEOUT'))
  assert.deepEqual(await readdir(directory), [LOCK_FILENAME])
})
