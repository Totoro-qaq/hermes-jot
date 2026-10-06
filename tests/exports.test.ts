import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { strFromU8, unzipSync } from 'fflate'
import {
  exportJotNote, MAX_EXPORT_ATTACHMENTS, MAX_EXPORT_BYTES,
  type ExportAttachment, type ExportFormat,
} from '../src/exports.js'
import { docFromText, type RichDoc, type RichNode } from '../src/model.js'

const text = (value: string, marks?: RichNode['marks']): RichNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content })
const id = '0123456789abcdef0123456789abcdef'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
const image: RichNode = { type: 'image', attrs: { attachmentId: id, alt: '说明图' } }
const loader = async (): Promise<ExportAttachment> => ({ name: '例图.png', mimeType: 'image/png', size: png.length, data: png })
const cell = (type: 'tableCell' | 'tableHeader', value: string, attrs = {}): RichNode => ({
  type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs }, content: [paragraph(text(value))],
})
function fixture(): RichDoc {
  return { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('讨论重点')] },
    paragraph(text('保留中文与粗体', [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' },
      { type: 'textStyle', attrs: { color: '#2563eb' } }, { type: 'highlight', attrs: { color: '#fef08a' } }]),
    { type: 'hardBreak' }, text('<script>alert(1)</script> [外部]', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }])),
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph(text('第三步'))] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('完成项'))] },
      { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text('待完成项'))] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', '名|称'), cell('tableHeader', '状态')] },
      { type: 'tableRow', content: [cell('tableCell', '设计'), cell('tableCell', '确认')] }] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [text('const fence = "```";\n<script>literal</script>')] },
  ] }
}

/** Decode PDFKit's bounded Flate streams for font CMaps/content inspection. */
function pdfStreams(buffer: Buffer): string[] {
  const raw = buffer.toString('latin1'), result: string[] = []
  const matcher = /<<[^]*?>>\s*stream\r?\n/gu
  let match: RegExpExecArray | null
  while ((match = matcher.exec(raw))) {
    const start = matcher.lastIndex, end = raw.indexOf('\nendstream', start)
    if (end < 0) break
    const bytes = buffer.subarray(start, end)
    try { result.push((match[0].includes('/FlateDecode') ? inflateSync(bytes) : bytes).toString('latin1')) } catch { /* unrelated binary image streams */ }
    matcher.lastIndex = end + 10
  }
  return result
}

test('TXT exports current draft meaning, checklist state and table contents without changing its input', async () => {
  const content = fixture(), before = structuredClone(content)
  const result = await exportJotNote({ title: '../会议:讨论', content }, 'txt')
  assert.equal(result.filename, '_会议_讨论.txt')
  assert.match(result.contentType, /^text\/plain/u)
  const output = result.buffer.toString('utf8')
  assert.match(output, /保留中文与粗体\n<script>/u)
  assert.match(output, /3\. 第三步/u)
  assert.match(output, /\[x\] 完成项/u)
  assert.match(output, /\[ \] 待完成项/u)
  assert.match(output, /名\|称\t状态\n设计\t确认/u)
  assert.deepEqual(content, before)
})

