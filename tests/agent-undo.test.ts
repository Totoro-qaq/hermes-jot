import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createJotHandler } from '../src/http.js'
import { AGENT_UNDO_DIRECTORY, BACKUP_FILENAME, JotStore, STATE_FILENAME, StoreError } from '../src/store.js'
import { AttachmentStore } from '../src/attachments.js'
import { createJotTools } from '../src/tools.js'
import { docFromMarkdown, docFromText, documentAttachmentIds, type RichDoc } from '../src/model.js'

const code = (expected: string) => (error: unknown) => error instanceof StoreError && error.code === expected

async function store(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jot-undo-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const value = new JotStore({ directory })
  await value.setAgentEnabled(true)
  return { directory, store: value }
}
const tool = (s: JotStore, name: string) => createJotTools(s).find(item => item.name === name)! as unknown as {
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

test('a run of agent edits can be undone in one step, back to the last human version', async t => {
  const { store: notes } = await store(t)
  const human = await notes.createNote({ title: '周会', content: docFromMarkdown('- [ ] 准备材料\n- [ ] 预约会议室') })
  const first = await notes.updateNote(human.id, human.revision, { appendContent: docFromText('AI 补充一') }, 'agent')
  const ticked = await tool(notes, 'jot_set_task').execute({ id: human.id, revision: first.revision, index: 1, checked: true })
  let { snapshot } = await notes.readSnapshot()
  assert.equal(snapshot!.agentEdits[human.id]!.revision, ticked.revision)
  assert.equal(snapshot!.agentEdits[human.id]!.undo, true)
  const reverted = await notes.revertAgentEdit(human.id, ticked.revision as number)
  assert.equal(reverted.revision, (ticked.revision as number) + 1, 'the restore is a new human revision')
  assert.deepEqual(reverted.content, human.content, 'both agent edits are undone together')
  assert.equal(reverted.title, '周会')
  ;({ snapshot } = await notes.readSnapshot())
  assert.deepEqual(snapshot!.agentEdits, {}, 'the AI mark clears with the human revision')
  await assert.rejects(notes.revertAgentEdit(human.id, reverted.revision), code('NOT_FOUND'), 'nothing is left to undo')
})

test('a human edit between agent edits starts a new run, and older plugin data stays readable', async t => {
  const { directory, store: notes } = await store(t)
  const note = await notes.createNote({ title: 'A', content: docFromText('人写的') })
  const agent1 = await notes.updateNote(note.id, note.revision, { appendContent: docFromText('AI 一') }, 'agent')
  const human = await notes.updateNote(note.id, agent1.revision, { title: '人改了标题' })
  assert.equal((await notes.readSnapshot()).snapshot!.agentEdits[note.id], undefined)
  await assert.rejects(notes.revertAgentEdit(note.id, human.revision), code('NOT_FOUND'), 'a human version is never undone')
  const agent2 = await notes.updateNote(note.id, human.revision, { title: 'AI 改了标题', folderId: null }, 'agent')
  const reverted = await notes.revertAgentEdit(note.id, agent2.revision)
  assert.equal(reverted.title, '人改了标题', 'only the latest run is undone')
  assert.equal(reverted.text, human.text)
  const saved = JSON.parse(await readFile(join(directory, STATE_FILENAME), 'utf8'))
  assert.deepEqual(Object.keys(saved.notes[0]).sort(), ['content', 'createdAt', 'deletedAt', 'folderId', 'id', 'pinned', 'revision', 'text', 'title', 'updatedAt'])
  assert.deepEqual(await readdir(join(directory, AGENT_UNDO_DIRECTORY)), [], 'a restored version leaves no kept copy behind')
})

test('undo checks the revision, ignores agents, survives AI being switched off and restores folders only when they exist', async t => {
  const { store: notes } = await store(t)
  const folder = await notes.createFolder('工作')
  const note = await notes.createNote({ title: '归档', folderId: folder.id })
  const agent = await notes.updateNote(note.id, note.revision, { folderId: null, appendContent: docFromText('AI') }, 'agent')
  await assert.rejects(notes.revertAgentEdit(note.id, agent.revision, 'agent'), code('HUMAN_ONLY'))
  await assert.rejects(notes.revertAgentEdit(note.id, agent.revision - 1), code('REVISION_CONFLICT'))
  await notes.setAgentEnabled(false)
  const restored = await notes.revertAgentEdit(note.id, agent.revision)
  assert.equal(restored.folderId, folder.id, 'the user can always undo, even with AI access off')

  await notes.setAgentEnabled(true)
  // The agent moves the note out; the user then deletes the old folder, which no longer holds it.
  const moved = await notes.updateNote(note.id, restored.revision, { folderId: null, appendContent: docFromText('again') }, 'agent')
  await notes.deleteFolder(folder.id)
  assert.equal((await notes.getNote(note.id)).revision, moved.revision, 'the note itself did not change')
  const unfiled = await notes.revertAgentEdit(note.id, moved.revision)
  assert.equal(unfiled.folderId, null, 'a folder deleted since then leaves the restored note unfiled')
  assert.equal(unfiled.text, restored.text)

  const inFolder = await notes.createFolder('临时')
  const filed = await notes.updateNote(note.id, unfiled.revision, { folderId: inFolder.id })
  const edited = await notes.updateNote(note.id, filed.revision, { appendContent: docFromText('AI') }, 'agent')
  await notes.deleteFolder(inFolder.id)
  const current = await notes.getNote(note.id)
  assert.notEqual(current.revision, edited.revision, 'deleting a folder is a human revision of the notes inside it')
  await assert.rejects(notes.revertAgentEdit(note.id, current.revision), code('NOT_FOUND'))
})

test('a damaged or oversized kept version is ignored instead of breaking the note', async t => {
  const { directory, store: notes } = await store(t)
  const note = await notes.createNote({ title: 'Kept' })
  const agent = await notes.updateNote(note.id, note.revision, { appendContent: docFromText('AI') }, 'agent')
  await writeFile(join(directory, AGENT_UNDO_DIRECTORY, `${note.id}.json`), '{broken')
  await assert.rejects(notes.revertAgentEdit(note.id, agent.revision), code('NOT_FOUND'))
  assert.equal((await notes.getNote(note.id)).revision, agent.revision, 'a refused undo writes nothing')
  await rm(join(directory, AGENT_UNDO_DIRECTORY, `${note.id}.json`))
  await assert.rejects(notes.revertAgentEdit(note.id, agent.revision), code('NOT_FOUND'), 'a missing copy does not break ordinary reads')
  await writeFile(join(directory, AGENT_UNDO_DIRECTORY, `${note.id}.json`), 'x'.repeat(2 * 1_048_576 + 1))
  await assert.rejects(notes.revertAgentEdit(note.id, agent.revision), code('NOT_FOUND'), 'an oversized copy is refused before parsing')
  assert.equal((await notes.readState()).notes[0]!.text, 'AI', 'the saved note remains readable with damaged optional data')
  // Permanent deletion removes a kept version together with its note.
  const again = await notes.updateNote(note.id, agent.revision, { appendContent: docFromText('AI 2') }, 'agent')
  const trashed = await notes.deleteNote(note.id, again.revision)
  await notes.purgeNotes([{ id: note.id, revision: trashed.revision }])
  assert.deepEqual(await readdir(join(directory, AGENT_UNDO_DIRECTORY)), [])
})

test('purging a shared attachment keeps the file needed by an active pre-AI version', async t => {
  const { directory, store: notes } = await store(t)
  const attachments = new AttachmentStore({ directory })
  const file = await attachments.upload({ name: 'shared.txt', mimeType: 'text/plain', bytes: Buffer.from('Original attachment') })
  const content: RichDoc = { type: 'doc', content: [{ type: 'attachment', attrs: { attachmentId: file.id, caption: file.name } }] }
  const verify = (doc: RichDoc) => attachments.assertReferences([...documentAttachmentIds(doc)])
  const human = await notes.createNote({ title: 'Restore this note', content }, 'user', verify)
  const shared = await notes.createNote({ title: 'Remove this note', content }, 'user', verify)
  const ai = await notes.updateNote(human.id, human.revision, { content: docFromText('AI replaced the attachment') }, 'agent', verify)
  const trashed = await notes.deleteNote(shared.id, shared.revision)
  const purged = await notes.purgeNotes([{ id: shared.id, revision: trashed.revision }], 'user', async ids => { await attachments.remove(ids) })
  assert.deepEqual(purged.attachments, [], 'an active undo keeps the shared file even though neither current body references it')
  assert.equal((await notes.readSnapshot()).snapshot!.agentEdits[human.id]!.undo, true)
  const restored = await notes.revertAgentEdit(human.id, ai.revision, 'user', verify)
  assert.deepEqual(restored.content, content, 'the original attachment and body can be restored')
  assert.equal((await attachments.content(file.id)).bytes.toString(), 'Original attachment')
  const removed = await notes.deleteNote(restored.id, restored.revision)
  const last = await notes.purgeNotes([{ id: removed.id, revision: removed.revision }], 'user', async ids => { await attachments.remove(ids) })
  assert.deepEqual(last.attachments, [file.id], 'the file is released once the final live reference is purged')
})

test('saved human revisions immediately remove ended AI copies, including folder and trash operations', async t => {
  const { directory, store: notes } = await store(t)
  const folder = await notes.createFolder('Old folder')
  const first = await notes.createNote({ title: 'First', folderId: folder.id, content: docFromText('Private original') })
  const second = await notes.createNote({ title: 'Second', folderId: folder.id })
  const third = await notes.createNote({ title: 'Third' })
  const ai1 = await notes.updateNote(first.id, first.revision, { appendText: 'AI' }, 'agent')
  const ai2 = await notes.updateNote(second.id, second.revision, { appendText: 'AI' }, 'agent')
  const ai3 = await notes.updateNote(third.id, third.revision, { appendText: 'AI' }, 'agent')
  const files = () => readdir(join(directory, AGENT_UNDO_DIRECTORY))
  assert.equal((await files()).length, 3)
  await assert.rejects(notes.updateNote(first.id, first.revision, { title: 'Stale human edit' }), code('REVISION_CONFLICT'))
  assert.equal((await files()).length, 3, 'a failed revision check does not remove any copy')
  await notes.updateNote(first.id, ai1.revision, { title: 'Human edit' })
  assert.deepEqual((await files()).sort(), [`${second.id}.json`, `${third.id}.json`].sort(), 'ordinary saves clean up immediately')
  await notes.deleteFolder(folder.id)
  assert.deepEqual(await files(), [`${third.id}.json`], 'folder deletion also ends the AI run of a note it changes')
  assert.equal((await notes.getNote(second.id)).revision, ai2.revision + 1)
  await notes.deleteNote(third.id, ai3.revision)
  assert.deepEqual(await files(), [], 'moving to Trash leaves no unusable pre-AI body behind')
})

test('an ended AI copy does not keep an otherwise unused attachment alive', async t => {
  const { directory, store: notes } = await store(t)
  const attachments = new AttachmentStore({ directory })
  const file = await attachments.upload({ name: 'ended.txt', bytes: Buffer.from('Ended AI run'), mimeType: 'text/plain' })
  const content: RichDoc = { type: 'doc', content: [{ type: 'attachment', attrs: { attachmentId: file.id, caption: file.name } }] }
  const verify = (doc: RichDoc) => attachments.assertReferences([...documentAttachmentIds(doc)])
  const original = await notes.createNote({ content }, 'user', verify)
  const shared = await notes.createNote({ content }, 'user', verify)
  const ai = await notes.updateNote(original.id, original.revision, { content: docFromText('AI replacement') }, 'agent', verify)
  await notes.updateNote(original.id, ai.revision, { appendText: 'Human revision' }, 'user', verify)
  const trash = await notes.deleteNote(shared.id, shared.revision)
  const purged = await notes.purgeNotes([{ id: trash.id, revision: trash.revision }], 'user', async ids => { await attachments.remove(ids) })
  assert.deepEqual(purged.attachments, [file.id], 'an obsolete undo must not retain an unused file')
  assert.deepEqual(await readdir(join(directory, AGENT_UNDO_DIRECTORY)), [])
})

test('a concurrent human save and AI undo serialize against the same expected revision', async t => {
  const { directory, store: notes } = await store(t)
  const other = new JotStore({ directory })
  const human = await notes.createNote({ title: 'Before', content: docFromText('Human body') })
  const ai = await notes.updateNote(human.id, human.revision, { appendText: 'AI body' }, 'agent')
  const results = await Promise.allSettled([
    notes.revertAgentEdit(ai.id, ai.revision),
    other.updateNote(ai.id, ai.revision, { title: 'Concurrent human edit' }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.ok(code('REVISION_CONFLICT')(refused.reason), 'the losing writer gets an explicit conflict')
  assert.equal((await notes.getNote(ai.id)).revision, ai.revision + 1)
  assert.deepEqual(await readdir(join(directory, AGENT_UNDO_DIRECTORY)), [], 'the winning human revision ends the AI run')
})

test('a failed human persistence leaves the current AI version and its undo intact', async t => {
  const { directory, store: notes } = await store(t)
  const human = await notes.createNote({ title: 'Before', content: docFromText('Human body') })
  const ai = await notes.updateNote(human.id, human.revision, { appendText: 'AI body' }, 'agent')
  const path = join(directory, AGENT_UNDO_DIRECTORY, `${human.id}.json`)
  const before = await readFile(path, 'utf8')
  // An unwritable backup target fails before the state rename, after the operation ran.
  await rm(join(directory, BACKUP_FILENAME))
  await mkdir(join(directory, BACKUP_FILENAME))
  await assert.rejects(notes.updateNote(ai.id, ai.revision, { title: 'Not saved' }), code('PERSISTENCE_ERROR'))
  assert.equal((await notes.getNote(ai.id)).revision, ai.revision)
  assert.equal(await readFile(path, 'utf8'), before, 'cleanup happens only after a successful save')
  await rm(join(directory, BACKUP_FILENAME), { recursive: true })
  const restored = await notes.revertAgentEdit(ai.id, ai.revision)
  assert.deepEqual(restored.content, human.content)
})

test('HTTP undo is POST-only, human-only and returns the restored note', async t => {
  const { store: notes } = await store(t)
  const server = createServer(createJotHandler(notes, { authorize: (_request: IncomingMessage) => undefined }))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}/jot/api${route}`, {
    method, headers: { origin: base, ...body === undefined ? {} : { 'content-type': 'application/json' } },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const note = await notes.createNote({ title: '原样' })
  const agent = await notes.updateNote(note.id, note.revision, { title: 'AI 标题' }, 'agent')
  assert.equal((await request(`/notes/${note.id}/revert-agent-edit`)).status, 405)
  assert.equal((await request(`/notes/${note.id}/revert-agent-edit`, 'POST', { revision: agent.revision, extra: 1 })).status, 400)
  const state = await (await request('/state')).json()
  assert.equal(state.data.agentEdits[note.id].undo, true)
  const response = await request(`/notes/${note.id}/revert-agent-edit`, 'POST', { revision: agent.revision })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.title, '原样')
  const again = await request(`/notes/${note.id}/revert-agent-edit`, 'POST', { revision: agent.revision + 1 })
  assert.equal(again.status, 404)
})
