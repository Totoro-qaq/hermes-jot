import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { importNotesFile, markdownToNote, resolveArchivePath, titleStem, type ImportExtension } from '../src/markdown-import.js'
import { exportJotLibrary } from '../src/exports.js'
import { AttachmentStore } from '../src/attachments.js'
import { JotStore, StoreError } from '../src/store.js'
import { validateRichDoc, type RichDoc, type RichMark, type RichNode } from '../src/model.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwS8AAAAASUVORK5CYII=', 'base64')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const placeholder = 'a'.repeat(32)
const invalid = (error: unknown) => error instanceof StoreError && error.code === 'INVALID_INPUT'
const convert = (source: string, files: Record<string, string> = {}) =>
  markdownToNote(source, { fallbackTitle: 'file-name', resolveFile: href => files[href] ?? null })
const blocks = (source: string, files: Record<string, string> = {}) => convert(source, files).content.content
const t = (text: string, ...marks: RichMark[]): RichNode => marks.length ? { type: 'text', text, marks } : { type: 'text', text }
const p = (...content: RichNode[]): RichNode => content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
const cell = (type: 'tableCell' | 'tableHeader', content: RichNode[], align: string | null = null): RichNode =>
  ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, align }, content })
const bold: RichMark = { type: 'bold' }
const link = (href: string): RichMark => ({ type: 'link', attrs: { href } })

async function stores(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jot-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: new JotStore({ directory }), attachments: new AttachmentStore({ directory }) }
}
const manifest = async (directory: string): Promise<{ attachments: Array<{ id: string }> }> => {
  try { return JSON.parse(await readFile(join(directory, 'attachments', 'manifest.json'), 'utf8')) }
  catch { return { attachments: [] } }
}
const run = (context: { store: JotStore; attachments: AttachmentStore }, bytes: Uint8Array, extension: ImportExtension,
  filename = `upload.${extension}`, folderId: string | null = null) =>
  importNotesFile(context.store, context.attachments, { bytes, filename, extension, folderId })

test('an Obsidian-style note keeps its structure: front matter, wikilinks, nested lists, tasks, tables and colors', () => {
  const note = convert(`---
title: 不会成为标题
tags: [会议, 2026]
---
# 周会 **纪要**

见 [[项目计划]] 和 ![[草图.png]]，以及 [官网](https://example.com/a?b=1) 与 [脚本](javascript:alert(1))。
<span style="color:#dc2626">红色</span> <span style="background-color: rgb(254, 240, 138)">高亮</span> <span style="color:#123456">非调色板</span> <u>下划线</u>

- 第一层
  - 第二层
    1. 有序
- [ ] 混合列表保持普通列表

* [ ] 待办
* [x] 完成
* [X] 也完成

| 名称 | 数量 |
| :--- | ---: |
| 苹果 | 3 |
| 梨 |
`)
  assert.equal(note.title, '周会 纪要', 'a leading H1 becomes the plain-text title and leaves the body')
  const [paragraph, list, tasks, table, ...rest] = note.content.content
  assert.equal(rest.length, 0)
  assert.deepEqual(paragraph, p(
    t('见 [[项目计划]] 和 ![[草图.png]]，以及 '), t('官网', link('https://example.com/a?b=1')), t(' 与 脚本。'), { type: 'hardBreak' },
    t('红色', { type: 'textStyle', attrs: { color: '#dc2626' } }), t(' '), t('高亮', { type: 'highlight', attrs: { color: '#fef08a' } }),
    t(' 非调色板 '), t('下划线', { type: 'underline' }),
  ), 'front matter is removed, wikilinks stay literal and an unsafe link keeps only its text')
  assert.deepEqual(list, { type: 'bulletList', content: [
    { type: 'listItem', content: [p(t('第一层')), { type: 'bulletList', content: [
      { type: 'listItem', content: [p(t('第二层')), { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('有序'))] }] }] },
    ] }] },
    { type: 'listItem', content: [p(t('[ ] 混合列表保持普通列表'))] },
  ] })
  assert.deepEqual(tasks, { type: 'taskList', content: [
    { type: 'taskItem', attrs: { checked: false }, content: [p(t('待办'))] },
    { type: 'taskItem', attrs: { checked: true }, content: [p(t('完成'))] },
    { type: 'taskItem', attrs: { checked: true }, content: [p(t('也完成'))] },
  ] })
  assert.deepEqual(table, { type: 'table', content: [
    { type: 'tableRow', content: [cell('tableHeader', [p(t('名称'))], 'left'), cell('tableHeader', [p(t('数量'))], 'right')] },
    { type: 'tableRow', content: [cell('tableCell', [p(t('苹果'))], 'left'), cell('tableCell', [p(t('3'))], 'right')] },
    { type: 'tableRow', content: [cell('tableCell', [p(t('梨'))], 'left'), cell('tableCell', [p()], 'right')] },
  ] }, 'a short row is padded to a rectangle')
})

