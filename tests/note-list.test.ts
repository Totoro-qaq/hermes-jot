import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activateNoteListItem, buildNoteListRows, formatNoteDate, highlightSegments, nextActiveNoteId, noteDateGroup, noteDateValue, noteExcerpt, noteMatchesQuery, searchElsewhere, titleMatchesFirst } from '../src/client/note-list.js'
import type { Note } from '../src/client/types.js'

const note = (id: string, patch: Partial<Note> = {}): Note => ({
  id, title: id, content: { type: 'doc', content: [{ type: 'paragraph' }] }, text: '', folderId: null,
  pinned: false, revision: 1, createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z', deletedAt: null, ...patch,
})
const localStamp = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

test('date sections follow local calendar days across midnight, month, and year boundaries', () => {
  const now = new Date(2027, 0, 1, 0, 5)
  assert.equal(noteDateGroup(note('today', { updatedAt: localStamp(2027, 1, 1, 0, 1) }), now), 'today')
  // Only ten minutes ago, but yesterday in the browser's local calendar.
  assert.equal(noteDateGroup(note('yesterday', { updatedAt: localStamp(2026, 12, 31, 23, 55) }), now), 'yesterday')
  assert.equal(noteDateGroup(note('six-days', { updatedAt: localStamp(2026, 12, 26) }), now), 'week')
  assert.equal(noteDateGroup(note('seven-days', { updatedAt: localStamp(2026, 12, 25) }), now), 'earlier')
  assert.equal(noteDateGroup(note('pin', { pinned: true, updatedAt: localStamp(2020, 1, 1) }), now), 'pinned')
  assert.equal(noteDateGroup(note('invalid', { updatedAt: 'not-a-date' }), now), 'earlier')
})

test('groups omit empty sections, retain the supplied order, and give notes their real list positions', () => {
  const now = new Date(2026, 9, 2, 16)
  const notes = [
    note('today-first', { updatedAt: localStamp(2026, 10, 2, 15) }),
    note('old-pin', { pinned: true, updatedAt: localStamp(2025, 1, 1) }),
    note('today-second', { updatedAt: localStamp(2026, 10, 2, 13) }),
    note('earlier', { updatedAt: localStamp(2026, 9, 1) }),
  ]
  const rows = buildNoteListRows(notes, { now, locale: 'en' })
  assert.deepEqual(rows.filter(row => row.kind === 'header').map(row => [row.label, row.count]), [
    ['Pinned', 1], ['Today', 2], ['Earlier', 1],
  ])
  assert.deepEqual(buildNoteListRows(notes, { now, locale: 'zh-hant' }).flatMap(row => row.kind === 'header' ? [row.label] : []),
    ['已釘選', '今天', '更早'])
  assert.deepEqual(buildNoteListRows(notes, { now, locale: 'ru' }).flatMap(row => row.kind === 'header' ? [row.label] : []),
    ['Закреплённые', 'Сегодня', 'Ранее'])
  assert.deepEqual(rows.filter(row => row.kind === 'note').map(row => [row.note.id, row.position]), [
    ['old-pin', 1], ['today-first', 2], ['today-second', 3], ['earlier', 4],
  ])
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length)
})

test('search places title matches before newer or pinned body matches without date headers', () => {
  const notes = [
    note('pinned-body', { pinned: true, text: 'launch decision', updatedAt: localStamp(2026, 10, 2) }),
    note('first-title', { title: 'Launch decision', updatedAt: localStamp(2024, 1, 1) }),
    note('second-title', { title: 'LAUNCH plan', updatedAt: localStamp(2025, 1, 1) }),
    note('other-body', { text: 'before launch' }),
  ]
  assert.deepEqual(titleMatchesFirst(notes, ' launch ').map(item => item.id), ['first-title', 'second-title', 'pinned-body', 'other-body'])
  const rows = buildNoteListRows(notes, { query: 'launch' })
  assert.ok(rows.every(row => row.kind === 'note'))
  assert.deepEqual(rows.map(row => row.kind === 'note' ? row.note.id : null), ['first-title', 'second-title', 'pinned-body', 'other-body'])
  assert.deepEqual(titleMatchesFirst(notes, ''), notes)
})

