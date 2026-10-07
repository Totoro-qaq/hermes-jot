import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JotStore } from '../src/store.js'
import { StoreError, docFromMarkdown, docFromText, validateRichDoc } from '../src/model.js'
import { createJotTools } from '../src/tools.js'
import { toolSchema, validateToolArgs } from '../src/tool-definition.js'

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
  return { store, list, run }
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
