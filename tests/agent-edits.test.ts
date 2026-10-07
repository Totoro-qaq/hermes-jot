import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { applyTextEdits } from '../src/agent-edits.js'
import { JotStore } from '../src/store.js'
import { createJotTools } from '../src/tools.js'
import { docFromMarkdown, docToText, documentTasks, StoreError, validateRichDoc, type RichDoc, type RichMark, type RichNode } from '../src/model.js'

const code = (expected: string, message?: RegExp) => (error: unknown) =>
  error instanceof StoreError && error.code === expected && (!message || message.test(error.message))
const text = (value: string, ...marks: RichMark[]): RichNode => marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value }
const p = (...content: RichNode[]): RichNode => content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
const doc = (...content: RichNode[]): RichDoc => validateRichDoc({ type: 'doc', content })
const bold: RichMark = { type: 'bold' }
const edit = (source: RichDoc, find: string, replace: string) => applyTextEdits(source, [{ find, replace }])
const NOT_FOUND = /^Edit 1: text not found\. Match the note's visible text inside one paragraph, heading, list item, table cell or code block, without Markdown markers such as \*\* or #\.$/u

test('a plain edit changes only the matched characters', () => {
  const source = docFromMarkdown('# Plan\n\nShip on Monday.\n\n- keep this')
  const result = edit(source, 'Monday', 'Tuesday')
  assert.deepEqual(result, docFromMarkdown('# Plan\n\nShip on Tuesday.\n\n- keep this'))
  assert.equal(docToText(source), 'Plan\nShip on Monday.\nkeep this', 'the input is not mutated')
})

test('text around a match keeps its marks, and replaced text takes the replaced characters\' marks', () => {
  const source = docFromMarkdown('Ship **v1** today')
  assert.deepEqual(edit(source, 'v1 today', 'v2 today'), docFromMarkdown('Ship **v2** today'), 'shared context is untouched')
  assert.deepEqual(edit(source, 'Ship v1', 'Launch v1'), docFromMarkdown('Launch **v1** today'))
  assert.deepEqual(edit(source, 'v1 to', 'v3 next to'), doc(p(text('Ship '), text('v3 next', bold), text(' today'))))
  assert.deepEqual(edit(source, 'Ship ', 'Ship version '), docFromMarkdown('Ship version **v1** today'), 'an insertion at a boundary takes only shared marks')
  assert.deepEqual(edit(docFromMarkdown('Read [docs](https://x.test)'), 'docs', 'docs and more'),
    doc(p(text('Read '), text('docs', { type: 'link', attrs: { href: 'https://x.test' } }), text(' and more'))), 'a link does not grow at the end of a block')
  assert.deepEqual(edit(docFromMarkdown('**v1**'), 'v1', 'v1.2'), docFromMarkdown('**v1.2**'), 'inside a bold block, insertions stay bold')
})

test('lengthening a formatted run keeps its formatting wherever the run sits', () => {
  for (const [source, find, replace, expected] of [
    ['Owner: **Ana**', 'Ana', 'Anabel', 'Owner: **Anabel**'],
    ['Owner: **Ana** today', 'Ana', 'Anabel', 'Owner: **Anabel** today'],
    ['Ship **v1** today', 'v1', 'v1.2', 'Ship **v1.2** today'],
    ['a **bold** b', 'bold', 'bolder', 'a **bolder** b'],
    ['Due *Monday* please', 'Monday', 'Monday 9am', 'Due *Monday 9am* please'],
    ['Meet at `10:00` sharp', '10:00', '10:00 UTC', 'Meet at `10:00 UTC` sharp'],
    ['Ship **v1** today', 'v1', 'new v1', 'Ship **new v1** today'],
    ['Ship **v1** today', 'v1 today', 'v1 late today', 'Ship **v1** late today'],
    ['Ship **v1** today', 'Ship v1', 'Ship it v1', 'Ship it **v1** today'],
  ] as const) assert.deepEqual(edit(docFromMarkdown(source), find, replace), docFromMarkdown(expected), `${find} -> ${replace} in ${source}`)
  const link = { type: 'link', attrs: { href: 'https://x.test' } } as const
  assert.deepEqual(edit(docFromMarkdown('Read [docs](https://x.test) today'), 'docs', 'docs page'),
    doc(p(text('Read '), text('docs', link), text(' page today'))), 'a link does not grow past its edge mid-sentence')
  assert.deepEqual(edit(docFromMarkdown('Read [docs](https://x.test) today'), 'do', 'do the '),
    doc(p(text('Read '), text('do the cs', link), text(' today'))), 'inside a link, insertions stay linked')
})

