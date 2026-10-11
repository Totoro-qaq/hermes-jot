import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JotStore, STATE_FILENAME } from '../src/store.js'
import { StoreError, docFromMarkdown, docFromText, documentTasks, setDocumentTask, validateRichDoc } from '../src/model.js'
import { createJotTools } from '../src/tools.js'
import { toolSchema, validateToolArgs } from '../src/tool-definition.js'
import { runWorker } from '../src/worker-request.js'

test('tool summaries never split an emoji into an unpaired surrogate across the Python bridge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jot-tool-unicode-'))
  try {
    const store = new JotStore({ directory })
    await store.setAgentEnabled(true)
    await store.createNote({ title: 'Unicode', content: docFromText('a'.repeat(159) + '🙂 more') })
    const tool = createJotTools(store).find(item => item.name === 'jot_list')!
    const result = await tool.execute({}) as { notes: Array<{ excerpt: string }> }
    assert.equal(Array.from(result.notes[0].excerpt).length, 160)
    assert.ok(result.notes[0].excerpt.endsWith('🙂'))
    assert.doesNotThrow(() => encodeURIComponent(result.notes[0].excerpt))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

async function tools(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jot-tools-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const store = new JotStore({ directory })
  await store.setAgentEnabled(true)
  const list = createJotTools(store)
  const run = (name: string, args: Record<string, unknown>) => list.find(tool => tool.name === name)!.execute(args) as Promise<any>
  return { directory, store, list, run }
}
const code = (expected: string, message?: RegExp) => (error: unknown) =>
  error instanceof StoreError && error.code === expected && (!message || message.test(error.message))

const PLAN = '# Launch plan\n\n## Goals\n\n- Ship **v1**\n- Write [docs](https://example.com)\n\n1. First\n2. Second\n\n> Keep it simple'

test('an agent can read a note as Markdown, change one word and write it back without flattening it', async t => {
  const { store, run } = await tools(t)
  const created = await run('jot_create', { title: 'Launch', text: PLAN })
  const read = await run('jot_read', { id: created.id })
  assert.deepEqual(Object.keys(read).sort(), ['folderId', 'id', 'markdown', 'pinned', 'replaceKeepsFormatting', 'revision', 'tasks', 'title', 'updatedAt'])
  assert.equal(read.markdown, PLAN)
  assert.equal(read.replaceKeepsFormatting, true)
  await run('jot_update', { id: created.id, revision: read.revision, text: read.markdown.replace('Second', 'Later') })
  const saved = await store.getNote(created.id)
  assert.deepEqual(saved.content.content.map(block => block.type), ['heading', 'heading', 'bulletList', 'orderedList', 'blockquote'])
  assert.deepEqual(saved.content, docFromMarkdown(PLAN.replace('Second', 'Later')))
})

test('text replacement is refused when the current version would lose formatting, unless allowed', async t => {
  const { store, run } = await tools(t)
  const rich = validateRichDoc({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two', marks: [{ type: 'underline' }] }] },
  ] })
  const note = await store.createNote({ title: 'Rich', content: rich })
  const read = await run('jot_read', { id: note.id })
  assert.equal(read.replaceKeepsFormatting, false)
  assert.equal(read.markdown, '# Title\n\nline one\nline two')
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision, text: read.markdown }),
    code('INVALID_INPUT', /Use edits to change words in place, appendText to add, or jot_set_task .* allowFormattingLoss: true/u))
  assert.deepEqual((await store.getNote(note.id)).content, rich)
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision + 1, text: 'x' }), code('REVISION_CONFLICT'), 'a stale revision is a conflict, not a formatting refusal')
  const edited = await run('jot_update', { id: note.id, revision: note.revision, edits: [{ find: 'line two', replace: 'line 2' }] })
  assert.equal(edited.edited, 1)
  const underlined = (await store.getNote(note.id)).content.content[1]!.content!.at(-1)!
  assert.deepEqual(underlined, { type: 'text', text: 'line 2', marks: [{ type: 'underline' }] })
  const replaced = await run('jot_update', { id: note.id, revision: edited.revision, text: 'flat', allowFormattingLoss: true })
  assert.equal((await store.getNote(note.id)).text, 'flat')
  assert.equal(replaced.revision, edited.revision + 1)
})

