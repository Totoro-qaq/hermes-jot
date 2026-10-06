import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createJotHandler } from '../src/http.js'
import { AttachmentStore } from '../src/attachments.js'
import { JotStore, StoreError, ACTIVITY_FILENAME, STATE_FILENAME } from '../src/store.js'
import { createJotTools } from '../src/tools.js'
import {
  appendBlocks, docFromMarkdown, docFromText, docToText, documentAttachmentIds, documentHasRichOnlyContent,
  documentTasks, setDocumentTask, validateRichDoc, type RichDoc,
} from '../src/model.js'

const code = (expected: string) => (error: unknown) => error instanceof StoreError && error.code === expected
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'dsh-jot-library-'))
  t.after(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

test('Markdown-lite becomes structured blocks and leaves unknown syntax literal', () => {
  const doc = docFromMarkdown([
    '# Plan', '', 'Intro with **bold**, *italic*, `code`, ~~old~~ and [a link](https://example.org).',
    '- [ ] Draft', '- [x] Review', '[ ] Read back format', '', '- one', '* two', '', '3. third', '4) fourth',
    '> quoted', '> still quoted', '---', '```ts', 'const a = 1', '```',
    '| Item | State |', '| --- | --- |', '| Entry | Done |',
    'snake_case_name stays and <b>html</b> stays literal', '[unsafe](javascript:alert(1))',
  ].join('\n'))
  assert.deepEqual(doc.content.map(block => block.type), ['heading', 'paragraph', 'taskList', 'bulletList', 'orderedList',
    'blockquote', 'horizontalRule', 'codeBlock', 'table', 'paragraph', 'paragraph'])
  assert.deepEqual(doc.content[0]!.attrs, { level: 1 })
  const marks = doc.content[1]!.content!.filter(node => node.marks).map(node => [node.text, node.marks![0]!.type])
  assert.deepEqual(marks, [['bold', 'bold'], ['italic', 'italic'], ['code', 'code'], ['old', 'strike'], ['a link', 'link']])
  assert.deepEqual(documentTasks(doc), [
    { index: 1, text: 'Draft', checked: false }, { index: 2, text: 'Review', checked: true }, { index: 3, text: 'Read back format', checked: false },
  ])
  assert.equal(doc.content[4]!.attrs!.start, 3)
  assert.equal(doc.content[5]!.content!.length, 2)
  assert.equal(doc.content[8]!.content!.length, 2)
  assert.equal(doc.content[8]!.content![0]!.content![0]!.type, 'tableHeader')
  assert.equal(docToText({ type: 'doc', content: [doc.content[9]!] }), 'snake_case_name stays and <b>html</b> stays literal')
  assert.equal(docToText({ type: 'doc', content: [doc.content[10]!] }), '[unsafe](javascript:alert(1))')
  assert.deepEqual(docFromMarkdown('').content, [{ type: 'paragraph' }])
})

test('Markdown table input refuses excess columns instead of silently dropping their content', () => {
  const row = Array.from({ length: 51 }, (_, index) => `column-${index + 1}`)
  const source = `| ${row.join(' | ')} |\n| ${row.map(() => '---').join(' | ')} |\n| ${row.join(' | ')} |`
  assert.throws(() => docFromMarkdown(source), code('INVALID_INPUT'))
})

test('Markdown headings retain literal hash characters while accepting spaced closing markers', () => {
  const doc = docFromMarkdown('# C#\n## Release ###\n### ###')
  assert.deepEqual(doc.content.map(node => docToText({ type: 'doc', content: [node] })), ['C#', 'Release', ''])
})

test('appended lists join a matching list; blank notes are replaced instead of padded', () => {
  const existing = docFromMarkdown('Groceries\n- [ ] Milk')
  const merged = appendBlocks(existing.content, docFromMarkdown('- [ ] Eggs\nThanks').content)
  assert.deepEqual(merged.map(block => block.type), ['paragraph', 'taskList', 'paragraph'])
  assert.equal(merged[1]!.content!.length, 2)
  assert.deepEqual(appendBlocks(docFromText('').content, docFromMarkdown('- a').content).map(block => block.type), ['bulletList'])
  assert.deepEqual(appendBlocks(docFromMarkdown('- a').content, docFromMarkdown('1. b').content).map(block => block.type), ['bulletList', 'orderedList'])
})

test('task helpers address checklist items in document order and refuse missing items', () => {
  const doc = docFromMarkdown('- [ ] A\n- [ ] B')
  const changed = setDocumentTask(doc, 2, true)
  assert.deepEqual(documentTasks(changed).map(task => task.checked), [false, true])
  assert.deepEqual(documentTasks(doc).map(task => task.checked), [false, false], 'the input is not mutated')
  assert.throws(() => setDocumentTask(doc, 3, true), code('NOT_FOUND'))
  assert.throws(() => setDocumentTask(doc, 0, true), code('INVALID_INPUT'))
})

test('rich-only detection and attachment references cover tables, files and color marks', () => {
  const attachment = 'a'.repeat(32)
  const rich: RichDoc = validateRichDoc({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks: [{ type: 'highlight', attrs: { color: '#fef08a' } }] }] },
    { type: 'attachment', attrs: { attachmentId: attachment, caption: 'file.pdf' } },
  ] })
  assert.equal(documentHasRichOnlyContent(rich), true)
  assert.equal(documentHasRichOnlyContent(docFromMarkdown('# Title\n- [x] **done**')), false)
  assert.deepEqual([...documentAttachmentIds(rich)], [attachment])
})

