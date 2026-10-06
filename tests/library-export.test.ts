import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { strFromU8, unzipSync } from 'fflate'
import { exportJotLibrary, MAX_LIBRARY_EXPORT_BYTES, MAX_LIBRARY_EXPORT_NOTES, MAX_LIBRARY_PDF_NOTES, type ExportAttachment, type LibraryExportNote } from '../src/exports.js'
import { describeError } from '../src/client/errors.js'
import { JotApiError } from '../src/client/api.js'
import { createJotHandler } from '../src/http.js'
import { AttachmentStore } from '../src/attachments.js'
import { JotStore, StoreError } from '../src/store.js'
import { docFromMarkdown, docToText, type RichDoc } from '../src/model.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')
const imageId = '0123456789abcdef0123456789abcdef'
const gifId = 'abcdefabcdefabcdefabcdefabcdef12'
const files: Record<string, ExportAttachment> = {
  [imageId]: { name: '示意图.png', mimeType: 'image/png', size: png.length, data: png },
  [gifId]: { name: '动图.gif', mimeType: 'image/gif', size: gif.length, data: gif },
}
let loads = 0
const loader = async (id: string) => { loads++; return files[id]! }
const withImage = (text: string, id = imageId): RichDoc => ({ type: 'doc', content: [
  ...docFromMarkdown(text).content, { type: 'image', attrs: { attachmentId: id, alt: '' } },
] })
const note = (id: string, title: string, content: RichDoc, folderId: string | null = null): LibraryExportNote =>
  ({ id, title, content, text: docToText(content), folderId })
const invalid = (error: unknown) => error instanceof StoreError && error.code === 'INVALID_INPUT'

function library() {
  return {
    folders: [{ id: 'work', name: '工作' }, { id: 'odd', name: 'a/b:c' }],
    notes: [
      note('1', '周会', withImage('# 议程\n\n- [x] 准备'), 'work'),
      note('2', '周会', withImage('同名的第二篇'), 'work'),
      note('3', '', withImage('没有标题时用第一行\n\n第二行', gifId)),
      note('4', '奇怪的文件夹', docFromMarkdown('内容'), 'odd'),
    ],
  }
}