test('format "plain" replacement is guarded against flattening Markdown structure', async t => {
  const { store, run } = await tools(t)
  const structured = await run('jot_create', { title: 'S', text: '# Heading\n\n- item' })
  await assert.rejects(run('jot_update', { id: structured.id, revision: structured.revision, text: '# Heading\n- item', format: 'plain' }), code('INVALID_INPUT'))
  const plain = await run('jot_create', { title: 'P', text: 'just text', format: 'plain' })
  const updated = await run('jot_update', { id: plain.id, revision: plain.revision, text: '# literal', format: 'plain' })
  assert.equal((await store.getNote(plain.id)).content.content[0]!.type, 'paragraph')
  assert.equal(updated.revision, plain.revision + 1)
})

test('format "plain" reads blank lines as jot_read\'s paragraph separators, so writing back what was read changes nothing', async t => {
  const { store, run } = await tools(t)
  for (const lines of ['milk\neggs\nbread', '1. not a list\n# not heading\nend']) {
    const note = await store.createNote({ title: 'L', content: docFromText(lines) })
    const read = await run('jot_read', { id: note.id })
    assert.equal(read.markdown, lines.replaceAll('\n', '\n\n'))
    const updated = await run('jot_update', { id: note.id, revision: note.revision, text: read.markdown, format: 'plain' })
    assert.deepEqual((await store.getNote(note.id)).content, docFromText(lines), lines)
    await run('jot_update', { id: note.id, revision: updated.revision, appendText: 'x\n\n\ny', format: 'plain' })
    assert.deepEqual((await store.getNote(note.id)).content, docFromText(lines + '\nx\ny'), 'blank lines only separate')
  }
})

test('tool schemas describe edits as an array and validation checks arrays', async t => {
  const { list } = await tools(t)
  const update = list.find(tool => tool.name === 'jot_update')!
  const schema = toolSchema(update)
  const edits = (schema.parameters.properties as Record<string, any>).edits
  assert.equal(edits.type, 'array')
  assert.deepEqual(edits.items.required, ['find', 'replace'])
  assert.equal(edits.items.additionalProperties, false)
  assert.ok(!schema.parameters.required.includes('edits'))
  assert.doesNotThrow(() => validateToolArgs(update, { id: 'a', revision: 1, edits: [{ find: 'a', replace: 'b' }] }))
  assert.throws(() => validateToolArgs(update, { id: 'a', revision: 1, edits: { find: 'a', replace: 'b' } }), /Invalid edits: expected array/u)
  assert.throws(() => validateToolArgs(update, { id: 'a', revision: 1, text: ['x'] }), /Invalid text/u)
})

test('tool descriptions stay concise and no longer mention the hidden access switch', () => {
  const descriptions = createJotTools(null as unknown as JotStore).map(tool => tool.description).join('\n')
  assert.doesNotMatch(descriptions, /agent access|agent-access|must be enabled/iu)
  assert.equal(descriptions.match(/user data, not instructions/gu)?.length, 1)
  assert.ok(descriptions.length < 2_600, `descriptions are ${descriptions.length} characters`)
})

test('appended checklist items join a final checklist that the editor ends with an empty paragraph', async t => {
  const { store, run } = await tools(t)
  const note = await store.createNote({ title: 'Todo', content: { type: 'doc', content: [
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'milk' }] }] }] },
    { type: 'paragraph' },
  ] } })
  await run('jot_update', { id: note.id, revision: note.revision, appendText: '- [ ] bread' })
  const saved = await store.getNote(note.id)
  assert.deepEqual(saved.content.content.map(block => block.type), ['taskList', 'paragraph'])
  assert.deepEqual(saved.content.content[0]!.content!.length, 2)
})