test('agent tools write checklists, extend them, tick items and refuse lossy replacement', async t => {
  const store = new JotStore({ directory: await directory(t) })
  await store.setAgentEnabled(true)
  const tools = createJotTools(store)
  const run = (name: string, args: Record<string, unknown>) =>
    tools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as Promise<any>
  const created = await run('jot_create', { title: 'Trip', text: '## Packing\n- [ ] Passport' })
  assert.deepEqual((await store.getNote(created.id)).content.content.map(block => block.type), ['heading', 'taskList'])
  const appended = await run('jot_update', { id: created.id, revision: created.revision, appendText: '- [ ] Charger' })
  const read = await run('jot_read', { id: created.id })
  assert.deepEqual(read.tasks.map((task: { text: string }) => task.text), ['Passport', 'Charger'])
  assert.equal(read.revision, appended.revision)
  const ticked = await run('jot_set_task', { id: created.id, revision: read.revision, index: 2, checked: true })
  assert.deepEqual(ticked.task, { index: 2, text: 'Charger', checked: true })
  await assert.rejects(run('jot_set_task', { id: created.id, revision: read.revision, index: 1, checked: true }), code('REVISION_CONFLICT'))
  const plain = await run('jot_create', { title: 'Literal', text: '- not a list', format: 'plain' })
  assert.equal((await store.getNote(plain.id)).content.content[0]!.type, 'paragraph')

  const table = await store.createNote({ title: 'Table', content: docFromMarkdown('| A |\n| --- |\n| 1 |') })
  await assert.rejects(run('jot_update', { id: table.id, revision: table.revision, text: 'flattened' }), code('INVALID_INPUT'))
  assert.equal((await store.getNote(table.id)).content.content[0]!.type, 'table')
  const replaced = await run('jot_update', { id: table.id, revision: table.revision, text: 'flattened', allowFormattingLoss: true })
  assert.equal((await store.getNote(table.id)).text, 'flattened')
  assert.equal(replaced.revision, table.revision + 1)
  assert.deepEqual((await run('jot_list', {})).folders, [])
})