test('titles come from a leading H1 or the file name, and empty input is one empty paragraph', () => {
  assert.deepEqual(convert(''), { title: 'file-name', content: { type: 'doc', content: [p()] } })
  assert.deepEqual(convert('# Only'), { title: 'Only', content: { type: 'doc', content: [p()] } })
  assert.deepEqual(convert('Intro\n\n# Later'), { title: 'file-name', content: { type: 'doc', content: [p(t('Intro')), { type: 'heading', attrs: { level: 1 }, content: [t('Later')] }] } })
  assert.equal(convert('## Second level\n\ntext').title, 'file-name')
  assert.equal(convert(`# ${'长'.repeat(300)}`).title.length, 240)
  assert.equal(convert('#   \n\nbody').title, 'file-name', 'an empty H1 still leaves the body')
  assert.equal(convert('Title\n===\n\nbody').title, 'Title', 'a setext H1 is an H1')
  assert.equal(titleStem('a/b/周报.Markdown'), '周报')
  assert.equal(titleStem('notes.txt'), 'notes')
  assert.equal(titleStem('archive.tar'), 'archive.tar')
  assert.equal(convert('\ufeff# BOM').title, 'BOM')
})

test('inline formatting merges equal marks and keeps only safe links and palette colors', () => {
  assert.deepEqual(blocks('**a**<span>**b**</span> *c* ~~d~~ `e` [f **g**](mailto:x@example.com) [h](tel:+1) [i](#top) [j](ftp://x) [k](/root) [l](data:text/html,hi)'), [p(
    t('ab', bold), t(' '), t('c', { type: 'italic' }), t(' '), t('d', { type: 'strike' }), t(' '), t('e', { type: 'code' }), t(' '),
    t('f ', link('mailto:x@example.com')), t('g', bold, link('mailto:x@example.com')), t(' '), t('h', link('tel:+1')), t(' '), t('i', link('#top')), t(' j k l'),
  )])
  assert.deepEqual(blocks('line one\nline two  \nthree<br>four<br/>five'), [p(t('line one'), { type: 'hardBreak' }, t('line two'), { type: 'hardBreak' },
    t('three'), { type: 'hardBreak' }, t('four'), { type: 'hardBreak' }, t('five'))])
  assert.deepEqual(blocks('<b>kept</b> <script>x</script> <span style="color:#2563EB"><u>both</u></span> <span style="color:red">no</span> <span title="x">plain</span>'), [p(
    t('kept x '), t('both', { type: 'underline' }, { type: 'textStyle', attrs: { color: '#2563eb' } }), t(' no plain'),
  )], 'other tags are dropped but their text stays')
  assert.deepEqual(blocks('<span style="color:#dc2626">red <span style="color:#16a34a">green</span> red</span>'), [p(
    t('red ', { type: 'textStyle', attrs: { color: '#dc2626' } }), t('green', { type: 'textStyle', attrs: { color: '#16a34a' } }), t(' red', { type: 'textStyle', attrs: { color: '#dc2626' } }),
  )], 'the innermost color wins')
  assert.deepEqual(blocks('**`code` text**'), [p(t('code', bold, { type: 'code' }), t(' text', bold))])
  assert.deepEqual(blocks('&amp; &lt;tag&gt; \\*literal\\*'), [p(t('& <tag> *literal*'))])
})

