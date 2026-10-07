import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JotApiError } from '../src/client/api.js'
import { describeError } from '../src/client/errors.js'
import { IMPORT_MAX_BYTES, importFileProblem, mergeImportResults, summarizeImport } from '../src/client/import-notes.js'
import type { ImportResult } from '../src/client/types.js'

const result = (notes: number, skipped: ImportResult['skipped'] = []): ImportResult =>
  ({ notes, attachments: 1, folders: 0, noteIds: Array.from({ length: notes }, (_, index) => `n${notes}-${index}`), skipped })

test('several uploads add up in order', () => {
  const merged = mergeImportResults([result(2, [{ path: 'a.png', reason: 'unsupported' }]), result(1)])
  assert.equal(merged.notes, 3)
  assert.equal(merged.attachments, 2)
  assert.deepEqual(merged.noteIds, ['n2-0', 'n2-1', 'n1-0'])
  assert.deepEqual(merged.skipped, [{ path: 'a.png', reason: 'unsupported' }])
  assert.equal(mergeImportResults([]).notes, 0)
})

test('the toast counts imported and skipped files; details list skipped paths', () => {
  assert.deepEqual(summarizeImport(result(1), 'en'), { toast: 'Imported 1 note', details: '' })
  assert.deepEqual(summarizeImport(result(3), 'zh'), { toast: '已导入 3 条笔记', details: '' })
  const skipped = Array.from({ length: 7 }, (_, index) => ({ path: `notes/${index}.pdf`, reason: 'Not Markdown' }))
  const summary = summarizeImport(result(2, skipped), 'en')
  assert.equal(summary.toast, 'Imported 2 notes · 7 skipped')
  const lines = summary.details.split('\n')
  assert.equal(lines[0], 'Skipped while importing:')
  assert.equal(lines[1], 'notes/0.pdf: Not Markdown')
  assert.equal(lines.length, 7)
  assert.equal(lines.at(-1), '…and 2 more')
  assert.equal(summarizeImport(result(0, skipped.slice(0, 1)), 'zh').toast, '已导入 0 条笔记，跳过 1 个')
  // Plural forms follow each language rather than English singular/plural.
  assert.equal(summarizeImport(result(5), 'ru').toast, 'Импортировано 5 заметок')
  assert.equal(summarizeImport(result(22), 'ru').toast, 'Импортировано 22 заметки')
  assert.equal(summarizeImport(result(1, skipped.slice(0, 1)), 'fr').toast, '1 note importée · 1 fichier ignoré')
  assert.equal(summarizeImport(result(2, skipped), 'de').details.split('\n').at(-1), '…und 2 weitere')
})

test('unsupported or oversized files are refused before upload', () => {
  assert.equal(importFileProblem({ name: 'a.md', size: 10 }, 'en'), null)
  assert.equal(importFileProblem({ name: 'B.MARKDOWN', size: 10 }, 'en'), null)
  assert.equal(importFileProblem({ name: 'c.txt', size: IMPORT_MAX_BYTES }, 'en'), null)
  assert.equal(importFileProblem({ name: 'd.zip', size: 10 }, 'en'), null)
  assert.match(importFileProblem({ name: 'e.pdf', size: 10 }, 'en')!, /Markdown, text or ZIP/)
  assert.match(importFileProblem({ name: 'f.zip', size: IMPORT_MAX_BYTES + 1 }, 'zh')!, /超过 100 MB/)
  assert.equal(importFileProblem({ name: 'g.pdf', size: 10 }, 'ja'), 'g.pdf：Markdown、テキスト、ZIP ファイルを選択してください。')
})

test('server import failures say what to change instead of a generic retry', () => {
  const failure = (code: string, message: string, locale: 'en' | 'zh' = 'en') => describeError(new JotApiError(400, code, message), locale)
  assert.equal(failure('INVALID_INPUT', 'The file is not a readable ZIP archive'), 'This ZIP file is damaged or cannot be read.')
  assert.equal(failure('INVALID_INPUT', 'The ZIP archive is damaged'), 'This ZIP file is damaged or cannot be read.')
  assert.equal(failure('INVALID_INPUT', 'A ZIP import holds at most 5,000 notes; import one folder at a time'), 'The ZIP holds too many notes. Import one folder at a time.')
  assert.equal(failure('INVALID_INPUT', 'A ZIP import links at most 10,000 attachments'), 'The ZIP links too many attachments. Import one folder at a time.')
  assert.equal(failure('INVALID_INPUT', 'The archive expands to more than 100 MiB'), 'The ZIP expands to more than 100 MB. Import one folder at a time.')
  assert.equal(failure('INVALID_INPUT', 'The ZIP archive has more than 20,000 entries'), 'The ZIP contains too many files. Import one folder at a time.')
  assert.equal(failure('INVALID_INPUT', 'Import files are limited to 100 MiB'), 'Import files are limited to 100 MB.')
  assert.equal(failure('IMPORT_TOO_LARGE', 'Imports are limited to 100 MiB.'), 'Import files are limited to 100 MB.')
  assert.equal(failure('IMPORT_TOO_LARGE', 'Imports are limited to 100 MiB.', 'zh'), '导入文件不能超过 100 MB。')
  assert.equal(failure('INVALID_INPUT', 'A ZIP import holds at most 5,000 notes; import one folder at a time', 'zh'), 'ZIP 中的笔记太多，请按文件夹分批导入。')
  // Note-size messages keep their own wording.
  assert.equal(failure('INVALID_INPUT', 'Document exceeds the byte limit'), 'This note is over the size limit. Split it into several notes.')
})

test('the toast counts files the engine left out of its skipped list', () => {
  const listed = Array.from({ length: 1_000 }, (_, index) => ({ path: `assets/${index}.bin`, reason: 'Not linked.' }))
  const summary = summarizeImport(result(4, [...listed, { path: '…', reason: '250 more files were skipped.' }]), 'en')
  assert.equal(summary.toast, 'Imported 4 notes · 1250 skipped')
  assert.ok(summary.details.endsWith('…and 1245 more'))
  assert.ok(!summary.details.includes('…: '))
})