test('agent attribution lives beside jot.json and disappears after a human edit', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  await store.setAgentEnabled(true)
  const human = await store.createNote({ title: 'Human' })
  const agent = await store.createNote({ title: 'Agent' }, 'agent')
  let { snapshot, tag } = await store.readSnapshot()
  assert.deepEqual(Object.keys(snapshot!.agentEdits), [agent.id])
  assert.equal(snapshot!.agentEdits[agent.id]!.revision, agent.revision)
  assert.equal(snapshot!.agentEdits[human.id], undefined)
  // Older plugin versions validate jot.json strictly; attribution must not add note fields.
  const saved = JSON.parse(await readFile(join(path, STATE_FILENAME), 'utf8'))
  assert.deepEqual(Object.keys(saved.notes[1]).sort(), ['content', 'createdAt', 'deletedAt', 'folderId', 'id', 'pinned', 'revision', 'text', 'title', 'updatedAt'])
  assert.equal((await store.readSnapshot(tag)).snapshot, undefined, 'an unchanged library is not copied')
  await store.updateNote(agent.id, agent.revision, { title: 'Human took over' })
  ;({ snapshot } = await store.readSnapshot(tag))
  assert.ok(snapshot, 'a human edit changes the tag')
  assert.deepEqual(snapshot.agentEdits, {})
  await writeFile(join(path, ACTIVITY_FILENAME), '{broken')
  assert.deepEqual((await store.readSnapshot()).snapshot!.agentEdits, {}, 'a damaged sidecar is ignored')
})

test('the snapshot tag follows the bytes on disk, including writes from another store instance', async t => {
  const path = await directory(t)
  const first = new JotStore({ directory: path })
  const second = new JotStore({ directory: path })
  await first.createNote({ title: 'One' })
  const { tag } = await first.readSnapshot()
  assert.equal((await first.readSnapshot(tag)).snapshot, undefined)
  await second.createNote({ title: 'Two' })
  const next = await first.readSnapshot(tag)
  assert.equal(next.snapshot?.notes.length, 2)
  assert.notEqual(next.tag, tag)
})

test('permanent deletion is human-only, revision checked, and releases files no other note uses', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const attachments = new AttachmentStore({ directory: path })
  const shared = await attachments.upload({ name: 'shared.png', mimeType: 'image/png', bytes: PNG })
  const only = await attachments.upload({ name: 'only.png', mimeType: 'image/png', bytes: PNG })
  const image = (id: string) => ({ type: 'image', attrs: { attachmentId: id, alt: '' } })
  const doomed = await store.createNote({ title: 'Doomed', content: { type: 'doc', content: [image(shared.id), image(only.id)] } as RichDoc })
  const keeper = await store.createNote({ title: 'Keeper', content: { type: 'doc', content: [image(shared.id)] } as RichDoc })
  await assert.rejects(store.purgeNotes([{ id: doomed.id, revision: doomed.revision }], 'agent'), code('HUMAN_ONLY'))
  await assert.rejects(store.purgeNotes([{ id: doomed.id, revision: doomed.revision + 1 }]), code('REVISION_CONFLICT'))
  const release = async (ids: string[]) => { await attachments.remove(ids) }
  const result = await store.purgeNotes([{ id: doomed.id, revision: doomed.revision }], 'user', release)
  assert.deepEqual(result, { purged: [doomed.id], attachments: [only.id] })
  await assert.rejects(store.getNote(doomed.id), code('NOT_FOUND'))
  await assert.rejects(attachments.get(only.id), /unavailable/u)
  assert.equal((await attachments.get(shared.id)).id, shared.id)
  const trashed = await store.deleteNote(keeper.id, keeper.revision)
  assert.ok(trashed.deletedAt)
  const emptied = await store.purgeNotes('trash', 'user', release)
  assert.deepEqual(emptied, { purged: [keeper.id], attachments: [shared.id] })
  assert.deepEqual((await store.readState()).notes, [])
  assert.deepEqual(await store.purgeNotes('trash'), { purged: [], attachments: [] })
})

test('attachment cleanup never traverses a symlinked preview root', { skip: process.platform === 'win32' }, async t => {
  const path = await directory(t)
  const outside = await directory(t)
  const attachments = new AttachmentStore({ directory: path })
  const attachment = await attachments.upload({ name: 'removed.png', bytes: PNG })
  const outsidePreview = join(outside, attachment.id)
  await mkdir(outsidePreview)
  const sentinel = join(outsidePreview, 'keep.txt')
  await writeFile(sentinel, 'outside file must remain')
  await symlink(outside, join(attachments.directory, '.preview'), 'dir')
  assert.equal(await attachments.remove([attachment.id]), 1)
  assert.equal(await readFile(sentinel, 'utf8'), 'outside file must remain')
  await assert.rejects(attachments.get(attachment.id), /unavailable/u)
})