test('Markdown escapes user text, preserves styles and uses GFM checklists/tables and safe code fences', async () => {
  const result = await exportJotNote({ title: '会议 #1', content: fixture() }, 'md')
  assert.equal(result.filename, '会议 #1.md')
  const output = result.buffer.toString('utf8')
  assert.match(output, /^# 会议 \\#1/u)
  assert.match(output, /<u>/u)
  assert.match(output, /color:#2563eb/u)
  assert.match(output, /background-color:#fef08a/u)
  assert.match(output, /&lt;script&gt;alert\\\(1\\\)&lt;\/script&gt;/u)
  assert.match(output, /- \[x\] 完成项/u)
  assert.match(output, /\| 名\\\|称 \| 状态 \|/u)
  assert.match(output, /````js\nconst fence = "```";/u)
})

test('Markdown with managed files becomes an offline ZIP with safe local asset links', async () => {
  const fileId = 'abcdefabcdefabcdefabcdefabcdefab'
  const body: RichDoc = { type: 'doc', content: [image, { type: 'attachment', attrs: { attachmentId: fileId, caption: '规格文件' } }] }
  const result = await exportJotNote({ title: '附件讨论', content: body }, 'md', { attachmentLoader: async attachmentId =>
    attachmentId === id ? loader() : { name: '../../规格.pdf', mimeType: 'application/pdf', size: 3, data: Buffer.from('PDF') } })
  assert.equal(result.filename, '附件讨论.zip')
  assert.equal(result.contentType, 'application/zip')
  const entries = unzipSync(result.buffer)
  assert.equal(Object.keys(entries).length, 3)
  for (const name of Object.keys(entries)) assert.equal(name.includes('../'), false)
  assert.deepEqual(Buffer.from(entries[`assets/${id}-例图.png`]!), png)
  const md = strFromU8(entries['note.md']!)
  assert.match(md, /!\[说明图\]\(assets\//u)
  assert.match(md, /\[规格文件\]\(assets\//u)
  assert.doesNotMatch(md, /\/jot\/api|https?:\/\//u)
})

test('DOCX uses real runs, numbering, tables, line breaks and embedded PNG media', async () => {
  const content = fixture(); content.content.push(image)
  const result = await exportJotNote({ title: 'Word讨论', content }, 'docx', { attachmentLoader: loader })
  assert.equal(result.filename, 'Word讨论.docx')
  const entries = unzipSync(result.buffer)
  const xml = strFromU8(entries['word/document.xml']!)
  assert.match(xml, /保留中文与粗体/u)
  assert.match(xml, /<w:b\/>/u)
  assert.match(xml, /<w:i\/>/u)
  assert.match(xml, /<w:u w:val="single"/u)
  assert.match(xml, /w:color w:val="2563eb"/u)
  assert.match(xml, /w:fill="fef08a"/iu)
  assert.match(xml, /<w:br\/>/u)
  assert.match(xml, /<w:tbl>/u)
  assert.match(xml, /☒/u)
  assert.match(xml, /&lt;script&gt;/u)
  assert.doesNotMatch(xml, /<script>/u)
  assert.match(strFromU8(entries['word/numbering.xml']!), /w:start w:val="3"/u)
  assert.ok(Object.keys(entries).some(name => name.startsWith('word/media/') && name.endsWith('.png')))
})

test('merged table spans remain represented in Markdown HTML and DOCX vertical merges', async () => {
  const content: RichDoc = { type: 'doc', content: [{ type: 'table', content: [
    { type: 'tableRow', content: [cell('tableCell', '跨行', { rowspan: 2 }), cell('tableCell', '右一')] },
    { type: 'tableRow', content: [cell('tableCell', '右二')] },
    { type: 'tableRow', content: [cell('tableCell', '跨列', { colspan: 2, align: 'center' })] },
  ] }] }
  const md = await exportJotNote({ title: '合并表格', content }, 'md')
  assert.match(md.buffer.toString(), /rowspan="2"/u)
  assert.match(md.buffer.toString(), /colspan="2"/u)
  const word = await exportJotNote({ title: '合并表格', content }, 'docx')
  const xml = strFromU8(unzipSync(word.buffer)['word/document.xml']!)
  assert.match(xml, /w:vMerge w:val="restart"/u)
  assert.match(xml, /w:vMerge w:val="continue"/u)
  assert.match(xml, /w:gridSpan w:val="2"/u)
  assert.match(xml, /w:jc w:val="center"/u)
})

test('table inline code cannot inject an extra GFM column', async () => {
  const coded = cell('tableCell', 'placeholder')
  coded.content = [paragraph(text('left|right', [{ type: 'code' }]))]
  const content: RichDoc = { type: 'doc', content: [{ type: 'table', content: [
    { type: 'tableRow', content: [cell('tableHeader', 'Code'), cell('tableHeader', 'Meaning')] },
    { type: 'tableRow', content: [coded, cell('tableCell', 'literal')] },
  ] }] }
  const result = await exportJotNote({ title: 'Code table', content }, 'md')
  assert.match(result.buffer.toString(), /` left\\\|right `/u)
})

test('images inside merged cells remain accessible in the offline Markdown archive and embedded in PDF', async () => {
  const merged = cell('tableCell', '图片在合并单元格', { colspan: 2 })
  merged.content!.push(image)
  const content: RichDoc = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [merged] }] }] }
  const md = await exportJotNote({ title: '表内图片', content }, 'md', { attachmentLoader: loader })
  assert.match(strFromU8(unzipSync(md.buffer)['note.md']!), /<img src="assets\//u)
  const pdf = await exportJotNote({ title: '表内图片', content }, 'pdf', { attachmentLoader: loader })
  assert.match(pdf.buffer.toString('latin1'), /\/Subtype \/Image/u)
})

test('Chinese PDF embeds the bundled fonts and PNG rather than depending on device fonts', async () => {
  const content = fixture(); content.content.push(image)
  const result = await exportJotNote({ title: '中文会议记录', content }, 'pdf', { attachmentLoader: loader })
  assert.equal(result.filename, '中文会议记录.pdf')
  assert.equal(result.contentType, 'application/pdf')
  assert.equal(result.buffer.subarray(0, 5).toString(), '%PDF-')
  const raw = result.buffer.toString('latin1')
  assert.match(raw, /\/FontFile[23] /u)
  assert.match(raw, /\/ToUnicode /u)
  assert.match(raw, /\/Subtype \/Image/u)
  assert.ok(pdfStreams(result.buffer).some(stream => stream.includes('4e2d')), 'Chinese 中 has an embedded Unicode mapping')
})

test('PDF paginates a long table and a tall cell while preserving its final Chinese glyph', async () => {
  const rows: RichNode[] = [{ type: 'tableRow', content: [cell('tableHeader', '编号'), cell('tableHeader', '讨论内容')] }]
  for (let index = 0; index < 60; index++) rows.push({ type: 'tableRow', content: [cell('tableCell', String(index)),
    cell('tableCell', index === 59 ? `${'长单元格讨论内容。'.repeat(2_000)}尾` : `第${index}项讨论`)] })
  const result = await exportJotNote({ title: '长表格', content: { type: 'doc', content: [{ type: 'table', content: rows }] } }, 'pdf')
  assert.ok((result.buffer.toString('latin1').match(/\/Type \/Page\b/gu) ?? []).length > 3)
  assert.ok(pdfStreams(result.buffer).some(stream => stream.includes('5c3e')), 'the last 尾 glyph remains in the PDF font mapping')
})

test('PDF task states use two vector boxes and one check path instead of missing checkbox font glyphs', async () => {
  const content: RichDoc = { type: 'doc', content: [{ type: 'taskList', content: [
    { type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('已完成'))] },
    { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text('待完成'))] },
  ] }] }
  const result = await exportJotNote({ title: '待办导出', content }, 'pdf')
  const streams = pdfStreams(result.buffer).filter(stream => /\/F\d+ [\d.]+ Tf/u.test(stream))
  const drawing = streams.join('\n')
  assert.equal((drawing.match(/\b8\.5 8\.5 re\b/gu) ?? []).length, 2, 'both states have real stroked boxes')
  assert.equal((drawing.match(/\b1\.1 w\b/gu) ?? []).length, 1, 'only the checked task adds a vector check path')
})