test('Markdown archives sort notes into folders and link shared attachments relative to each note', async () => {
  loads = 0
  const exported = await exportJotLibrary(library(), 'md', { attachmentLoader: loader, now: new Date(2026, 9, 5) })
  assert.equal(exported.filename, '随记-2026-10-05.zip')
  assert.equal(exported.contentType, 'application/zip')
  assert.deepEqual([exported.notes, exported.attachments], [4, 2])
  assert.equal(loads, 2, 'each attachment is read once although two notes share the image')
  const zip = unzipSync(exported.buffer)
  assert.deepEqual(Object.keys(zip).sort(), ['a_b_c/奇怪的文件夹.md', '工作/周会 (2).md', '工作/周会.md', '没有标题时用第一行.md', '附件/动图.gif', '附件/示意图.png'])
  const meeting = strFromU8(zip['工作/周会.md']!)
  assert.match(meeting, /^# 周会\n/u)
  assert.match(meeting, /- \[x\] 准备/u)
  assert.match(meeting, /!\[示意图\\\.png\]\(\.\.\/%E9%99%84%E4%BB%B6\/%E7%A4%BA%E6%84%8F%E5%9B%BE\.png\)/u, 'a note in a folder links one level up')
  const root = strFromU8(zip['没有标题时用第一行.md']!)
  assert.match(root, /^# 没有标题时用第一行\n/u, 'an untitled note uses its first line, as the list shows it')
  assert.match(root, /\(%E9%99%84%E4%BB%B6\/%E5%8A%A8%E5%9B%BE\.gif\)/u)
  assert.deepEqual(Buffer.from(zip['附件/示意图.png']!), png, 'original bytes are kept')
})

test('Word and PDF archives embed images and still carry every original file', async () => {
  for (const format of ['docx', 'pdf'] as const) {
    const exported = await exportJotLibrary(library(), format, { attachmentLoader: loader, locale: 'en', now: new Date(2026, 9, 5) })
    assert.equal(exported.filename, 'Jot-2026-10-05.zip')
    const zip = unzipSync(exported.buffer)
    const names = Object.keys(zip).sort()
    assert.deepEqual(names, [`a_b_c/奇怪的文件夹.${format}`, `attachments/动图.gif`, 'attachments/示意图.png',
      `没有标题时用第一行.${format}`, `工作/周会 (2).${format}`, `工作/周会.${format}`].sort())
    const document = Buffer.from(zip[`工作/周会.${format}`]!)
    if (format === 'pdf') {
      assert.equal(document.subarray(0, 5).toString('latin1'), '%PDF-')
      assert.match(document.toString('latin1'), /\/Subtype \/Image/u, 'the PNG is drawn into the PDF')
    } else {
      const parts = unzipSync(document)
      assert.ok(Object.keys(parts).some(name => name.startsWith('word/media/')), 'the PNG is embedded in the Word file')
    }
  }
})

test('library exports refuse empty, oversized and unknown requests', async () => {
  await assert.rejects(exportJotLibrary({ notes: [], folders: [] }, 'md'), invalid)
  await assert.rejects(exportJotLibrary(library(), 'txt' as never), invalid)
  const many = Array.from({ length: MAX_LIBRARY_EXPORT_NOTES + 1 }, (_, index) => note(String(index), `n${index}`, docFromMarkdown('x')))
  await assert.rejects(exportJotLibrary({ notes: many, folders: [] }, 'md'), invalid)
  const pdfMany = Array.from({ length: MAX_LIBRARY_PDF_NOTES + 1 }, (_, index) => note(String(index), `n${index}`, docFromMarkdown('x')))
  await assert.rejects(exportJotLibrary({ notes: pdfMany, folders: [] }, 'pdf'), invalid, 'PDF archives have their own, smaller cap')
  await assert.rejects(exportJotLibrary(library(), 'md', { attachmentLoader: loader, maxBytes: png.length - 1 }), invalid)
  for (const maxBytes of [0, -1, 1.5, MAX_LIBRARY_EXPORT_BYTES + 1]) {
    await assert.rejects(exportJotLibrary(library(), 'md', { maxBytes }), invalid, 'trusted options can lower, but never raise, the size cap')
  }
})

test('the archive budget counts generated notes and repeated embedded images before retaining the whole library', async () => {
  const content = withImage('Shared image')
  const notes = Array.from({ length: 12 }, (_, index) => note(String(index), `Note ${index}`, content))
  const one = await exportJotLibrary({ notes: notes.slice(0, 1), folders: [] }, 'docx', { attachmentLoader: loader })
  loads = 0
  await assert.rejects(exportJotLibrary({ notes, folders: [] }, 'docx', { attachmentLoader: loader, maxBytes: one.buffer.length * 2 }), invalid)
  assert.equal(loads, 1, 'the shared image is loaded once, but each generated Word file consumes the budget')

  const pdf = await exportJotLibrary({ notes: notes.slice(0, 1), folders: [] }, 'pdf', { attachmentLoader: loader })
  let generated = 0
  await assert.rejects(exportJotLibrary({ notes, folders: [] }, 'pdf', {
    attachmentLoader: loader, maxBytes: pdf.buffer.length * 2,
    get fontDirectory() { generated++; return undefined },
  }), invalid)
  assert.ok(generated > 0 && generated <= 3, 'the lower byte budget stops PDF generation before all twelve notes and the final ZIP')

  const text = Array.from({ length: 12 }, (_, index) => note(String(index), `Text ${index}`, docFromMarkdown('A'.repeat(1_000))))
  await assert.rejects(exportJotLibrary({ notes: text, folders: [] }, 'md', { maxBytes: 2_000 }), invalid,
    'highly compressible text still counts against the retained in-memory entries budget')
})

test('Host export and undo refusals reach the user as actionable sentences in their language', async () => {
  const host = async (run: () => Promise<unknown>) => {
    try { await run() } catch (error) { return new JotApiError(400, (error as StoreError).code, (error as Error).message) }
    assert.fail('expected a refusal')
  }
  const pdf = await host(() => exportJotLibrary({ notes: Array.from({ length: MAX_LIBRARY_PDF_NOTES + 1 },
    (_, index) => note(String(index), `n${index}`, docFromMarkdown('x'))), folders: [] }, 'pdf'))
  assert.match(describeError(pdf, 'zh'), /PDF 一次最多导出 500 篇/u)
  assert.match(describeError(pdf, 'en'), /choose Word/u)
  const empty = await host(() => exportJotLibrary({ notes: [], folders: [] }, 'md'))
  assert.equal(describeError(empty, 'zh'), '这里没有可以导出的笔记。')
  const big = await host(() => exportJotLibrary(library(), 'md', { attachmentLoader: loader, maxBytes: png.length - 1 }))
  assert.match(describeError(big, 'zh'), /200 MiB/u, 'not the single-note 50 MiB sentence')
  const undo = new JotApiError(404, 'NOT_FOUND', 'There is no agent edit to undo for this version')
  assert.equal(describeError(undo, 'zh'), '这一版已经不是 AI 修改后的版本，无法撤销。')
  assert.equal(describeError(new JotApiError(404, 'NOT_FOUND', 'Note not found'), 'zh'), '笔记或文件夹已不存在，可能已在别处删除。')
})

async function server(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-jot-export-'))
  const store = new JotStore({ directory })
  const attachments = new AttachmentStore({ directory })
  const handler = createServer(createJotHandler(store, { attachments, authorize: (_request: IncomingMessage) => undefined }))
  await new Promise<void>(resolve => { handler.listen(0, '127.0.0.1', resolve) })
  const address = handler.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    handler.closeAllConnections(); await new Promise<void>(resolve => { handler.close(() => resolve()) })
    await rm(directory, { recursive: true, force: true })
  })
  const post = (body: unknown) => fetch(`${base}/jot/api/export-library`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { store, attachments, post }
}

test('HTTP library export scopes to a folder or unfiled notes, never includes Trash and reports counts', async t => {
  const { store, attachments, post } = await server(t)
  const folder = await store.createFolder('项目')
  const image = await attachments.upload({ name: '图.png', mimeType: 'image/png', bytes: png })
  const filed = await store.createNote({ title: '在文件夹里', folderId: folder.id, content: withImage('正文', image.id) })
  await store.createNote({ title: '未分类' })
  const trashed = await store.createNote({ title: '回收站' })
  await store.deleteNote(trashed.id, trashed.revision)

  const all = await post({ format: 'md', locale: 'zh' })
  assert.equal(all.status, 200)
  assert.equal(all.headers.get('x-jot-export-notes'), '2')
  assert.equal(all.headers.get('x-jot-export-attachments'), '1')
  assert.match(all.headers.get('content-disposition')!, /filename\*=UTF-8''/u)
  const names = Object.keys(unzipSync(new Uint8Array(await all.arrayBuffer()))).sort()
  assert.deepEqual(names, ['未分类.md', '附件/图.png', '项目/在文件夹里.md'].sort())

  const one = await post({ format: 'docx', folderId: folder.id })
  assert.equal(one.headers.get('x-jot-export-notes'), '1')
  assert.ok(Object.keys(unzipSync(new Uint8Array(await one.arrayBuffer()))).includes('项目/在文件夹里.docx'))
  const unfiled = await post({ format: 'md', folderId: null })
  assert.equal(unfiled.headers.get('x-jot-export-notes'), '1')
  await unfiled.arrayBuffer()

  assert.equal((await post({ format: 'txt' })).status, 400)
  assert.equal((await post({ format: 'md', folderId: '../x' })).status, 400)
  assert.equal((await post({ format: 'md', extra: true })).status, 400)
  assert.equal((await post({ format: 'md', maxBytes: MAX_LIBRARY_EXPORT_BYTES + 1 })).status, 400, 'HTTP callers cannot change the host byte limit')
  const empty = await post({ format: 'md', folderId: 'missing-folder' })
  assert.equal(empty.status, 400, 'an empty scope explains itself instead of downloading nothing')
  assert.ok(filed.id)
})