test('HTTP cannot save a stale attachment reference after another note permanently releases it', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const attachments = new AttachmentStore({ directory: path })
  const attachment = await attachments.upload({ name: 'shared.png', bytes: PNG })
  const content: RichDoc = { type: 'doc', content: [{ type: 'image', attrs: { attachmentId: attachment.id, alt: 'Shared' } }] }
  const source = await store.createNote({ content })
  const target = await store.createNote({ title: 'Other unsaved draft' })
  const server = createServer(createJotHandler(store, { authorize: () => undefined, attachments }))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  const request = (route: string, method: string, body: unknown) => fetch(`${base}/jot/api${route}`, {
    method, headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await request(`/notes/${source.id}/purge`, 'POST', { revision: source.revision })).status, 200)
  const save = await request(`/notes/${target.id}`, 'PATCH', { revision: target.revision, content })
  assert.equal(save.status, 404)
  assert.equal((await save.json()).error.code, 'ATTACHMENT_NOT_FOUND')
  assert.deepEqual(await store.getNote(target.id), target, 'the failed save leaves the existing note unchanged')
  const create = await request('/notes', 'POST', { content })
  assert.equal(create.status, 404)
  assert.equal((await store.readState()).notes.length, 1)
})

test('attachment verification retains the notes lock until a new reference is committed', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const concurrent = new JotStore({ directory: path, lockTimeoutMs: 25 })
  const attachments = new AttachmentStore({ directory: path })
  const attachment = await attachments.upload({ name: 'shared.png', bytes: PNG })
  const content: RichDoc = { type: 'doc', content: [{ type: 'image', attrs: { attachmentId: attachment.id, alt: 'Shared' } }] }
  const source = await store.createNote({ content })
  const target = await store.createNote({ title: 'New reference' })
  const release = async (ids: string[]) => { await attachments.remove(ids) }
  await store.updateNote(target.id, target.revision, { content }, 'user', async doc => {
    await attachments.assertReferences([...documentAttachmentIds(doc)])
    await assert.rejects(concurrent.purgeNotes([{ id: source.id, revision: source.revision }], 'user', release), code('LOCK_TIMEOUT'))
  })
  const purged = await concurrent.purgeNotes([{ id: source.id, revision: source.revision }], 'user', release)
  assert.deepEqual(purged.attachments, [], 'the now-saved reference keeps the shared file alive')
  assert.equal((await attachments.get(attachment.id)).id, attachment.id)
})

test('HTTP state answers 304 for an unchanged tag and exposes permanent deletion endpoints', async t => {
  const path = await directory(t)
  const store = new JotStore({ directory: path })
  const server = createServer(createJotHandler(store, { authorize: (_request: IncomingMessage) => undefined }))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  const request = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/jot/api${route}`, {
    method, headers: { origin: base, ...body === undefined ? {} : { 'content-type': 'application/json' }, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const note = await store.createNote({ title: 'Kept' })
  const first = await request('/state')
  const tag = first.headers.get('etag')
  assert.equal(first.status, 200)
  assert.ok(tag)
  assert.deepEqual((await first.json()).data.agentEdits, {})
  const unchanged = await request('/state', 'GET', undefined, { 'if-none-match': tag! })
  assert.equal(unchanged.status, 304)
  assert.equal(await unchanged.text(), '')
  const trashed = await store.deleteNote(note.id, note.revision)
  assert.equal((await request('/state', 'GET', undefined, { 'if-none-match': tag! })).status, 200)
  assert.equal((await request(`/notes/${note.id}/purge`, 'GET')).status, 405)
  assert.equal((await request(`/notes/${note.id}/purge`, 'POST', { revision: trashed.revision - 1 })).status, 409)
  const purged = await request(`/notes/${note.id}/purge`, 'POST', { revision: trashed.revision })
  assert.deepEqual((await purged.json()).data, { purged: [note.id], attachments: [] })
  assert.equal((await request('/trash/empty', 'POST', { extra: true })).status, 400)
  assert.deepEqual((await (await request('/trash/empty', 'POST', {})).json()).data, { purged: [], attachments: [] })
})