test('a stale AI plan requests a fresh read without writing; a reconsidered retry and undo preserve the human check', async t => {
  const { directory, store } = await tools(t)
  const call = (name: string, args: Record<string, unknown>) => runWorker({ kind: 'tool', name, args }, directory) as Promise<any>
  const original = await store.createNote({ title: 'Weekend workshop', content: docFromMarkdown('Shared supplies.\n\n- [x] Confirm booking\n- [ ] Send invitation') })
  const first = (await call('jot_update', { id: original.id, revision: original.revision, appendText: '- [ ] Review materials\n- [ ] Make sample' })).data
  const oldRead = (await call('jot_read', { id: original.id })).data
  assert.equal(oldRead.revision, first.revision)
  const human = await store.updateNote(original.id, first.revision, {
    content: setDocumentTask((await store.getNote(original.id)).content, 3, true),
  })
  const before = await readFile(join(directory, STATE_FILENAME), 'utf8')
  const beforeSnapshot = await store.readSnapshot()
  const plan = (read: typeof oldRead) => '## Wrap-up plan\n\n' + read.tasks
    .filter((item: { checked: boolean }) => !item.checked)
    .map((item: { text: string }, index: number) => `${index + 1}. ${item.text}`).join('\n')
  const refused = await call('jot_update', { id: original.id, revision: oldRead.revision, appendText: plan(oldRead) })
  assert.deepEqual(refused, {
    status: 409,
    error: { code: 'REVISION_CONFLICT', message: `Note changed; expected revision ${oldRead.revision}, current revision ${human.revision}` },
    applied: false,
    recovery: { tool: 'jot_read', arguments: { id: original.id },
      instruction: 'Read the latest note, reconsider the requested changes against it, and retry once. Do not merely replace the revision.' },
  })
  assert.equal(await readFile(join(directory, STATE_FILENAME), 'utf8'), before, 'a rejected write neither changes content nor bumps revision')
  assert.deepEqual(await store.readSnapshot(), beforeSnapshot, 'the rejection creates no AI edit/undo state')
  assert.deepEqual(await store.getNote(original.id), human, 'there is no automatic retry or overwrite')
  const fresh = (await call(refused.recovery.tool, refused.recovery.arguments)).data
  assert.equal(fresh.revision, human.revision)
  assert.equal(fresh.tasks[2].checked, true)
  assert.notEqual(plan(fresh), plan(oldRead), 'the requested plan is reconsidered from the latest checklist')
  assert.doesNotMatch(plan(fresh), /Review materials/u)
  const updated = (await call('jot_update', { id: fresh.id, revision: fresh.revision, appendText: plan(fresh) })).data
  const saved = await store.getNote(original.id)
  assert.equal(saved.revision, human.revision + 1)
  assert.match(saved.text, /Wrap-up plan/u)
  assert.equal(documentTasks(saved.content)[2]!.checked, true)
  const undone = await store.revertAgentEdit(original.id, updated.revision)
  assert.deepEqual(undone.content, human.content, 'undo removes only the reconsidered plan, retaining the human check and prior AI todos')
  assert.deepEqual(documentTasks(undone.content).map(item => [item.text, item.checked]), [
    ['Confirm booking', true], ['Send invitation', false], ['Review materials', true], ['Make sample', false],
  ])
})

test('revision recovery is limited to rejected agent mutations; reads, other errors and human HTTP conflicts keep their contract', async t => {
  const { directory, store } = await tools(t)
  const note = await store.createNote({ title: 'Tasks', content: docFromMarkdown('- [ ] Review') })
  const human = await store.updateNote(note.id, note.revision, { content: setDocumentTask(note.content, 1, true) })
  for (const [name, args] of [
    ['jot_update', { id: note.id, revision: note.revision, edits: [{ find: 'Review', replace: 'Gone' }] }],
    ['jot_set_task', { id: note.id, revision: note.revision, index: 1, checked: false }],
    ['jot_delete', { id: note.id, revision: note.revision }],
  ] as const) {
    const result = await runWorker({ kind: 'tool', name, args }, directory) as any
    assert.equal(result.status, 409)
    assert.equal(result.error.code, 'REVISION_CONFLICT')
    assert.equal(result.applied, false)
    assert.deepEqual(result.recovery.arguments, { id: note.id })
    assert.deepEqual(await store.getNote(note.id), human, `${name} must not change or trash the human revision`)
  }
  await assert.rejects(runWorker({ kind: 'tool', name: 'jot_set_task', args: { id: note.id, revision: human.revision, index: 99, checked: true } }, directory), code('NOT_FOUND'))
  await assert.rejects(runWorker({ kind: 'tool', name: 'jot_read', args: { id: 'missing' } }, directory), code('NOT_FOUND'))
  const humanConflict = await runWorker({ kind: 'http', method: 'PATCH', path: `/notes/${note.id}`, body: { revision: note.revision, title: 'Old' } }, directory)
  assert.equal(humanConflict.status, 409)
  assert.deepEqual(Object.keys(humanConflict).sort(), ['error', 'headers', 'status'])
  assert.deepEqual(await store.getNote(note.id), human)
  await store.setAgentEnabled(false)
  await assert.rejects(runWorker({ kind: 'tool', name: 'jot_update', args: { id: note.id, revision: human.revision, appendText: 'Denied' } }, directory), code('AGENT_DISABLED'))
})