test('blocks: headings, quotes, code languages, rules, HTML blocks and wide tables', () => {
  assert.deepEqual(blocks('### Three\n\n> quoted\n>\n> > nested\n\n---\n\n```c++ extra\nint x;\n```\n\n```{.python}\npass\n```\n\n    indented\n\n```\n```'), [
    { type: 'heading', attrs: { level: 3 }, content: [t('Three')] },
    { type: 'blockquote', content: [p(t('quoted')), { type: 'blockquote', content: [p(t('nested'))] }] },
    { type: 'horizontalRule' },
    { type: 'codeBlock', attrs: { language: 'c++' }, content: [t('int x;')] },
    { type: 'codeBlock', attrs: { language: null }, content: [t('pass')] },
    { type: 'codeBlock', attrs: { language: null }, content: [t('indented')] },
    { type: 'codeBlock', attrs: { language: null } },
  ])
  assert.deepEqual(blocks('<div class="x">\n<p>One &amp; <b>two</b></p>\n<script>alert(1)</script>\n<p>Three</p>\n</div>'), [p(t('One & two')), p(t('Three'))])
  const wide = `| ${Array.from({ length: 51 }, (_, index) => `c${index}`).join(' | ')} |\n|${' --- |'.repeat(51)}\n| ${Array.from({ length: 51 }, (_, index) => `v${index}`).join(' | ')} |`
  const rows = blocks(wide)
  assert.equal(rows.length, 2, 'a table wider than 50 columns becomes one paragraph per row')
  assert.equal((rows[1]!.content![0] as RichNode).text, Array.from({ length: 51 }, (_, index) => `v${index}`).join(' | '))
  const tall = `| h |\n| - |\n${Array.from({ length: 200 }, (_, index) => `| r${index} |`).join('\n')}`
  assert.equal(blocks(tall).length, 201, 'more than 200 rows also become paragraphs')
  assert.equal(blocks(`| h |\n| - |\n${Array.from({ length: 199 }, (_, index) => `| r${index} |`).join('\n')}`)[0]!.type, 'table')
  assert.deepEqual(blocks('|  |  |\n| --- | --- |\n| a | b |'), [{ type: 'table', content: [
    { type: 'tableRow', content: [cell('tableCell', [p(t('a'))]), cell('tableCell', [p(t('b'))])] },
  ] }], 'the blank header Jot writes for a header-less table is not imported as a row')
  assert.deepEqual(blocks('- ```\n  x\n  ```\n-\n- > q'), [{ type: 'bulletList', content: [
    { type: 'listItem', content: [p(), { type: 'codeBlock', attrs: { language: null }, content: [t('x')] }] },
    { type: 'listItem', content: [p()] },
    { type: 'listItem', content: [p(), { type: 'blockquote', content: [p(t('q'))] }] },
  ] }], 'list items always begin with a paragraph')
  assert.deepEqual(blocks('7. a\n8. b\n\n0) zero'), [
    { type: 'orderedList', attrs: { start: 7 }, content: [{ type: 'listItem', content: [p(t('a'))] }, { type: 'listItem', content: [p(t('b'))] }] },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('zero'))] }] },
  ])
})

test('images and file links become attachments only when they name a file in the import', () => {
  const files = { 'img/a.png': placeholder, 'docs/r.pdf': 'b'.repeat(32) }
  assert.deepEqual(blocks('![Diagram](img/a.png)\n\n[Report **Q3**](docs/r.pdf)\n\n![missing](img/none.png)\n\n![](img/%E5%9B%BE.png)\n\n![remote](https://cdn.example/x.png)\n\nText ![inline](img/a.png) and [link](docs/r.pdf).\n\n[a](docs/r.pdf) [b](docs/r.pdf)', files), [
    { type: 'image', attrs: { attachmentId: placeholder, alt: 'Diagram' } },
    { type: 'attachment', attrs: { attachmentId: 'b'.repeat(32), caption: 'Report Q3' } },
    p(t('missing')),
    p(t('图.png')),
    p(t('remote', link('https://cdn.example/x.png'))),
    p(t('Text inline and link.')),
    p(t('a b')),
  ])
  assert.deepEqual(blocks('| ![cell](img/a.png) |\n| --- |', files)[0]!.content![0]!.content![0]!.content, [{ type: 'image', attrs: { attachmentId: placeholder, alt: 'cell' } }])
})

