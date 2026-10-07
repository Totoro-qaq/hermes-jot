import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { AttachmentStore } from '../src/attachments.js'
import { importNotesFile } from '../src/markdown-import.js'
import { docFromText, docToText, validateRichDoc, validatedDocText, type RichDoc } from '../src/model.js'
import { BACKUP_FILENAME, JotStore, MAX_NOTES, STATE_FILENAME, StoreError } from '../src/store.js'
import { runWorker } from '../src/worker-request.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwS8AAAAASUVORK5CYII=', 'base64')
const code = (expected: string) => (error: unknown) => error instanceof StoreError && error.code === expected

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'jot-store-import-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
const manifestIds = async (path: string): Promise<string[]> => {
  try { return JSON.parse(await readFile(join(path, 'attachments', 'manifest.json'), 'utf8')).attachments.map((item: { id: string }) => item.id) }
  catch { return [] }
}

test('importNotes creates folders and every note in one locked write', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const existing = await store.createFolder('Work')
  await store.createNote({ title: 'before', content: docFromText('kept') })
  const before = await readFile(join(path, STATE_FILENAME), 'utf8')
  const verified: RichDoc[] = []
  const result = await store.importNotes({ folders: ['work', ' 新建 ', '新建'], notes: [
    { title: 'first', content: docFromText('one'), folderName: 'WORK', folderId: null },
    { title: 'second', content: docFromText('two'), folderName: '新建', folderId: null },
    { title: 'third', content: docFromText('three'), folderName: null, folderId: existing.id },
    { title: 'fourth', content: docFromText('four'), folderName: null, folderId: null },
  ] }, async content => { verified.push(content) })
  assert.equal(result.noteIds.length, 4)
  assert.equal(result.folders, 1, 'Work is reused case-insensitively and 新建 is created once')
  assert.equal(verified.length, 4)
  assert.equal(await readFile(join(path, BACKUP_FILENAME), 'utf8'), before, 'the backup is the state before the import: one write')
  const state = await store.readState()
  const created = state.folders.find(folder => folder.name === '新建')!
  const note = (title: string) => state.notes.find(item => item.title === title)!
  assert.deepEqual(['first', 'second', 'third', 'fourth'].map(title => note(title).folderId), [existing.id, created.id, existing.id, null])
  assert.deepEqual(['first', 'second', 'third', 'fourth'].map(title => note(title).id), result.noteIds)
  for (const title of ['first', 'second', 'third', 'fourth']) {
    assert.equal(note(title).revision, 1)
    assert.equal(note(title).text, docToText(note(title).content))
  }
  assert.deepEqual(state.notes.filter(item => item.title !== 'before').map(item => item.title), ['first', 'second', 'third', 'fourth'],
    'imported notes list in import order')
})

test('importNotes validates everything before writing anything', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  await store.createNote({ title: 'existing', content: docFromText('x') })
  const before = await store.readState()
  const valid = { title: 'ok', content: docFromText('ok'), folderName: null, folderId: null }
  const cases: Array<[unknown, string]> = [
    [{ folders: [], notes: [valid, { ...valid, content: { type: 'doc', content: [{ type: 'script' }] } }] }, 'INVALID_INPUT'],
    [{ folders: [], notes: [valid, { ...valid, folderName: 'missing' }] }, 'INVALID_INPUT'],
    [{ folders: [], notes: [{ ...valid, folderId: 'no-such-folder' }] }, 'NOT_FOUND'],
    [{ folders: ['A'], notes: [{ ...valid, folderName: 'A', folderId: 'x' }] }, 'INVALID_INPUT'],
    [{ folders: ['  '], notes: [valid] }, 'INVALID_INPUT'],
    [{ folders: [], notes: [] }, 'INVALID_INPUT'],
    [{ folders: [], notes: [{ ...valid, title: 'x'.repeat(241) }] }, 'INVALID_INPUT'],
    [{ folders: [], notes: [{ ...valid, pinned: true }] }, 'INVALID_INPUT'],
  ]
  for (const [input, expected] of cases) {
    await assert.rejects(store.importNotes(input as Parameters<JotStore['importNotes']>[0]), code(expected), JSON.stringify(input).slice(0, 120))
  }
  await assert.rejects(store.importNotes({ folders: ['new'], notes: [{ ...valid, folderName: 'new' }] }, async () => { throw new StoreError('INVALID_INPUT', 'verifier refused') }),
    /verifier refused/u)
  assert.deepEqual(await store.readState(), before, 'no folder or note from a failed import is saved')
})