test('replaced text spanning several runs keeps each word\'s marks and never splits a word', () => {
  const link = { type: 'link', attrs: { href: 'https://e.com' } } as const
  for (const [source, find, replace, expected] of [
    ['Read [docs](https://e.com) here', 'docs here', 'guide there', 'Read [guide](https://e.com) there'],
    ['**Note:** call Ann today', 'Note: call Ann', 'Todo: email Ann', '**Todo:** email Ann today'],
    ['Meet **Bob** at noon', 'Bob at', 'Rob as', 'Meet **Rob** as noon'],
    ['Read [docs](https://e.com) here', 'docs here', 'guide and more there', 'Read guide and more there'],
    ['a **bo**ld word', 'bold word', 'brave word', 'a brave word'],
    ['Due **Mon** 9am', 'Mon 9am', 'Tue 9am', 'Due **Tue** 9am'],
  ] as const) assert.deepEqual(edit(docFromMarkdown(source), find, replace), docFromMarkdown(expected), `${find} -> ${replace} in ${source}`)
  assert.deepEqual(edit(docFromMarkdown('See [the docs](https://e.com) now'), 'the docs now', 'the guide now'),
    doc(p(text('See '), text('the guide', link), text(' now'))), 'a word inside a link stays linked')
  assert.deepEqual(edit(doc(p(text('\u{1D400}', bold), text('\u{1D400}b'))), '\u{1D400}\u{1D400}b', '\u{1D400}\u{1D400}c'),
    doc(p(text('\u{1D400}', bold), text('\u{1D400}c'))), 'trimming never splits a surrogate pair')
})

test('edits reach table cells, task items, quotes and code blocks', () => {
  const source = docFromMarkdown('| Name | Owner |\n| --- | --- |\n| Launch | Ana |\n\n- [x] Book venue\n- [ ] Send invites\n\n> quoted line\n\n```js\nconst a = 1\nconst b = 2\n```')
  const result = applyTextEdits(source, [
    { find: 'Ana', replace: 'Bo' },
    { find: 'Book venue', replace: 'Book the hall' },
    { find: 'quoted', replace: 'cited' },
    { find: 'a = 1\nconst b', replace: 'a = 10\nconst c' },
  ])
  assert.deepEqual(result, docFromMarkdown('| Name | Owner |\n| --- | --- |\n| Launch | Bo |\n\n- [x] Book the hall\n- [ ] Send invites\n\n> cited line\n\n```js\nconst a = 10\nconst c = 2\n```'))
  assert.deepEqual(documentTasks(result).map(task => task.checked), [true, false], 'checklist state is kept')
})

test('line breaks read as \\n in paragraphs and replace text can add or remove them', () => {
  const broken = doc(p(text('first', bold), { type: 'hardBreak' }, text('second')))
  assert.deepEqual(edit(broken, 'first\nsecond', 'first second'), doc(p(text('first', bold), text(' second'))))
  assert.deepEqual(edit(docFromMarkdown('one two'), 'one two', 'one\ntwo'), doc(p(text('one'), { type: 'hardBreak' }, text('two'))))
  assert.deepEqual(edit(docFromMarkdown('## Title'), 'Title', 'Two\nlines'),
    validateRichDoc({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [text('Two'), { type: 'hardBreak' }, text('lines')] }] }))
  assert.deepEqual(edit(docFromMarkdown('```\nab\n```'), 'ab', 'a\r\nb'), docFromMarkdown('```\na\nb\n```'), 'code blocks keep a literal newline')
})

test('empty replace deletes, and emptied blocks stay valid', () => {
  assert.deepEqual(edit(docFromMarkdown('keep **drop** keep'), ' drop', ''), docFromMarkdown('keep keep'))
  assert.deepEqual(edit(docFromMarkdown('- only'), 'only', ''), validateRichDoc({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] }))
  assert.deepEqual(edit(docFromMarkdown('```\ncode\n```'), 'code', ''), docFromMarkdown('```\n```'))
})

test('a find must match exactly once, inside one block, as visible text', () => {
  const source = docFromMarkdown('Ship **v1**\n\nend of one\n\nstart of two\n\naaa')
  assert.throws(() => edit(source, 'missing', 'x'), code('INVALID_INPUT', NOT_FOUND))
  assert.throws(() => edit(source, '**v1**', 'v2'), code('INVALID_INPUT', NOT_FOUND), 'Markdown markers are not visible text')
  assert.throws(() => edit(source, 'one\nstart', 'x'), code('INVALID_INPUT', NOT_FOUND), 'a match never spans blocks')
  assert.throws(() => edit(source, 'o', 'x'), code('INVALID_INPUT', /^Edit 1 matches 4 places; include more surrounding text\.$/u))
  assert.throws(() => edit(source, 'aa', 'b'), code('INVALID_INPUT', /matches 2 places/u), 'overlapping matches are ambiguous')
})