test('short PDF table rows stay intact, do not leave a blank bordered continuation, and receive bounded footers', async () => {
  const rows = Array.from({ length: 50 }, (_, index): RichNode => ({ type: 'tableRow',
    content: [cell('tableCell', String(index + 1)), cell('tableCell', '讨论内容继续确认产品要求。')],
  }))
  const result = await exportJotNote({ title: '普通短行分页', content: { type: 'doc', content: [{ type: 'table', content: rows }] } }, 'pdf')
  const streams = pdfStreams(result.buffer).filter(stream => /\/F\d+ [\d.]+ Tf/u.test(stream))
  const pageCount = (result.buffer.toString('latin1').match(/\/Type \/Page\b/gu) ?? []).length
  assert.ok(pageCount >= 2)
  assert.equal(streams.length, pageCount, 'each physical page has a body content stream')
  for (const stream of streams) {
    const beforeFirstText = stream.slice(0, stream.indexOf('BT\n'))
    // Every row in this fixture starts with its nonempty number cell. Two or
    // more boxes before its first text would expose an empty continuation band.
    assert.ok((beforeFirstText.match(/\bre\b/gu) ?? []).length <= 1, 'a new page starts with a real row, not empty table borders')
    const footers = [...stream.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s*\/F\d+ 8 Tf/gu)]
    assert.equal(footers.length, 1, 'one page number per physical page, without creating another page')
    assert.ok(Number(footers[0]![2]) > 0 && Number(footers[0]![2]) < 48, 'footer stays below the reserved body margin')
  }
})

test('unsupported inline image formats retain a named attachment hint in printable exports', async () => {
  const binary = Buffer.from('GIF89a')
  const result = await exportJotNote({ title: '动图', content: { type: 'doc', content: [image] } }, 'docx', {
    attachmentLoader: async () => ({ name: 'animation.gif', mimeType: 'image/gif', size: binary.length, data: binary }),
  })
  const entries = unzipSync(result.buffer)
  assert.match(strFromU8(entries['word/document.xml']!), /animation\.gif/u)
  assert.equal(Object.keys(entries).some(name => name.startsWith('word/media/') && name.endsWith('.gif')), false)
})

test('export rejects unsafe rich data, excess attachments, mismatched binary metadata and size overflow', async () => {
  await assert.rejects(exportJotNote({ title: 'Unsafe', content: { type: 'doc', content: [{ type: 'image', attrs: { src: '/etc/passwd' } }] } }, 'md'), /Unsupported attachment/u)
  await assert.rejects(exportJotNote({ title: 'Unknown', content: docFromText('body') }, 'html' as ExportFormat), /Unsupported export/u)
  const images = Array.from({ length: MAX_EXPORT_ATTACHMENTS + 1 }, (_, index): RichNode => ({ type: 'image', attrs: { attachmentId: index.toString(16).padStart(32, '0') } }))
  await assert.rejects(exportJotNote({ title: 'Many', content: { type: 'doc', content: images } }, 'md'), /at most 100/u)
  await assert.rejects(exportJotNote({ title: 'Mismatch', content: { type: 'doc', content: [image] } }, 'md', {
    attachmentLoader: async () => ({ name: 'file', mimeType: 'application/octet-stream', size: 1, data: Buffer.alloc(0) }),
  }), /Invalid export attachment/u)
  const large = Buffer.alloc(MAX_EXPORT_BYTES + 1)
  await assert.rejects(exportJotNote({ title: 'Large', content: { type: 'doc', content: [image] } }, 'md', {
    attachmentLoader: async () => ({ name: 'file', mimeType: 'application/octet-stream', size: large.length, data: large }),
  }), /exceed 50 MiB/u)
})
