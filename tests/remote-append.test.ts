import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { closeHistory, history, undoDepth } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import { AllSelection, TextSelection } from '@tiptap/pm/state'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { appendEditorBlocks } from '../src/client/editor-append.js'
import { acceptRemoteAppend, appendedBlocks, planRemoteAppend, remoteBase, sameJson } from '../src/client/remote-append.js'
import { draftFromNote, type NoteDraft } from '../src/client/drafts.js'
import { appendBlocks, docFromMarkdown, validateRichDoc } from '../src/model.js'
import { JotStore } from '../src/store.js'
import type { Note, RichDoc, RichNode } from '../src/client/types.js'

const text = (value: string): RichNode => ({ type: 'text', text: value })
const p = (value?: string): RichNode => value ? { type: 'paragraph', content: [text(value)] } : { type: 'paragraph' }
const item = (value: string): RichNode => ({ type: 'listItem', content: [p(value)] })
const task = (value: string, checked = false): RichNode => ({ type: 'taskItem', attrs: { checked }, content: [p(value)] })
const bullets = (...values: string[]): RichNode => ({ type: 'bulletList', content: values.map(item) })
const tasks = (...values: Array<string | [string, boolean]>): RichNode => ({ type: 'taskList',
  content: values.map(value => typeof value === 'string' ? task(value) : task(...value)) })
const doc = (...content: RichNode[]): RichDoc => ({ type: 'doc', content })
const blank = () => doc(p())

test('appendedBlocks recognizes the blank-note replacement', () => {
  assert.deepEqual(appendedBlocks(blank(), doc(p('First'), bullets('a'))), [p('First'), bullets('a')])
  assert.deepEqual(appendedBlocks(blank(), blank()), [])
})

test('appendedBlocks returns the plain blocks added after the last one', () => {
  const base = doc(p('Intro'), p('Body'))
  assert.deepEqual(appendedBlocks(base, doc(p('Intro'), p('Body'), p('Added'), bullets('x'))), [p('Added'), bullets('x')])
})

test('appendedBlocks splits items joined into the final list', () => {
  const base = doc(p('Intro'), bullets('a', 'b'))
  assert.deepEqual(appendedBlocks(base, doc(p('Intro'), bullets('a', 'b', 'c'))), [bullets('c')])
  assert.deepEqual(appendedBlocks(base, doc(p('Intro'), bullets('a', 'b', 'c', 'd'), p('After'), tasks('t'))),
    [bullets('c', 'd'), p('After'), tasks('t')])
})

test('appendedBlocks handles a task list that ends the note', () => {
  const base = doc(p('Todo'), tasks(['done', true], 'open'))
  const remote = doc(p('Todo'), tasks(['done', true], 'open', 'new'))
  const blocks = appendedBlocks(base, remote)
  assert.deepEqual(blocks, [tasks('new')])
  assert.ok(sameJson(appendBlocks(base.content as never, blocks as never), remote.content))
})

test('appendedBlocks rejects every change that is not an append', () => {
  const base = doc(p('Intro'), p('Body'), tasks('a', 'b'))
  // An earlier block changed.
  assert.equal(appendedBlocks(base, doc(p('Intro edited'), p('Body'), tasks('a', 'b'), p('More'))), null)
  // A block was removed.
  assert.equal(appendedBlocks(base, doc(p('Intro'), tasks('a', 'b'), p('More'))), null)
  assert.equal(appendedBlocks(base, doc(p('Intro'), p('Body'))), null)
  // jot_set_task ticks a checkbox in the final list.
  assert.equal(appendedBlocks(base, doc(p('Intro'), p('Body'), tasks(['a', true], 'b'))), null)
  assert.equal(appendedBlocks(base, doc(p('Intro'), p('Body'), tasks(['a', true], 'b', 'c'))), null)
  // Attributes of the final list changed while items were added.
  const ordered = doc(p('Steps'), { type: 'orderedList', attrs: { start: 1 }, content: [item('one')] })
  assert.equal(appendedBlocks(ordered, doc(p('Steps'), { type: 'orderedList', attrs: { start: 3 }, content: [item('one'), item('two')] })), null)
  // A same-kind list after an unchanged final list would have been joined by appendBlocks.
  assert.equal(appendedBlocks(doc(bullets('a')), doc(bullets('a'), bullets('b'))), null)
  // Clearing the note is not an append.
  assert.equal(appendedBlocks(base, blank()), null)
})

