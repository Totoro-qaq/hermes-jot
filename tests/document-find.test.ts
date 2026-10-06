import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { history, undo } from '@tiptap/pm/history'
import { findMatches, replaceAllMatches, replaceMatch } from '../src/client/document-find.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { attrs: { level: { default: 2 } }, content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false },
    bulletList: { content: 'listItem+', group: 'block' },
    listItem: { content: 'paragraph block*' },
    codeBlock: { content: 'text*', marks: '', group: 'block', code: true },
  },
  marks: { bold: {}, italic: {} },
})
const doc = (text: string) => schema.node('doc', null, [schema.node('paragraph', null, text ? schema.text(text) : undefined)])
const stateFor = (text: string) => EditorState.create({ schema, doc: doc(text), plugins: [history()] })

test('literal matches span adjacent text nodes with different formatting', () => {
  const document = schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('alpha '), schema.text('bold', [schema.marks.bold!.create()]), schema.text(' beta'),
  ])])
  const matches = findMatches(document, 'ha bold be')
  assert.equal(matches.length, 1)
  assert.equal(document.textBetween(matches[0]!.from, matches[0]!.to), 'ha bold be')
  assert.equal(matches[0]!.text, 'ha bold be')
  assert.equal(findMatches(document, 'ALPHA').length, 1)
  assert.equal(findMatches(document, 'ALPHA', { caseSensitive: true }).length, 0)
})

test('Unicode ranges use ProseMirror UTF-16 positions, including expanding lowercase characters', () => {
  const document = doc('🙂 条款🙂 条款')
  const matches = findMatches(document, '条款')
  assert.deepEqual(matches.map(match => [match.from, match.to]), [[4, 6], [9, 11]])
  assert.ok(matches.every(match => document.textBetween(match.from, match.to) === '条款'))
  const expanded = doc('Before İSTANBUL after')
  const match = findMatches(expanded, 'İstanbul')[0]!
  assert.equal(expanded.textBetween(match.from, match.to), 'İSTANBUL')
  assert.equal(findMatches(doc('🙂🙂'), '🙂').length, 2)
})

test('hard breaks are explicit newlines and matches never leak across separate paragraphs', () => {
  const document = schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('ab'), schema.node('hardBreak'), schema.text('cd'),
  ])])
  assert.equal(findMatches(document, 'bc').length, 0)
  const match = findMatches(document, 'b\nc')[0]!
  assert.equal(document.textBetween(match.from, match.to, '\n', '\n'), 'b\nc')
  const state = EditorState.create({ schema, doc: document })
  assert.equal(state.apply(replaceMatch(state, match, 'X')).doc.textContent, 'aXd')
  const separate = schema.node('doc', null, [schema.node('paragraph', null, schema.text('ab')), schema.node('paragraph', null, schema.text('cd'))])
  assert.equal(findMatches(separate, 'b\nc').length, 0)
})

test('regex-shaped queries and HTML-shaped replacements remain literal text', () => {
  const state = stateFor('a.*b .* c $&')
  const matches = findMatches(state.doc, '.*')
  assert.equal(matches.length, 2)
  const replaced = state.apply(replaceAllMatches(state, matches, '<b>literal</b>'))
  assert.equal(replaced.doc.textContent, 'a<b>literal</b>b <b>literal</b> c $&')
  assert.deepEqual(replaced.doc.firstChild!.firstChild!.marks, [])
  const dollar = findMatches(replaced.doc, '$&')[0]!
  assert.ok(replaced.apply(replaceMatch(replaced, dollar, '$1')).doc.textContent.endsWith('$1'))
})

test('empty replacement deletes matches while preserving untouched marks', () => {
  const original = schema.node('doc', null, [schema.node('paragraph', null, [
    schema.text('KEEP ', [schema.marks.bold!.create()]), schema.text('cat '),
    schema.text('and cat', [schema.marks.italic!.create()]), schema.text(' END', [schema.marks.bold!.create()]),
  ])])
  const state = EditorState.create({ schema, doc: original })
  const replaced = state.apply(replaceAllMatches(state, findMatches(original, 'cat'), ''))
  assert.equal(replaced.doc.textContent, 'KEEP  and  END')
  const fragments: Array<[string, string[]]> = []
  replaced.doc.descendants(node => { if (node.isText) fragments.push([node.text!, node.marks.map(mark => mark.type.name)]) })
  assert.ok(fragments.some(([text, marks]) => text === 'KEEP ' && marks.includes('bold')))
  assert.ok(fragments.some(([text, marks]) => text === 'and ' && marks.includes('italic')))
  assert.ok(fragments.some(([text, marks]) => text === ' END' && marks.includes('bold')))
})