test('archive links resolve relative to the note and never above the archive root', () => {
  assert.equal(resolveArchivePath('../附件/a%20b.png', '工作'), '附件/a b.png')
  assert.equal(resolveArchivePath('./img/x.png?raw=1#frag', 'a/b'), 'a/b/img/x.png')
  assert.equal(resolveArchivePath('..\\x.png', 'a'), 'x.png')
  assert.equal(resolveArchivePath('../../x.png', 'a'), null)
  assert.equal(resolveArchivePath('../x.png', ''), null)
  for (const href of ['/etc/passwd', 'https://x/y.png', 'C:/x.png', 'file:///x', '#a', '%E0%A4%A', '']) assert.equal(resolveArchivePath(href, 'a'), null, href)
})

test('documents beyond Jot limits are refused', () => {
  assert.throws(() => convert('>'.repeat(40) + ' deep'), invalid)
  assert.throws(() => convert('x'.repeat(200_001)), invalid)
})

/** Structure with attachment ids replaced by the bytes they reference, for comparing two libraries. */
async function comparable(doc: RichDoc, files: AttachmentStore): Promise<unknown> {
  const visit = async (node: RichNode): Promise<RichNode> => {
    if (node.type === 'image' || node.type === 'attachment') {
      const { bytes, attachment } = await files.content(String(node.attrs!.attachmentId))
      return { ...node, attrs: { ...node.attrs, attachmentId: `${attachment.name}:${bytes.toString('base64')}` } }
    }
    return node.content ? { ...node, content: await Promise.all(node.content.map(visit)) } : node
  }
  return { type: 'doc', content: await Promise.all(doc.content.map(visit)) }
}