test('a far-away body match shows the matching passage rather than the opening paragraph', () => {
  const text = `${'Opening paragraph without the requested detail. '.repeat(30)}Decision: keep the existing sidebar. The next step is implementation. ${'Old archive text. '.repeat(30)}`
  const excerpt = noteExcerpt(text, 'existing sidebar', 90)
  assert.ok(excerpt.includes('keep the existing sidebar'))
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'))
  assert.ok(!excerpt.includes('Opening paragraph'))
  assert.ok(excerpt.length <= 92)
  assert.equal(noteExcerpt('   \n\t '), '')
  assert.equal(noteExcerpt('one\n\ntwo\tthree'), 'one two three')
})

test('matched excerpts preserve whole emoji and combining-character graphemes', () => {
  const family = '👩🏽\u200d💻'
  const text = `${family.repeat(30)} cafe\u0301 的已确认要求 ${family.repeat(30)}`
  const excerpt = noteExcerpt(text, '已确认要求', 18)
  assert.ok(excerpt.includes('已确认要求'))
  const clipped = excerpt.replace(/^…|…$/gu, '')
  const start = text.indexOf(clipped)
  assert.ok(start >= 0)
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index))
  boundaries.add(text.length)
  assert.ok(boundaries.has(start) && boundaries.has(start + clipped.length))
  assert.ok(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clipped)).length <= 18)
  const highlighted = highlightSegments('Earlier İSTANBUL notes', 'İstanbul')
  assert.deepEqual(highlighted.filter(part => part.matched).map(part => part.text), ['İSTANBUL'])
  assert.equal(highlighted.map(part => part.text).join(''), 'Earlier İSTANBUL notes')
  assert.deepEqual(highlightSegments('cafe\u0301', 'e').filter(part => part.matched).map(part => part.text), ['e\u0301'])
})

test('long search terms remain intact even when they exceed the normal excerpt budget', () => {
  const phrase = '已确认的产品要求'.repeat(30)
  const excerpt = noteExcerpt(`Before ${phrase} after`, phrase, 40)
  assert.ok(excerpt.includes(phrase))
  assert.equal(highlightSegments(excerpt, phrase).find(part => part.matched)?.text, phrase)
})

test('searching a large note still returns only the matching context window', () => {
  const text = `${'资料背景 '.repeat(30_000)}最终确认：保留侧栏编辑。`
  const excerpt = noteExcerpt(text, '保留侧栏编辑', 100)
  assert.ok(excerpt.includes('最终确认：保留侧栏编辑。'))
  assert.ok(excerpt.startsWith('…'))
  assert.ok(excerpt.length <= 101)
})

test('keyboard traversal skips headers, reaches the entire collection, and clamps at both ends', () => {
  const notes = Array.from({ length: 1_000 }, (_, index) => note(`note-${index}`, { pinned: index === 0 }))
  const rows = buildNoteListRows(notes)
  const ids = rows.filter(row => row.kind === 'note').map(row => row.note.id)
  assert.equal(nextActiveNoteId(ids, null, 'ArrowDown'), 'note-0')
  assert.equal(nextActiveNoteId(ids, null, 'ArrowUp'), 'note-999')
  assert.equal(nextActiveNoteId(ids, 'note-0', 'ArrowUp'), 'note-0')
  assert.equal(nextActiveNoteId(ids, 'note-999', 'ArrowDown'), 'note-999')
  assert.equal(nextActiveNoteId(ids, 'note-0', 'End'), 'note-999')
  assert.equal(nextActiveNoteId(ids, 'note-999', 'Home'), 'note-0')
  assert.equal(nextActiveNoteId(ids, 'note-500', 'ArrowDown'), 'note-501')
  assert.equal(nextActiveNoteId(ids, 'removed-note', 'ArrowDown'), 'note-0')
  assert.equal(nextActiveNoteId([], null, 'Home'), null)
})

test('date metadata includes the year for older notes and handles malformed values safely', () => {
  const now = new Date(2026, 9, 2, 16)
  assert.ok(formatNoteDate(localStamp(2025, 3, 4), 'en', now).includes('2025'))
  assert.ok(!formatNoteDate(localStamp(2026, 3, 4), 'en', now).includes('2026'))
  assert.ok(formatNoteDate(localStamp(2026, 10, 2, 15, 30), 'zh', now).includes('15:30'))
  assert.equal(formatNoteDate('bad', 'en', now), '')
  // Every shipped language formats with its own conventions rather than falling back to Chinese.
  assert.match(formatNoteDate(localStamp(2026, 3, 4), 'fr', now), /mars/u)
  assert.match(formatNoteDate(localStamp(2026, 3, 4), 'de', now), /März/u)
  for (const locale of ['zh-hant', 'ja', 'ar', 'ru', 'es'] as const) assert.ok(formatNoteDate(localStamp(2025, 3, 4), locale, now))
})

