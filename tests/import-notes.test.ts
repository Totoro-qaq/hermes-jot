import assert from 'node:assert/strict'
import { test } from 'node:test'
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
})

test('unsupported or oversized files are refused before upload', () => {
  assert.equal(importFileProblem({ name: 'a.md', size: 10 }, 'en'), null)
  assert.equal(importFileProblem({ name: 'B.MARKDOWN', size: 10 }, 'en'), null)
  assert.equal(importFileProblem({ name: 'c.txt', size: IMPORT_MAX_BYTES }, 'en'), null)
  assert.equal(importFileProblem({ name: 'd.zip', size: 10 }, 'en'), null)
  assert.match(importFileProblem({ name: 'e.pdf', size: 10 }, 'en')!, /Markdown, text or ZIP/)
  assert.match(importFileProblem({ name: 'f.zip', size: IMPORT_MAX_BYTES + 1 }, 'zh')!, /超过 100 MB/)
})