test('a Markdown library export imports back with titles, folders, structure and attachment bytes', async ctx => {
  const source = await stores(ctx)
  const image = await source.attachments.upload({ name: '示意图.png', bytes: png })
  const report = await source.attachments.upload({ name: '季度报告.pdf', bytes: pdf })
  const data = await source.attachments.upload({ name: 'data 1.csv', mimeType: 'text/csv', bytes: Buffer.from('a,b\n1,2\n') })
  const work = await source.store.createFolder('工作')
  const personal = await source.store.createFolder('个人')
  const header = (text: string) => cell('tableHeader', [p(t(text))])
  const body = (text: string) => cell('tableCell', [p(t(text))])
  const rich = validateRichDoc({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('议程 Agenda')] },
    p(t('普通 '), t('粗体', bold), t(' '), t('斜体', { type: 'italic' }), t(' '), t('删除', { type: 'strike' }), t(' '),
      t('下划线', { type: 'underline' }), t(' '), t('code', { type: 'code' }), t(' '), t('链接', link('https://example.com/a?q=1&x=2')), t(' '),
      t('红色', { type: 'textStyle', attrs: { color: '#dc2626' } }), t(' '), t('高亮', { type: 'highlight', attrs: { color: '#bbf7d0' } }),
      { type: 'hardBreak' }, t('第二行 1. 不是列表 #不是标题')),
    { type: 'bulletList', content: [
      { type: 'listItem', content: [p(t('一级')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('二级'))] }] }] },
      { type: 'listItem', content: [p(t('另一项'))] },
    ] },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('三'))] }, { type: 'listItem', content: [p(t('四'))] }] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [p(t('完成'))] },
      { type: 'taskItem', attrs: { checked: false }, content: [p(t('未完成'))] },
    ] },
    { type: 'blockquote', content: [p(t('引用'))] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1\nconsole.log(`${a}`)')] },
    { type: 'horizontalRule' },
    { type: 'table', content: [{ type: 'tableRow', content: [header('名称'), header('Amount')] }, { type: 'tableRow', content: [body('苹果'), body('3 | 4')] }] },
    { type: 'image', attrs: { attachmentId: image.id, alt: '示意图' } },
    { type: 'attachment', attrs: { attachmentId: report.id, caption: '季度报告' } },
    { type: 'attachment', attrs: { attachmentId: data.id, caption: '数据' } },
  ] })
  const plain = validateRichDoc({ type: 'doc', content: [p(t('根目录的笔记')), { type: 'image', attrs: { attachmentId: image.id, alt: '同一张图' } }] })
  const headerless = validateRichDoc({ type: 'doc', content: [{ type: 'table', content: [
    { type: 'tableRow', content: [body('x'), body('y')] }, { type: 'tableRow', content: [body('1'), body('2')] },
  ] }] })
  await source.store.createNote({ title: '周会纪要', folderId: work.id, content: rich })
  await source.store.createNote({ title: 'Root 笔记', content: plain })
  await source.store.createNote({ title: '没有表头', folderId: personal.id, content: headerless })
  const state = await source.store.readState()
  const exported = await exportJotLibrary({ notes: state.notes, folders: state.folders }, 'md', {
    attachmentLoader: async id => {
      const { attachment, bytes } = await source.attachments.content(id)
      return { name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, data: bytes }
    },
  })

  const target = await stores(ctx)
  const existing = await target.store.createFolder('个人')
  const result = await run(target, exported.buffer, 'zip', exported.filename)
  assert.deepEqual({ ...result, noteIds: result.noteIds.length }, { notes: 3, attachments: 3, folders: 1, noteIds: 3, skipped: [] },
    'the shared image is uploaded once and the existing folder is reused')
  const imported = await target.store.readState()
  assert.deepEqual(imported.folders.map(folder => folder.name).sort(), ['个人', '工作'])
  for (const original of state.notes) {
    const copy = imported.notes.find(note => note.title === original.title)
    assert.ok(copy, original.title)
    const folder = imported.folders.find(item => item.id === copy.folderId)?.name ?? null
    assert.equal(folder, state.folders.find(item => item.id === original.folderId)?.name ?? null)
    assert.deepEqual(await comparable(copy.content, target.attachments), await comparable(original.content, source.attachments), original.title)
  }
  assert.equal(imported.notes.find(note => note.title === '没有表头')!.folderId, existing.id)
  const images = imported.notes.flatMap(note => note.content.content.filter(node => node.type === 'image').map(node => node.attrs!.attachmentId))
  assert.equal(new Set(images).size, 1, 'both notes reference one imported image')
  assert.equal((await manifest(target.directory)).attachments.length, 3)
})

test('a single Jot note export with attachments imports from its ZIP', async ctx => {
  const target = await stores(ctx)
  const zip = zipSync({ 'note.md': strToU8('# 单篇导出\n\n![图](assets/0123-%E5%9B%BE.png)\n\n正文'), 'assets/0123-图.png': png })
  const result = await run(target, zip, 'zip', '单篇导出.zip')
  assert.equal(result.notes, 1)
  const [note] = (await target.store.readState()).notes
  assert.equal(note!.title, '单篇导出')
  assert.equal(note!.folderId, null, 'only notes inside a top-level directory are filed')
  assert.equal(note!.content.content[0]!.type, 'image')
  assert.deepEqual((await target.attachments.content(String(note!.content.content[0]!.attrs!.attachmentId))).bytes, png)
})