test('replace-all uses one history event and one undo restores every occurrence without undoing earlier typing', () => {
  let state = stateFor('cat and cat')
  const original = state.doc
  state = state.apply(state.tr.insertText('!', state.doc.content.size - 1))
  const beforeReplacement = state.doc
  const transaction = replaceAllMatches(state, findMatches(state.doc, 'cat'), 'longer 🐱')
  assert.ok(transaction.steps.length <= 1, 'One text block must not produce one step per occurrence')
  state = state.apply(transaction)
  assert.equal(state.doc.textContent, 'longer 🐱 and longer 🐱!')
  assert.equal(undo(state, transaction => { state = state.apply(transaction) }), true)
  assert.ok(state.doc.eq(beforeReplacement))
  assert.equal(undo(state, transaction => { state = state.apply(transaction) }), true)
  assert.ok(state.doc.eq(original))
})

test('a stale match cannot replace unrelated text after an intervening edit', () => {
  let state = stateFor('alpha beta')
  const match = findMatches(state.doc, 'beta')[0]!
  state = state.apply(state.tr.insertText('New prefix ', 1))
  assert.throws(() => replaceMatch(state, match, 'Wrong'), /document changed/)
  assert.equal(state.doc.textContent, 'New prefix alpha beta')
})

test('empty search and replacement with no matches leave the document unchanged', () => {
  const state = stateFor('Keep this')
  assert.deepEqual(findMatches(state.doc, ''), [])
  const transaction = replaceAllMatches(state, [], 'No insertion')
  assert.equal(transaction.docChanged, false)
  assert.ok(transaction.doc.eq(state.doc))
})

test('batch replacement preserves untouched inline nodes and independent text-block structure', () => {
  const original = schema.node('doc', null, [
    schema.node('heading', { level: 3 }, [schema.text('cat header')]),
    schema.node('paragraph', null, [schema.text('cat '), schema.node('hardBreak'),
      schema.text('KEEP', [schema.marks.bold!.create()]), schema.node('hardBreak'), schema.text(' cat')]),
    schema.node('bulletList', null, [schema.node('listItem', null, [schema.node('paragraph', null, schema.text('cat item'))])]),
  ])
  const state = EditorState.create({ schema, doc: original })
  const transaction = replaceAllMatches(state, findMatches(original, 'cat'), '<b>dog</b>')
  assert.ok(transaction.steps.length <= 3)
  const replaced = state.apply(transaction).doc
  assert.equal(replaced.child(0).type.name, 'heading')
  assert.equal(replaced.child(0).attrs.level, 3)
  assert.equal(replaced.child(1).childCount, 5)
  assert.equal(replaced.child(1).child(1).type.name, 'hardBreak')
  assert.equal(replaced.child(1).child(3).type.name, 'hardBreak')
  assert.equal(replaced.child(1).child(2).text, 'KEEP')
  assert.equal(replaced.child(1).child(2).marks[0]!.type.name, 'bold')
  assert.equal(replaced.child(2).type.name, 'bulletList')
  assert.equal(replaced.child(2).firstChild!.firstChild!.textContent, '<b>dog</b> item')
})

test('200k repeated matches have bounded transaction steps and a single complete undo', () => {
  let state = stateFor('a'.repeat(200_000))
  const original = state.doc
  const matches = findMatches(original, 'a')
  assert.equal(matches.length, 200_000)
  const transaction = replaceAllMatches(state, matches, 'b')
  assert.ok(transaction.steps.length <= 1)
  state = state.apply(transaction)
  assert.equal(state.doc.textContent, 'b'.repeat(200_000))
  assert.equal(undo(state, transaction => { state = state.apply(transaction) }), true)
  assert.ok(state.doc.eq(original))
})