test('appendedBlocks treats identical content as no change regardless of key order', () => {
  const base = doc(p('Intro'), tasks('a'))
  const reordered = JSON.parse(JSON.stringify(base), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value) as RichDoc
  assert.deepEqual(appendedBlocks(base, reordered), [])
})

const note = (patch: Partial<Note> = {}): Note => ({
  id: 'n1', title: 'Plan', content: doc(p('Intro')), text: 'Intro', folderId: null, pinned: false,
  revision: 3, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, ...patch,
})
const dirtyDraft = (base: Note, content: RichDoc = doc(p('Intro typed'))): NoteDraft => ({
  ...draftFromNote(base), content, dirty: true, draftId: 'd1', editVersion: 2,
})

test('planRemoteAppend merges an append into the unsaved open draft', () => {
  const base = note()
  const remote = note({ revision: 4, content: doc(p('Intro'), p('From agent')) })
  const input = { draft: dirtyDraft(base), base: remoteBase(base), remote, editorReady: true, saving: false, pending: false, agentRevision: 4 }
  assert.deepEqual(planRemoteAppend(input), { action: 'merge', blocks: [p('From agent')] })
  assert.deepEqual(planRemoteAppend({ ...input, pending: true }), { action: 'pending' })
  const conflict = { action: 'conflict' }
  assert.deepEqual(planRemoteAppend({ ...input, editorReady: false }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, saving: true }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, base: undefined }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, base: { ...remoteBase(base), revision: 2 } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, draft: { ...dirtyDraft(base), dirty: false } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, draft: { ...dirtyDraft(base), noteId: 'other' } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, draft: null }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, revision: 3 } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, deletedAt: '2026-01-02T00:00:00.000Z' } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, title: 'Renamed' } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, folderId: 'f1' } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, pinned: true } }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, content: doc(p('Rewritten')) } }), conflict)
  // Only a revision bump, nothing to merge: the existing conflict path decides.
  assert.deepEqual(planRemoteAppend({ ...input, remote: { ...remote, content: base.content } }), conflict)
  // Another pane already saved this same draft; its text is in the editor and must not be added twice.
  const handedOff = dirtyDraft(base, doc(p('Intro'), p('From agent')))
  assert.deepEqual(planRemoteAppend({ ...input, draft: handedOff }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, draft: dirtyDraft(base, doc(p('Intro'), p('From agent'), p('more'))) }), conflict)
  // The user's own writing at the end of the note is kept beside the agent's append.
  assert.deepEqual(planRemoteAppend({ ...input, draft: dirtyDraft(base, doc(p('Intro'), p('Mine'))) }),
    { action: 'merge', blocks: [p('From agent')] })
})

test('planRemoteAppend never merges an append-only revision the agent did not write', () => {
  // The same user saved this draft from another Jot pane, then kept typing in the open one.
  const base = note({ revision: 1 })
  const remote = note({ revision: 2, content: doc(p('Intro'), p('Hello world')) })
  const input = { draft: dirtyDraft(base, doc(p('Intro'), p('Hello'))), base: remoteBase(base), remote,
    editorReady: true, saving: false, pending: false }
  const conflict = { action: 'conflict' }
  assert.deepEqual(planRemoteAppend(input), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, agentRevision: 1 }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, agentRevision: 3 }), conflict)
  assert.deepEqual(planRemoteAppend({ ...input, agentRevision: 2 }), { action: 'merge', blocks: [p('Hello world')] })
  // Only the latest revision is attributed; an earlier one in between may be the user's own save.
  const later = note({ revision: 3, content: doc(p('Intro'), p('Hello world'), p('From agent')) })
  assert.deepEqual(planRemoteAppend({ ...input, remote: later, agentRevision: 3 }), conflict)
})

test('planRemoteAppend does not resend a merge the editor never confirmed', () => {
  const base = note({ revision: 1, content: doc(p('Intro'), p('Body')) })
  const remote = note({ revision: 2, content: doc(p('Intro'), p('Body'), p('Agent line')) })
  // The editor applied the append but the draft stayed on the old base (late or lost acknowledgement).
  const draft = dirtyDraft(base, doc(p('Intro edited'), p('Body'), p('Agent line')))
  const input = { draft, base: remoteBase(base), remote, editorReady: true, saving: false, pending: false, agentRevision: 2 }
  assert.deepEqual(planRemoteAppend(input), { action: 'merge', blocks: [p('Agent line')] }, 'content alone cannot tell')
  assert.deepEqual(planRemoteAppend({ ...input, unconfirmed: { baseRevision: 1, revision: 2 } }), { action: 'conflict' })
  // A record for an older base does not block a later, unrelated merge.
  assert.deepEqual(planRemoteAppend({ ...input, unconfirmed: { baseRevision: 0, revision: 1 } }), { action: 'merge', blocks: [p('Agent line')] })
})