test('ZIP imports skip unsafe and unsupported entries and flatten deeper directories', async ctx => {
  const target = await stores(ctx)
  const requested = await target.store.createFolder('Inbox')
  await target.store.createFolder('PROJECTS')
  const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const zip = zipSync({
    'root.md': strToU8('Root note ![logo](logo.svg) [same](./logo.svg)\n\n[Logo file](logo.svg)'),
    'plain.txt': strToU8('第一行\n# not a heading'),
    'projects/a.md': strToU8('# A\n\n![shot](img/shot.png)\n\n![shot again](./img/shot.png)\n\n[escape](../../outside.png)'),
    'projects/deep/b.markdown': strToU8('# B\n\n[back](../img/shot.png)'),
    'projects/img/shot.png': png,
    'projects/unused.png': png,
    'logo.svg': svg,
    'bad.md': new Uint8Array([0xc3, 0x28]),
    'huge.md': strToU8(`${'word '.repeat(50_000)}`),
    '__MACOSX/._root.md': strToU8('junk'),
    '.obsidian/app.json': strToU8('{}'),
    'projects/.hidden.md': strToU8('# hidden'),
    'notes/': new Uint8Array(),
  })
  const result = await run(target, zip, 'zip', 'vault.zip', requested.id)
  assert.equal(result.notes, 4)
  assert.equal(result.attachments, 2, 'shot.png and logo.svg are uploaded once each')
  assert.equal(result.folders, 0, 'the projects directory reuses the existing PROJECTS folder')
  assert.deepEqual(result.skipped.map(item => item.path).sort(), ['bad.md', 'huge.md', 'projects/unused.png'])
  assert.match(result.skipped.find(item => item.path === 'bad.md')!.reason, /UTF-8/u)
  assert.match(result.skipped.find(item => item.path === 'huge.md')!.reason, /too large/u)
  const state = await target.store.readState()
  const byTitle = (title: string) => state.notes.find(note => note.title === title)!
  const projects = state.folders.find(folder => folder.name === 'PROJECTS')!
  assert.equal(byTitle('root').folderId, requested.id)
  assert.equal(byTitle('plain').folderId, requested.id)
  assert.equal(byTitle('A').folderId, projects.id)
  assert.equal(byTitle('B').folderId, projects.id, 'deeper directories flatten into their top-level folder')
  assert.deepEqual(byTitle('plain').content.content, [p(t('第一行')), p(t('# not a heading'))], '.txt files are plain text')
  const a = byTitle('A').content.content
  assert.equal(a[0]!.type, 'image')
  assert.equal(a[0]!.attrs!.attachmentId, a[1]!.attrs!.attachmentId)
  assert.deepEqual(a[2], p(t('escape')), 'a link above the archive root is plain text')
  assert.equal(byTitle('B').content.content[0]!.type, 'attachment')
  assert.equal(byTitle('B').content.content[0]!.attrs!.attachmentId, a[0]!.attrs!.attachmentId)
  const [text, card] = byTitle('root').content.content
  assert.deepEqual(text, p(t('Root note logo same')), 'inline images and links are text')
  assert.deepEqual([card!.type, card!.attrs!.caption], ['attachment', 'Logo file'])
  assert.deepEqual(result.noteIds, ['plain', 'A', 'B', 'root'].map(title => byTitle(title).id), 'notes are created in path order')
})

test('a standalone SVG "image" is kept as a file card, not an inline image', async ctx => {
  const target = await stores(ctx)
  const zip = zipSync({ 'n.md': strToU8('![Logo](logo.svg)'), 'logo.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>') })
  await run(target, zip, 'zip')
  const [node] = (await target.store.readState()).notes[0]!.content.content
  assert.equal(node!.type, 'attachment')
  assert.equal(node!.attrs!.caption, 'Logo')
  assert.equal((await target.attachments.get(String(node!.attrs!.attachmentId))).kind, 'file')
})

test('single Markdown and text files import with the file name as a fallback title', async ctx => {
  const target = await stores(ctx)
  const md = await run(target, strToU8('Body with ![pic](pic.png)'), 'md', 'D:\\notes\\会议记录.md')
  assert.deepEqual(md.skipped, [])
  const txt = await run(target, strToU8('\ufeffline 1\r\nline 2'), 'txt', 'plain.txt')
  const state = await target.store.readState()
  assert.deepEqual(state.notes.find(note => note.id === md.noteIds[0])!.title, '会议记录')
  assert.deepEqual(state.notes.find(note => note.id === md.noteIds[0])!.content.content, [p(t('Body with pic'))])
  assert.deepEqual(state.notes.find(note => note.id === txt.noteIds[0])!.content.content, [p(t('line 1')), p(t('line 2'))])
  const bad = await run(target, new Uint8Array([0xff, 0xfe, 0x00]), 'md', 'bad.md')
  assert.deepEqual(bad, { notes: 0, attachments: 0, folders: 0, noteIds: [], skipped: [{ path: 'bad.md', reason: 'The file is not UTF-8 text.' }] })
  await assert.rejects(run(target, strToU8('x'), 'md', 'x.md', 'missing-folder'), (error: unknown) => error instanceof StoreError && error.code === 'NOT_FOUND')
})