test('edits apply in order and fail as a whole', () => {
  const source = docFromMarkdown('alpha beta')
  assert.deepEqual(applyTextEdits(source, [{ find: 'alpha', replace: 'gamma' }, { find: 'gamma beta', replace: 'gamma delta' }]), docFromMarkdown('gamma delta'))
  assert.deepEqual(applyTextEdits(source, [{ find: 'alpha', replace: 'beta' }, { find: 'beta beta', replace: 'once' }]), docFromMarkdown('once'))
  assert.throws(() => applyTextEdits(source, [{ find: 'alpha', replace: 'beta' }, { find: 'beta', replace: 'x' }]), code('INVALID_INPUT', /^Edit 2 matches 2 places/u))
  assert.throws(() => applyTextEdits(source, [{ find: 'alpha', replace: 'x' }, { find: 'alpha', replace: 'y' }]), code('INVALID_INPUT', /^Edit 2: text not found/u))
  assert.deepEqual(source, docFromMarkdown('alpha beta'))
})

test('emoji and other surrogate pairs are never split', () => {
  const result = edit(doc(p(text('🙂', bold), text(' ok'))), '🙂 ok', '🙃 ok')
  assert.deepEqual(result, doc(p(text('🙃', bold), text(' ok'))))
})

test('edit input is validated with clear messages', () => {
  const source = docFromMarkdown('text')
  for (const [value, message] of [
    [[], /1 to 20/u], [Array.from({ length: 21 }, () => ({ find: 'text', replace: 'x' })), /1 to 20/u], ['text', /1 to 20/u],
    [[{ find: '', replace: 'x' }], /^Edit 1: find must be a non-empty string of at most 2,000 characters\.$/u],
    [[{ find: 'x'.repeat(2_001), replace: '' }], /find must be/u],
    [[{ find: 'text', replace: 'x'.repeat(20_001) }], /^Edit 1: replace must be a string of at most 20,000 characters\.$/u],
    [[{ find: 'text' }], /replace must be/u],
    [[{ find: 'text', replace: 'x', extra: true }], /Unsupported edit 1 field: extra/u],
    [['text'], /Edit 1 must be an object/u],
  ] as const) assert.throws(() => applyTextEdits(source, value), code('INVALID_INPUT', message))
  assert.deepEqual(applyTextEdits(source, [{ find: 'text', replace: 'x'.repeat(20_000) }]).content[0]!.content![0]!.text!.length, 20_000)
})

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jot-agent-edits-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const store = new JotStore({ directory })
  await store.setAgentEnabled(true)
  const tools = createJotTools(store)
  const run = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args) as Promise<any>
  return { store, run }
}

test('jot_update edits save as an attributed agent revision that the user can undo', async t => {
  const { store, run } = await setup(t)
  const folder = await store.createFolder('Work')
  const original = docFromMarkdown('# Plan\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nShip **v1**')
  const note = await store.createNote({ title: 'Plan', content: original })
  const result = await run('jot_update', { id: note.id, revision: note.revision, title: 'Plan v2', folderId: folder.id,
    edits: [{ find: '2', replace: 'two' }, { find: 'v1', replace: 'v2' }] })
  assert.equal(result.edited, 2)
  assert.equal(result.revision, note.revision + 1)
  assert.equal(result.title, 'Plan v2')
  assert.equal(result.folderId, folder.id)
  const saved = await store.getNote(note.id)
  assert.deepEqual(saved.content, docFromMarkdown('# Plan\n\n| A | B |\n| --- | --- |\n| 1 | two |\n\nShip **v2**'))
  const { snapshot } = await store.readSnapshot()
  assert.deepEqual(snapshot!.agentEdits[note.id], { ...snapshot!.agentEdits[note.id]!, revision: saved.revision, undo: true })
  const reverted = await store.revertAgentEdit(note.id, saved.revision)
  assert.deepEqual(reverted.content, original)
  assert.equal(reverted.title, 'Plan')
  assert.equal(reverted.folderId, null)
})

test('jot_update edits check the revision, fail atomically and exclude text and appendText', async t => {
  const { store, run } = await setup(t)
  const note = await store.createNote({ title: 'N', content: docFromMarkdown('alpha beta') })
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision + 1, edits: [{ find: 'alpha', replace: 'x' }] }), code('REVISION_CONFLICT'))
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision, edits: [{ find: 'alpha', replace: 'x' }, { find: 'nope', replace: 'y' }] }),
    code('INVALID_INPUT', /^Edit 2: text not found/u))
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision, edits: [{ find: 'alpha', replace: 'x' }], text: 'x' }), code('INVALID_INPUT', /Choose one of edits, text or appendText/u))
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision, edits: [{ find: 'alpha', replace: 'x' }], appendText: 'x' }), code('INVALID_INPUT'))
  await assert.rejects(run('jot_update', { id: note.id, revision: note.revision, edits: [] }), code('INVALID_INPUT', /1 to 20/u))
  const unchanged = await store.getNote(note.id)
  assert.equal(unchanged.revision, note.revision)
  assert.equal(unchanged.text, 'alpha beta')
})