test('acceptRemoteAppend advances only the draft the merge started from', () => {
  const base = note()
  const remote = note({ revision: 4, content: doc(p('Intro'), p('From agent')) })
  const started = dirtyDraft(base)
  const current = { ...started, content: doc(p('Intro typed'), p('From agent')), editVersion: 3 }
  assert.deepEqual(acceptRemoteAppend(current, started, remote), { ...current, baseRevision: 4, editVersion: 4 })
  assert.equal(acceptRemoteAppend(null, started, remote), null)
  assert.equal(acceptRemoteAppend({ ...current, noteId: 'other' }, started, remote), null)
  assert.equal(acceptRemoteAppend({ ...current, baseRevision: 4 }, started, remote), null)
  assert.equal(acceptRemoteAppend({ ...current, dirty: false }, started, remote), null)
})

// A headless editor has no view plugins (history, trailing paragraph); tests add what they need.
const headless = (content: RichDoc) => new Editor({ element: null, extensions: createJotExtensions(), content })
/** Tiptap keeps an empty paragraph after a final list or table; it is not content. */
const withoutTrailing = (value: RichDoc): RichDoc => {
  // Tiptap's own null attribute defaults are not part of the saved form.
  const clean = (node: RichNode): RichNode => ({ ...node,
    ...node.attrs ? { attrs: Object.fromEntries(Object.entries(node.attrs).filter(([, item]) => item !== null)) } : {},
    ...node.content ? { content: node.content.map(clean) } : {} })
  const content = value.content!.map(clean)
  const last = content.at(-1)
  if (content.length > 1 && last?.type === 'paragraph' && !last.content?.length && content.at(-2)?.type !== 'paragraph') content.pop()
  return validateRichDoc({ type: 'doc', content })
}

test('the editor joins appended items into its final list in one undo-neutral transaction', t => {
  const editor = headless(doc(p('Intro'), tasks(['done', true], 'open')))
  editor.registerPlugin(history())
  t.after(() => editor.destroy())
  // The user is typing at the start of the note.
  editor.view.dispatch(editor.state.tr.insertText('Hi ', 1))
  const updates: boolean[] = []
  editor.on('update', ({ transaction }) => updates.push(transaction.docChanged))
  assert.equal(appendEditorBlocks(editor, [tasks('new'), p('After')]), true)
  assert.deepEqual(updates, [true])
  assert.deepEqual(withoutTrailing(editor.getJSON() as RichDoc),
    validateRichDoc(doc(p('Hi Intro'), tasks(['done', true], 'open', 'new'), p('After'))))
  // The merge is not an undo step, and the history starts again after it.
  assert.equal(undoDepth(editor.state), 0)
  assert.equal(editor.commands.undo(), false)
  assert.deepEqual(withoutTrailing(editor.getJSON() as RichDoc),
    validateRichDoc(doc(p('Hi Intro'), tasks(['done', true], 'open', 'new'), p('After'))))
})

test('the editor keeps the Tiptap trailing empty paragraph last but appends after a real one', t => {
  // The empty paragraph Tiptap's trailing-node plugin keeps after a final list.
  const editor = headless(doc(p('Intro'), bullets('a'), p()))
  t.after(() => editor.destroy())
  assert.equal(appendEditorBlocks(editor, [bullets('b'), p('After')]), true)
  assert.deepEqual(editor.getJSON(), doc(p('Intro'), bullets('a', 'b'), p('After'), p()))

  const mixed = headless(doc(p('Intro'), tasks('a'), p()))
  t.after(() => mixed.destroy())
  assert.equal(appendEditorBlocks(mixed, [bullets('b')]), true)
  assert.deepEqual(withoutTrailing(mixed.getJSON() as RichDoc), validateRichDoc(doc(p('Intro'), tasks('a'), bullets('b'))))

  const prose = headless(doc(p('One'), p()))
  t.after(() => prose.destroy())
  assert.equal(appendEditorBlocks(prose, [p('Two')]), true)
  assert.deepEqual(prose.getJSON(), doc(p('One'), p(), p('Two')))
})