test('created grouping and displayed timestamp agree even when a much older note was modified today', () => {
  const now = new Date(2026, 9, 3, 16)
  const old = note('old-edited', { createdAt: localStamp(2025, 1, 1), updatedAt: localStamp(2026, 10, 3) })
  const today = note('new', { createdAt: localStamp(2026, 10, 3), updatedAt: localStamp(2026, 10, 3) })
  assert.equal(noteDateGroup(old, now), 'today')
  assert.equal(noteDateGroup(old, now, 'created'), 'earlier')
  const rows = buildNoteListRows([old, today], { now, dateBasis: 'created' })
  assert.deepEqual(rows.filter(row => row.kind === 'note').map(row => row.note.id), ['new', 'old-edited'])
  assert.equal(noteDateValue(old, 'created'), old.createdAt)
  assert.equal(noteDateValue(old, 'modified'), old.updatedAt)
})

test('flat date basis preserves the supplied title sort and keyboard ids without a pinned/date section', () => {
  const notes = [note('Alpha'), note('Beta'), note('Zulu-pin', { pinned: true })]
  const rows = buildNoteListRows(notes, { dateBasis: 'none' })
  assert.ok(rows.every(row => row.kind === 'note'))
  assert.deepEqual(rows.map(row => row.kind === 'note' ? row.note.id : null), ['Alpha', 'Beta', 'Zulu-pin'])
  assert.deepEqual(rows.filter(row => row.kind === 'note').map(row => row.position), [1, 2, 3])
  assert.equal(nextActiveNoteId(notes.map(note => note.id), 'Beta', 'ArrowDown'), 'Zulu-pin')
})

test('query title priority still overrides created/flat sorting without adding date headers', () => {
  const notes = [note('body-match', { text: 'launch' }), note('old-title', { title: 'Launch' })]
  for (const dateBasis of ['created', 'none'] as const) {
    const rows = buildNoteListRows(notes, { query: 'launch', dateBasis })
    assert.ok(rows.every(row => row.kind === 'note'))
    assert.deepEqual(rows.filter(row => row.kind === 'note').map(row => row.note.id), ['old-title', 'body-match'])
  }
})

test('selection activation toggles a batch note exactly once without opening or changing its identity', () => {
  const target = note('target')
  const opened: Note[] = [], toggled: Note[] = []
  const options = { onSelect: (note: Note) => opened.push(note), onToggleSelection: (note: Note) => toggled.push(note) }
  activateNoteListItem(target, { ...options, selectMode: true })
  assert.deepEqual(toggled, [target])
  assert.deepEqual(opened, [])
  activateNoteListItem(target, { onSelect: options.onSelect, selectMode: true })
  assert.deepEqual(opened, [], 'an unavailable selection handler must not fall through to open')
  activateNoteListItem(target, options)
  assert.deepEqual(opened, [target])
  assert.equal(toggled[0], opened[0])
})

test('an empty search names the folder or Trash that does hold matches', () => {
  const notes = [
    note('a', { title: '周会纪要', folderId: 'work' }),
    note('b', { title: '采购', text: '周会前买咖啡', folderId: 'life' }),
    note('c', { title: '旧周会', deletedAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }),
    note('d', { title: '无关' }),
  ]
  assert.equal(noteMatchesQuery(notes[1]!, ' 周会 '), true, 'body text matches and the query is trimmed')
  assert.equal(noteMatchesQuery(notes[3]!, '周会'), false)
  assert.equal(noteMatchesQuery(notes[3]!, '   '), true, 'a blank query hides nothing')
  // Searching inside an unrelated folder: other folders and Trash both hold matches.
  assert.deepEqual(searchElsewhere(notes, '周会', { trash: false, folderFiltered: true }), { otherFolders: 2, otherView: 1 })
  // Without a folder filter only Trash can be offered.
  assert.deepEqual(searchElsewhere(notes, '周会', { trash: false, folderFiltered: false }), { otherFolders: 0, otherView: 1 })
  // From Trash, the notes views are the other scope.
  assert.deepEqual(searchElsewhere(notes, '咖啡', { trash: true, folderFiltered: false }), { otherFolders: 0, otherView: 1 })
  assert.deepEqual(searchElsewhere(notes, '不存在', { trash: false, folderFiltered: true }), { otherFolders: 0, otherView: 0 })
  assert.deepEqual(searchElsewhere(notes, '  ', { trash: false, folderFiltered: true }), { otherFolders: 0, otherView: 0 })
})
