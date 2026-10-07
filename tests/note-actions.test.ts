import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendExcerpt, duplicateNoteInput, sortNotes } from '../src/client/note-actions.js'
import { docToText, validateRichDoc } from '../src/model.js'
import type { Note, RichDoc } from '../src/client/types.js'

const note = (id: string, patch: Partial<Note> = {}): Note => ({
  id, title: id, content: { type: 'doc', content: [{ type: 'paragraph' }] }, text: '', folderId: null,
  pinned: false, revision: 1, createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null, ...patch,
})

test('modified, created, and title order keep pins first without mutating the supplied notes', () => {
  const notes = [
    note('older-created', { title: 'Note 10', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' }),
    note('newer-created', { title: 'Note 2', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }),
    note('pinned', { title: 'Zulu', pinned: true, updatedAt: '2020-01-01T00:00:00.000Z' }),
  ]
  const original = [...notes]
  assert.deepEqual(sortNotes(notes, 'modified').map(item => item.id), ['pinned', 'older-created', 'newer-created'])
  assert.deepEqual(sortNotes(notes, 'created').map(item => item.id), ['pinned', 'newer-created', 'older-created'])
  assert.deepEqual(sortNotes(notes, 'title').map(item => item.id), ['pinned', 'newer-created', 'older-created'])
  assert.deepEqual(notes, original)
})

test('query title relevance outranks pinned body results under every user sort mode', () => {
  const notes = [
    note('body', { pinned: true, title: 'New', text: 'Travel plan', updatedAt: '2026-10-03T00:00:00.000Z' }),
    note('title-old', { title: 'Travel 10', updatedAt: '2025-01-01T00:00:00.000Z' }),
    note('title-new', { title: 'TRAVEL 2', updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-02T00:00:00.000Z' }),
  ]
  for (const mode of ['modified', 'created', 'title'] as const) {
    assert.deepEqual(sortNotes(notes, mode, ' travel ').map(item => item.id), ['title-new', 'title-old', 'body'])
  }
})

test('equivalent Unicode titles and timestamps use ids as deterministic ties independent of input order', () => {
  const a = note('a', { title: 'Cafe\u0301' })
  const b = note('b', { title: 'Café' })
  for (const mode of ['modified', 'created', 'title'] as const) {
    assert.deepEqual(sortNotes([b, a], mode).map(item => item.id), ['a', 'b'])
    assert.deepEqual(sortNotes([a, b], mode).map(item => item.id), ['a', 'b'])
  }
})

test('duplicate titles stay within 240 UTF-16 units without dividing a grapheme', () => {
  const cluster = '👩🏽\u200d💻'
  const source = { title: `${'a'.repeat(231)}${cluster}${cluster}`, content: note('n').content, folderId: 'folder' }
  const copied = duplicateNoteInput(source)
  assert.ok(copied.title!.length <= 240)
  assert.ok(copied.title!.endsWith(' 副本'))
  const prefix = copied.title!.slice(0, -' 副本'.length)
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source.title), part => part.index))
  boundaries.add(source.title.length)
  assert.ok(boundaries.has(prefix.length))
  assert.equal(copied.folderId, 'folder')
  assert.equal(duplicateNoteInput({ ...source, title: '' }, 'en').title, 'Untitled copy')
  assert.equal(duplicateNoteInput({ ...source, title: 'Plan' }, 'ja').title, 'Plan のコピー')
  assert.equal(duplicateNoteInput({ ...source, title: '' }, 'es').title, 'Sin título copia')
  // Wording before the title counts against the limit too.
  const arabic = duplicateNoteInput({ ...source, title: 'a'.repeat(400) }, 'ar').title!
  assert.ok(arabic.length <= 240 && arabic.startsWith('نسخة من '))
})

test('duplicating tables, marks, and managed attachment attributes creates detached editable content', () => {
  const content = validateRichDoc({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', attrs: { colwidth: [120] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Original', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#2563eb' } }] },
    ] }] },
  ] }] }, { type: 'image', attrs: { attachmentId: 'a'.repeat(32), alt: 'Photo' } }] })
  const copied = duplicateNoteInput({ title: 'Plan', content, folderId: null })
  assert.deepEqual(copied.content, content)
  const changed = copied.content as any
  changed.content[0].content[0].content[0].attrs.colwidth[0] = 300
  changed.content[0].content[0].content[0].content[0].content[0].marks[1].attrs.color = '#dc2626'
  changed.content[1].attrs.alt = 'Changed'
  assert.equal((content.content[0]!.content![0]!.content![0]!.attrs!.colwidth as number[])[0], 120)
  assert.equal(content.content[0]!.content![0]!.content![0]!.content![0]!.content![0]!.marks![1]!.attrs!.color, '#2563eb')
  assert.equal(content.content[1]!.attrs!.alt, 'Photo')
})

test('captured markup is appended as literal paragraphs without disturbing the original document', () => {
  const original: RichDoc = validateRichDoc({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Existing', marks: [{ type: 'underline' }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] }] }] },
    { type: 'image', attrs: { attachmentId: 'b'.repeat(32), alt: 'Local image' } },
  ] })
  const before = structuredClone(original)
  const appended = appendExcerpt(original, '<b>not HTML</b>\r\n\r\nSecond line')
  assert.deepEqual(appended.content!.slice(0, original.content!.length), original.content)
  assert.deepEqual(original, before)
  assert.equal(appended.content![original.content!.length]!.content![0]!.text, '<b>not HTML</b>')
  assert.equal(appended.content![original.content!.length + 1]!.type, 'paragraph')
  assert.ok(docToText(validateRichDoc(appended)).endsWith('<b>not HTML</b>\n\nSecond line'))
})

test('sources are plain labels or safe web links; unsafe URL and HTML source strings never become executable marks', () => {
  const original = note('n').content
  const safe = appendExcerpt(original, 'Quote', { label: 'Reading', url: 'https://example.org/article?x=1&y=2' })
  const line = safe.content!.at(-1)!
  assert.equal(line.content![0]!.text, '来源：Reading ')
  assert.equal(line.content![1]!.marks![0]!.attrs!.href, 'https://example.org/article?x=1&y=2')
  for (const source of ['javascript:alert(1)', 'data:text/html,<script>bad()</script>', '<a href="javascript:bad()">source</a>', 'https://user:secret@example.org/']) {
    const appended = appendExcerpt(original, 'Quote', source)
    assert.equal(appended.content!.at(-1)!.content![0]!.text, `来源：${source}`)
    assert.equal(appended.content!.at(-1)!.content![0]!.marks, undefined)
  }
  const unicodeUrl = `https://example.org/${'路径'.repeat(300)}`
  assert.doesNotThrow(() => appendExcerpt(original, 'Quote', unicodeUrl))
  assert.equal(appendExcerpt(original, 'Quote', unicodeUrl).content!.at(-1)!.content![0]!.marks, undefined)
})