test('the editor replaces a blank document and refuses invalid blocks', t => {
  const editor = headless(blank())
  t.after(() => editor.destroy())
  assert.equal(appendEditorBlocks(editor, [{ type: 'mystery' }]), false)
  assert.equal(appendEditorBlocks(editor, [text('inline')]), false)
  assert.equal(appendEditorBlocks(editor, []), false)
  assert.deepEqual(editor.getJSON(), blank())
  assert.equal(appendEditorBlocks(editor, [p('First'), tasks('a')]), true)
  assert.deepEqual(withoutTrailing(editor.getJSON() as RichDoc), validateRichDoc(doc(p('First'), tasks('a'))))
})

test('an agent append saved by the store merges into the editor as the same document', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jot-remote-append-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new JotStore({ directory })
  const cases: Array<[RichDoc, string]> = [
    [docFromMarkdown('Shopping\n\n- [ ] milk\n- [x] eggs'), '- [ ] bread\n- [ ] butter\n\nThanks'],
    [docFromMarkdown('# Plan\n\n1. first\n2. second'), '3. third'],
    [docFromMarkdown('Plain words'), 'More **words**'],
    [blank(), '- one\n- two'],
  ]
  for (const [content, appendText] of cases) {
    const base = await store.createNote({ title: 'Merge', content })
    const remote = await store.updateNote(base.id, base.revision, { appendContent: docFromMarkdown(appendText) })
    const blocks = appendedBlocks(base.content, remote.content)
    assert.ok(blocks?.length, appendText)
    const editor = headless(base.content)
    try {
      assert.equal(appendEditorBlocks(editor, blocks), true)
      assert.deepEqual(withoutTrailing(editor.getJSON() as RichDoc), remote.content, appendText)
    } finally { editor.destroy() }
  }
  // Only the agent's own revision carries the attribution the merge requires.
  await store.setAgentEnabled(true)
  const shared = await store.createNote({ title: 'Shared', content: docFromMarkdown('Intro') })
  const draft = dirtyDraft(shared, docFromMarkdown('Intro typed'))
  const byAgent = await store.updateNote(shared.id, shared.revision, { appendContent: docFromMarkdown('From agent') }, 'agent')
  const agentRevision = (await store.readSnapshot()).snapshot!.agentEdits[shared.id]?.revision
  const input = { draft, base: remoteBase(shared), remote: byAgent, editorReady: true, saving: false, pending: false, agentRevision }
  assert.equal(planRemoteAppend(input).action, 'merge')
  const mine = await store.createNote({ title: 'Mine', content: docFromMarkdown('Intro') })
  const byUser = await store.updateNote(mine.id, mine.revision, { appendContent: docFromMarkdown('From me') })
  assert.equal((await store.readSnapshot()).snapshot!.agentEdits[mine.id], undefined)
  assert.equal(planRemoteAppend({ ...input, draft: dirtyDraft(mine, docFromMarkdown('Intro typed')), base: remoteBase(mine),
    remote: byUser, agentRevision: undefined }).action, 'conflict')
  // Ticking a checkbox through the store is a different edit and never merges.
  const listed = await store.createNote({ title: 'Tasks', content: docFromMarkdown('- [ ] a\n- [ ] b') })
  const ticked = structuredClone(listed.content)
  ticked.content[0]!.content![0]!.attrs = { ...ticked.content[0]!.content![0]!.attrs, checked: true }
  const remote = await store.updateNote(listed.id, listed.revision, { content: ticked })
  assert.equal(appendedBlocks(listed.content, remote.content), null)
})

test('the editor-kept empty paragraph after a final list does not split agent checklist items', t => {
  // Tiptap keeps an empty paragraph after a final list; the server and the editor both keep it last.
  const saved = doc(p('Plan'), tasks('one'), p())
  const remote = validateRichDoc(doc(...appendBlocks(saved.content as never, docFromMarkdown('- [ ] two').content) as RichNode[])) as RichDoc
  assert.deepEqual(remote, doc(p('Plan'), tasks('one', 'two'), p()))
  assert.deepEqual(appendedBlocks(saved, remote), [tasks('two')])
  // A paragraph the user typed is content: the agent's list starts after it.
  assert.deepEqual(appendBlocks([p('Plan'), tasks('one'), p('note')] as never, [tasks('two')] as never), [p('Plan'), tasks('one'), p('note'), tasks('two')])
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: saved })
  t.after(() => editor.destroy())
  assert.equal(appendEditorBlocks(editor, [tasks('two')]), true)
  assert.ok(sameJson(validateRichDoc(editor.getJSON()), validateRichDoc(remote)))
})