/** A saved library of `count` notes, written directly so the limit tests stay fast. */
async function libraryWith(path: string, count: number) {
  const content = validateRichDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'n' }] }] })
  const now = new Date().toISOString()
  const notes = Array.from({ length: count }, (_, index) => ({ id: `n${index}`, title: '', content, text: 'n', folderId: null, pinned: false,
    revision: 1, createdAt: now, updatedAt: now, deletedAt: index % 2 ? now : null }))
  await writeFile(join(path, STATE_FILENAME), JSON.stringify({ version: 1, notes, folders: [], agentEnabled: false }))
}

test('the 10,000-note limit counts Trash and refuses the whole import', async t => {
  const path = await directory(t)
  await libraryWith(path, MAX_NOTES - 1)
  const store = new JotStore({ directory: path })
  const note = { title: 'x', content: docFromText('x'), folderName: null, folderId: null }
  await assert.rejects(store.importNotes({ folders: [], notes: [note, note] }), (error: unknown) => code('INVALID_INPUT')(error) && /10,000 notes/u.test((error as Error).message))
  assert.equal((await store.readState()).notes.length, MAX_NOTES - 1)
  assert.equal((await store.importNotes({ folders: [], notes: [note] })).noteIds.length, 1, 'an import that fits is accepted')
})

test('a failed import removes only the attachments it uploaded', async t => {
  const path = await directory(t)
  await libraryWith(path, MAX_NOTES - 1)
  const store = new JotStore({ directory: path })
  const attachments = new AttachmentStore({ directory: path })
  const kept = await attachments.upload({ name: 'kept.png', bytes: png })
  const zip = zipSync({ 'a.md': strToU8('![a](a.png)'), 'b.md': strToU8('[file](b.bin)'), 'a.png': png, 'b.bin': strToU8('binary') })
  await assert.rejects(importNotesFile(store, attachments, { bytes: zip, filename: 'x.zip', extension: 'zip', folderId: null }), code('INVALID_INPUT'))
  assert.deepEqual(await manifestIds(path), [kept.id], 'the uploads are rolled back and the earlier attachment stays')
  assert.deepEqual((await attachments.content(kept.id)).bytes, png)
})

test('attachment quota failures roll back the earlier uploads of the same import', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const attachments = new AttachmentStore({ directory: path, maxAttachments: 2 })
  const kept = await attachments.upload({ name: 'kept.png', bytes: png })
  const zip = zipSync({ 'a.md': strToU8('![a](a.png)\n\n![b](b.png)'), 'a.png': png, 'b.png': png })
  await assert.rejects(importNotesFile(store, attachments, { bytes: zip, filename: 'x.zip', extension: 'zip', folderId: null }),
    (error: unknown) => (error as { code?: string }).code === 'ATTACHMENT_QUOTA')
  assert.deepEqual(await manifestIds(path), [kept.id])
  assert.equal((await store.readState()).notes.length, 0)
})

test('an attachment over the size limit is skipped and its link stays readable', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const attachments = new AttachmentStore({ directory: path, maxFileBytes: 10 })
  const zip = zipSync({ 'a.md': strToU8('![big picture](big.png)\n\n[small](small.bin)'), 'big.png': png, 'small.bin': strToU8('more than ten bytes') })
  const result = await importNotesFile(store, attachments, { bytes: zip, filename: 'x.zip', extension: 'zip', folderId: null })
  assert.deepEqual([result.notes, result.attachments], [1, 0])
  assert.deepEqual(result.skipped.map(item => item.path), ['big.png', 'small.bin'])
  const [note] = (await store.readState()).notes
  assert.deepEqual(note!.content.content, [
    { type: 'paragraph', content: [{ type: 'text', text: 'big picture' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'small' }] },
  ])
})

async function upload(path: string, name: string, bytes: Uint8Array) {
  await mkdir(join(path, 'imports'), { recursive: true, mode: 0o700 })
  const file = join(path, 'imports', name)
  await writeFile(file, bytes, { mode: 0o600 })
  return file
}

test('the worker imports a prepared upload from <data>/imports', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const folder = await store.createFolder('收件箱')
  const md = await upload(path, `${randomUUID()}.md`, strToU8('# 从 Markdown\n\n- [x] 完成'))
  const result = await runWorker({ kind: 'import', path: md, filename: '原始名.md', folderId: folder.id }, path) as { data: { noteIds: string[]; notes: number } }
  assert.equal(result.data.notes, 1)
  const zip = await upload(path, `${randomUUID()}.zip`, zipSync({ '项目/a.md': strToU8('a'), 'b.txt': strToU8('b') }))
  const archive = await runWorker({ kind: 'import', path: zip, filename: 'vault.zip', folderId: null }, path) as { data: Record<string, unknown> }
  assert.deepEqual({ ...archive.data, noteIds: (archive.data.noteIds as string[]).length }, { notes: 2, attachments: 0, folders: 1, noteIds: 2, skipped: [] })
  const state = await store.readState()
  const imported = state.notes.find(note => note.id === result.data.noteIds[0])!
  assert.equal(imported.title, '从 Markdown')
  assert.equal(imported.folderId, folder.id)
  assert.equal(imported.content.content[0]!.type, 'taskList')
  assert.deepEqual(state.folders.map(item => item.name).sort(), ['收件箱', '项目'])
  const text = await upload(path, `${randomUUID()}.txt`, strToU8('plain'))
  const plain = await runWorker({ kind: 'import', path: text, filename: 'no-extension', folderId: null }, path) as { data: { noteIds: string[] } }
  assert.equal((await store.getNote(plain.data.noteIds[0]!)).title, 'no-extension', 'the stored name decides the format; the original name the title')
})