/** Rewrite every central-directory uncompressed size, so the declared size differs from the data. */
function declareSize(zip: Uint8Array, size: number): Uint8Array {
  const copy = new Uint8Array(zip)
  const view = new DataView(copy.buffer)
  for (let offset = 0; offset + 46 <= copy.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, size, true)
  }
  return copy
}

test('archive-wide limits fail before anything is saved or uploaded', async ctx => {
  const target = await stores(ctx)
  const many = (count: number, extension: string) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`n/${index}.${extension}`, strToU8('x')]))
  const before = await target.store.readState()
  await assert.rejects(run(target, zipSync(many(2_001, 'md')), 'zip'), (error: unknown) => invalid(error) && /2,000 notes/u.test((error as Error).message))
  const links = Array.from({ length: 1_001 }, (_, index) => `![a](f/${index}.png)`).join('\n\n')
  await assert.rejects(run(target, zipSync({ 'n.md': strToU8(links), ...Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`f/${index}.png`, png])) }), 'zip'),
    (error: unknown) => invalid(error) && /1,000 attachments/u.test((error as Error).message))
  await assert.rejects(run(target, declareSize(zipSync(many(26, 'md'), { level: 0 }), 4 * 1_048_576), 'zip'),
    (error: unknown) => invalid(error) && /100 MiB/u.test((error as Error).message))
  const twoNotes = zipSync({ 'a.md': strToU8('a'.repeat(1_000)), 'b.md': strToU8('b'.repeat(1_000)) })
  for (const size of [999, 1_001]) {
    await assert.rejects(run(target, declareSize(twoNotes, size), 'zip'), (error: unknown) => invalid(error) && /damaged/u.test((error as Error).message),
      'inflated sizes and CRCs must match the central directory')
  }
  const corrupt = zipSync({ 'a.md': strToU8('original text') }, { level: 0 })
  corrupt.set(strToU8('altered'), corrupt.indexOf(strToU8('original')[0]!, 30))
  await assert.rejects(run(target, corrupt, 'zip'), (error: unknown) => invalid(error) && /damaged/u.test((error as Error).message))
  await assert.rejects(run(target, strToU8('not a zip'), 'zip'), invalid)
  await assert.rejects(run(target, new Uint8Array(100 * 1_048_576 + 1), 'md'), invalid)
  assert.deepEqual(await target.store.readState(), before)
  assert.equal((await manifest(target.directory)).attachments.length, 0)
})

test('an unsafe archive entry name is reported and never resolved', async ctx => {
  const target = await stores(ctx)
  const zip = zipSync({ 'ok.md': strToU8('[x](evil.png)'), 'aa/../evil.png': png, '/abs.md': strToU8('abs') })
  const result = await run(target, zip, 'zip')
  assert.equal(result.notes, 1)
  assert.deepEqual(result.skipped.map(item => item.reason), ['Unsafe path in the archive.', 'Unsafe path in the archive.'])
  assert.equal(result.attachments, 0)
})

test('files linked only from skipped notes are not uploaded, and long skip lists are summarized', async ctx => {
  const target = await stores(ctx)
  const zip = zipSync({
    'good.md': strToU8('fine'),
    'bad.md': strToU8(`![pic](pic.png)\n\n${'x'.repeat(200_001)}`),
    'pic.png': png,
    ...Object.fromEntries(Array.from({ length: 1_005 }, (_, index) => [`extra/${index}.bin`, strToU8('x')])),
  })
  const result = await run(target, zip, 'zip')
  assert.deepEqual([result.notes, result.attachments], [1, 0])
  assert.equal(result.skipped.length, 1_001)
  assert.equal(result.skipped[0]!.path, 'bad.md')
  assert.ok(result.skipped.some(item => item.path === 'pic.png'))
  assert.deepEqual(result.skipped.at(-1), { path: '…', reason: '7 more files were skipped.' })
  assert.equal((await manifest(target.directory)).attachments.length, 0)
})