/** A headless editor with undo history, the way StarterKit's UndoRedo runs in the app. */
const withHistory = (content: RichDoc) => {
  const editor = headless(content)
  editor.registerPlugin(history())
  return editor
}
const undoAll = (editor: Editor) => { let steps = 0; while (steps < 50 && editor.commands.undo()) steps++; return steps }
const redoAll = (editor: Editor) => { let steps = 0; while (steps < 50 && editor.commands.redo()) steps++; return steps }
const json = (editor: Editor) => withoutTrailing(editor.getJSON() as RichDoc)
const agentBlocks = (base: RichDoc, agent: RichDoc) =>
  appendedBlocks(base, validateRichDoc(doc(...appendBlocks(base.content as never, agent.content as never) as RichNode[])) as RichDoc)!

test('undo and redo after a merge into a list the user pasted keep the agent items', t => {
  const base = doc(p('Intro'))
  const editor = withHistory(base)
  t.after(() => editor.destroy())
  // The user pastes a list at the end of the last paragraph, then adds another list as a separate step.
  const end = editor.state.doc.content.size - 1
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end))
    .replaceSelection(new Slice(Fragment.from(editor.schema.nodeFromJSON(bullets('mine one', 'mine two'))), 0, 0)))
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodeFromJSON(bullets('mine three'))))
  assert.match(JSON.stringify(json(editor)), /mine one.*mine two.*mine three/u)
  assert.equal(undoDepth(editor.state), 2)
  // The agent's items join the user's final list.
  assert.equal(appendEditorBlocks(editor, agentBlocks(base, doc(bullets('AGENT one', 'AGENT two')))), true)
  const merged = json(editor)
  assert.match(JSON.stringify(merged.content!.at(-1)), /mine three.*AGENT one.*AGENT two/u)
  assert.equal(undoAll(editor), 0)
  assert.equal(redoAll(editor), 0)
  assert.deepEqual(json(editor), merged)
})

test('undo and redo after a merge that replaced a blank document keep the agent blocks', t => {
  const editor = withHistory(doc(p('Mine one'), p('Mine two')))
  t.after(() => editor.destroy())
  // The user clears the note, so the agent's text replaces the blank document.
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)).deleteSelection())
  assert.deepEqual(editor.getJSON(), blank())
  assert.equal(appendEditorBlocks(editor, agentBlocks(blank(), doc(p('AGENT'), tasks('agent task')))), true)
  const merged = validateRichDoc(doc(p('AGENT'), tasks('agent task')))
  assert.deepEqual(json(editor), merged)
  for (let attempt = 0; attempt < 3; attempt++) { editor.commands.undo(); editor.commands.redo() }
  assert.equal(undoAll(editor), 0)
  assert.deepEqual(json(editor), merged)
})

test('the user can undo and redo their own edits made after a merge', t => {
  const editor = withHistory(doc(p('Intro'), tasks('mine')))
  t.after(() => editor.destroy())
  editor.view.dispatch(editor.state.tr.insertText('Hi ', 1))
  assert.equal(appendEditorBlocks(editor, [tasks('agent'), p('After')]), true)
  const merged = json(editor)
  assert.deepEqual(merged, validateRichDoc(doc(p('Hi Intro'), tasks('mine', 'agent'), p('After'))))
  // Two separate later edits: typing in the agent's paragraph, then a new block.
  editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1))
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodeFromJSON(p('Later'))))
  const typed = validateRichDoc(doc(p('Hi Intro'), tasks('mine', 'agent'), p('After!')))
  const edited = validateRichDoc(doc(p('Hi Intro'), tasks('mine', 'agent'), p('After!'), p('Later')))
  assert.deepEqual(json(editor), edited)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(json(editor), typed)
  assert.equal(editor.commands.undo(), true)
  assert.deepEqual(json(editor), merged)
  // The history stops at the merge, so the user's typing before it stays too.
  assert.equal(editor.commands.undo(), false)
  assert.deepEqual(json(editor), merged)
  assert.equal(editor.commands.redo(), true)
  assert.deepEqual(json(editor), typed)
  assert.equal(redoAll(editor), 1)
  assert.deepEqual(json(editor), edited)
  assert.equal(undoAll(editor), 2)
  assert.deepEqual(json(editor), merged)
})