test('the worker refuses import paths it did not prepare', async t => {
  const path = await directory(t)
  const outside = await directory(t)
  const store = new JotStore({ directory: path })
  const name = () => `${randomUUID()}.md`
  const good = await upload(path, name(), strToU8('ok'))
  const reject = async (input: Record<string, unknown>, message: string) => {
    await assert.rejects(runWorker({ kind: 'import', filename: 'a.md', folderId: null, ...input }, path), code('INVALID_INPUT'), message)
  }
  const elsewhere = join(outside, 'imports', name())
  await mkdir(join(outside, 'imports'))
  await writeFile(elsewhere, 'x')
  await reject({ path: elsewhere }, 'a file in another data directory')
  await writeFile(join(path, name()), 'x')
  await reject({ path: join(path, 'imports', '..', name()) }, 'a path that leaves the imports directory')
  await reject({ path: join(path, name()) }, 'a file beside jot.json')
  await reject({ path: 'imports/' + name() }, 'a relative path')
  await mkdir(join(path, 'imports', 'nested'))
  await writeFile(join(path, 'imports', 'nested', 'x.md'), 'x')
  await reject({ path: join(path, 'imports', 'nested', 'x.md') }, 'a nested file')
  for (const bad of ['notes.md', `${randomUUID()}.html`, `${randomUUID()}.MD`, `${randomUUID()}.md.zip.exe`, `${randomUUID().toUpperCase()}.md`]) {
    await writeFile(join(path, 'imports', bad), 'x')
    await reject({ path: join(path, 'imports', bad) }, `wrong name ${bad}`)
  }
  const linked = join(path, 'imports', name())
  await symlink(good, linked)
  await reject({ path: linked }, 'a symlink, even to a valid upload')
  const outsideTarget = join(outside, 'secret.md')
  await writeFile(outsideTarget, 'secret')
  const escape = join(path, 'imports', name())
  await symlink(outsideTarget, escape)
  await reject({ path: escape }, 'a symlink out of the data directory')
  const hard = join(path, 'imports', name())
  await link(good, hard)
  await reject({ path: hard }, 'a hard link')
  await reject({ path: join(path, 'imports', name()) }, 'a missing file')
  await reject({ path: good, extra: true }, 'unknown request fields')
  await reject({ path: good, filename: '' }, 'a missing file name')
  const fresh = await upload(path, name(), strToU8('ok'))
  await assert.rejects(runWorker({ kind: 'import', path: fresh, filename: 'a.md', folderId: 'missing' }, path), code('NOT_FOUND'))
  assert.equal((await store.readState()).notes.length, 0)
})

test('the worker refuses an imports directory that is a symlink', async t => {
  const path = await directory(t)
  const outside = await directory(t)
  const name = `${randomUUID()}.md`
  await writeFile(join(outside, name), 'x')
  await symlink(outside, join(path, 'imports'))
  await assert.rejects(runWorker({ kind: 'import', path: join(path, 'imports', name), filename: 'a.md', folderId: null }, path), code('INVALID_INPUT'))
})

test('saved text uses the renderer for validated documents; docToText still validates its input', async t => {
  const doc = validateRichDoc({ type: 'doc', content: [
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
      { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }, { type: 'hardBreak' }, { type: 'text', text: 'c' }] }] },
    ] }] },
  ] })
  assert.equal(validatedDocText(doc), '[x] done\na\tb\nc')
  assert.equal(docToText(doc), validatedDocText(doc))
  assert.throws(() => docToText({ type: 'doc', content: [{ type: 'script' }] } as unknown as RichDoc), code('INVALID_INPUT'))
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const note = await store.createNote({ title: 't', content: doc })
  assert.equal(note.text, '[x] done\na\tb\nc')
  // A tampered derived text is still refused when the state is loaded.
  const state = JSON.parse(await readFile(join(path, STATE_FILENAME), 'utf8'))
  state.notes[0].text = 'other'
  await writeFile(join(path, STATE_FILENAME), JSON.stringify(state))
  await assert.rejects(new JotStore({ directory: path }).readState(), code('CORRUPT_STATE'))
})
