import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import PDFDocument from 'pdfkit'
import {
  Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer,
  AlignmentType, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, UnderlineType,
  WidthType, type IRunOptions, type ParagraphChild,
} from 'docx'
import { strToU8, zipSync } from 'fflate'
import {
  StoreError, boundedString, MAX_TITLE_LENGTH, validateAttachmentId, validateRichDoc,
  type RichDoc, type RichMark, type RichNode,
} from './model.js'

export const EXPORT_FORMATS = ['txt', 'md', 'pdf', 'docx'] as const
export type ExportFormat = typeof EXPORT_FORMATS[number]
export const MAX_EXPORT_ATTACHMENTS = 100
export const MAX_EXPORT_BYTES = 50 * 1_024 * 1_024
export interface ExportAttachment { name: string; mimeType: string; size: number; data: Buffer }
export interface ExportOptions {
  attachmentLoader?: (id: string) => Promise<ExportAttachment>
  /** Trusted host option only; never derive font paths from document content. */
  fontDirectory?: string
}
export interface NoteExport { buffer: Buffer; filename: string; contentType: string }
type Loaded = ExportAttachment & { assetPath: string; image?: { type: 'png' | 'jpg'; width: number; height: number } }
type Assets = Map<string, Loaded>
type Input = { title: string; content: RichDoc }

function invalid(message: string): never { throw new StoreError('INVALID_INPUT', message) }
function filename(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/^[.\s]+|[.\s]+$/gu, '').slice(0, 100)
  return !cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned) ? 'Untitled' : cleaned
}
function imageInfo(data: Buffer): Loaded['image'] {
  let width = 0, height = 0, type: 'png' | 'jpg'
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    type = 'png'; width = data.readUInt32BE(16); height = data.readUInt32BE(20)
  } else if (data.length > 4 && data[0] === 255 && data[1] === 216) {
    type = 'jpg'
    let position = 2
    while (position + 4 <= data.length) {
      if (data[position] !== 255) break
      while (data[position] === 255) position++
      const marker = data[position++]!
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (position + 2 > data.length) break
      const length = data.readUInt16BE(position)
      if (length < 2 || position + length > data.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = data.readUInt16BE(position + 3); width = data.readUInt16BE(position + 5); break
      }
      position += length
    }
  } else return undefined
  // Bound decoder memory even for a tiny compressed attachment with huge dimensions.
  if (!width || !height || width > 10_000 || height > 10_000 || width * height > 40_000_000) return undefined
  return { type, width, height }
}
async function loadAssets(doc: RichDoc, loader: ExportOptions['attachmentLoader']): Promise<Assets> {
  const ids = new Set<string>()
  const visit = (node: RichNode) => {
    if (node.type === 'image' || node.type === 'attachment') ids.add(validateAttachmentId(node.attrs?.attachmentId))
    for (const child of node.content ?? []) visit(child)
  }
  doc.content.forEach(visit)
  if (ids.size > MAX_EXPORT_ATTACHMENTS) invalid(`Export supports at most ${MAX_EXPORT_ATTACHMENTS} attachments`)
  const assets: Assets = new Map()
  if (!loader) return assets
  let total = 0
  for (const id of ids) {
    const value = await loader(id)
    if (!value || !Buffer.isBuffer(value.data) || !Number.isSafeInteger(value.size)
      || value.size !== value.data.length || value.size < 0 || typeof value.name !== 'string'
      || typeof value.mimeType !== 'string') invalid('Invalid export attachment')
    total += value.size
    if (total > MAX_EXPORT_BYTES) invalid('Export attachments exceed 50 MiB')
    const name = filename(value.name)
    assets.set(id, { ...value, name, assetPath: `assets/${id}-${name}`, image: imageInfo(value.data) })
  }
  return assets
}
function asset(node: RichNode, assets: Assets): Loaded | undefined {
  return assets.get(node.attrs?.attachmentId as string)
}
function attachmentLabel(node: RichNode, assets: Assets): string {
  const file = asset(node, assets)
  const description = String(node.attrs?.[node.type === 'image' ? 'alt' : 'caption'] ?? '')
  const name = file?.name ?? String(node.attrs?.attachmentId ?? '')
  return `[${node.type === 'image' ? 'Image' : 'Attachment'}: ${description && description !== name ? `${description} — ` : ''}${name}]`
}
const inlineText = (node: RichNode): string => node.type === 'text' ? node.text! : node.type === 'hardBreak' ? '\n'
  : (node.content ?? []).map(inlineText).join('')
function plainBlock(node: RichNode, assets: Assets, depth = 0): string {
  if (node.type === 'image' || node.type === 'attachment') return attachmentLabel(node, assets)
  if (node.type === 'horizontalRule') return '---'
  if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) return inlineText(node)
  if (node.type === 'table') return (node.content ?? []).map(row => (row.content ?? [])
    .map(cell => (cell.content ?? []).map(child => plainBlock(child, assets, depth)).join('\n'))
    .join('\t')).join('\n')
  if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) return (node.content ?? []).map((item, index) => {
    const prefix = node.type === 'orderedList' ? `${Number(node.attrs?.start ?? 1) + index}. `
      : node.type === 'taskList' ? item.attrs?.checked ? '[x] ' : '[ ] ' : '- '
    const body = (item.content ?? []).map(child => plainBlock(child, assets, depth + 1)).join('\n')
    return `${'  '.repeat(depth)}${prefix}${body.replace(/\n/gu, `\n${'  '.repeat(depth + 1)}`)}`
  }).join('\n')
  const text = (node.content ?? []).map(child => plainBlock(child, assets, depth)).join('\n\n')
  return node.type === 'blockquote' ? text.split('\n').map(line => `> ${line}`).join('\n') : text
}

const htmlEscape = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
const mdEscape = (text: string) => htmlEscape(text).replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&')
function markedHtml(node: RichNode): string {
  if (node.type === 'hardBreak') return '<br>'
  let text = htmlEscape(node.text ?? '')
  for (const mark of node.marks ?? []) {
    const tag = ({ bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code' } as Record<string, string>)[mark.type]
    if (tag) text = `<${tag}>${text}</${tag}>`
    else if (mark.type === 'link') text = `<a href="${htmlEscape(String(mark.attrs?.href))}">${text}</a>`
    else if (mark.attrs?.color) text = `<span style="${mark.type === 'highlight' ? 'background-color' : 'color'}:${mark.attrs.color}">${text}</span>`
  }
  return text
}
function inlineMarkdown(node: RichNode): string {
  if (node.type === 'hardBreak') return '  \n'
  let text = mdEscape(node.text ?? '')
  const marks = node.marks ?? []
  if (marks.some(mark => mark.type === 'code')) {
    const raw = node.text ?? ''
    const longest = Math.max(0, ...[...raw.matchAll(/`+/gu)].map(match => match[0].length))
    const fence = '`'.repeat(longest + 1)
    text = `${fence} ${raw.replace(/\n/gu, ' ')} ${fence}`
  }
  for (const mark of marks) {
    if (mark.type === 'bold') text = `**${text}**`
    else if (mark.type === 'italic') text = `*${text}*`
    else if (mark.type === 'strike') text = `~~${text}~~`
    else if (mark.type === 'underline') text = `<u>${text}</u>`
    else if (mark.type === 'link') text = `[${text}](<${String(mark.attrs?.href).replace(/</gu, '%3C').replace(/>/gu, '%3E')}>)`
    else if (mark.attrs?.color) text = `<span style="${mark.type === 'highlight' ? 'background-color' : 'color'}:${mark.attrs.color}">${text}</span>`
  }
  return text
}
function htmlBlock(node: RichNode, assets: Assets): string {
  if (node.type === 'paragraph' || node.type === 'heading') {
    const tag = node.type === 'heading' ? `h${node.attrs?.level}` : 'p'
    return `<${tag}>${(node.content ?? []).map(markedHtml).join('')}</${tag}>`
  }
  if (node.type === 'codeBlock') return `<pre><code>${htmlEscape(inlineText(node))}</code></pre>`
  if (node.type === 'horizontalRule') return '<hr>'
  if (node.type === 'image' || node.type === 'attachment') {
    const file = asset(node, assets)
    if (!file) return htmlEscape(attachmentLabel(node, assets))
    const url = file.assetPath.split('/').map(encodeURIComponent).join('/')
    const label = String(node.attrs?.[node.type === 'image' ? 'alt' : 'caption'] ?? '') || file.name
    return node.type === 'image' ? `<img src="${url}" alt="${htmlEscape(label)}">`
      : `<a href="${url}">${htmlEscape(label)}</a>`
  }
  if (node.type === 'table') return `<table>\n${(node.content ?? []).map(row => `<tr>${(row.content ?? []).map(cell => {
    const tag = cell.type === 'tableHeader' ? 'th' : 'td'
    const alignment = cell.attrs?.align ? ` style="text-align:${cell.attrs.align}"` : ''
    return `<${tag} colspan="${cell.attrs?.colspan}" rowspan="${cell.attrs?.rowspan}"${alignment}>${(cell.content ?? []).map(child => htmlBlock(child, assets)).join('')}</${tag}>`
  }).join('')}</tr>`).join('\n')}\n</table>`
  if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) {
    const tag = node.type === 'orderedList' ? 'ol' : 'ul'
    return `<${tag}${node.type === 'orderedList' ? ` start="${node.attrs?.start ?? 1}"` : ''}>${(node.content ?? []).map(item =>
      `<li>${node.type === 'taskList' ? item.attrs?.checked ? '☒ ' : '☐ ' : ''}${(item.content ?? []).map(child => htmlBlock(child, assets)).join('')}</li>`).join('')}</${tag}>`
  }
  const body = (node.content ?? []).map(child => htmlBlock(child, assets)).join('')
  return node.type === 'blockquote' ? `<blockquote>${body}</blockquote>` : body
}
function markdownBlock(node: RichNode, assets: Assets): string {
  const inline = () => (node.content ?? []).map(inlineMarkdown).join('')
  if (node.type === 'paragraph') return inline()
  if (node.type === 'heading') return `${'#'.repeat(Number(node.attrs?.level))} ${inline()}`
  if (node.type === 'horizontalRule') return '---'
  if (node.type === 'codeBlock') {
    const raw = inlineText(node)
    const fence = '`'.repeat(Math.max(3, 1 + Math.max(0, ...[...raw.matchAll(/`+/gu)].map(match => match[0].length))))
    const language = String(node.attrs?.language ?? '')
    return `${fence}${/^[a-zA-Z0-9_+-]*$/u.test(language) ? language : ''}\n${raw}\n${fence}`
  }
  if (node.type === 'image' || node.type === 'attachment') {
    const file = asset(node, assets)
    if (!file) return mdEscape(attachmentLabel(node, assets))
    const description = String(node.attrs?.[node.type === 'image' ? 'alt' : 'caption'] ?? '') || file.name
    return `${node.type === 'image' ? '!' : ''}[${mdEscape(description)}](${file.assetPath.split('/').map(encodeURIComponent).join('/')})`
  }
  if (node.type === 'table') {
    const rows = node.content ?? []
    if (rows.some(row => row.content?.some(cell => cell.attrs?.colspan !== 1 || cell.attrs?.rowspan !== 1))) {
      // GFM cannot express merged cells; generated HTML preserves spans safely.
      return htmlBlock(node, assets)
    }
    const values = rows.map(row => (row.content ?? []).map(cell => (cell.content ?? []).map(child => markdownBlock(child, assets)).join('<br>')
      .replace(/\r?\n/gu, '<br>').replace(/\\*\|/gu, value => value.length % 2 === 1 ? `\\${value}` : value)))
    const hasHeader = rows[0]?.content?.every(cell => cell.type === 'tableHeader')
    const header = hasHeader ? values.shift()! : values[0]!.map(() => '')
    return [header, header.map(() => '---'), ...values].map(row => `| ${row.join(' | ')} |`).join('\n')
  }
  if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) return (node.content ?? []).map((item, index) => {
    const prefix = node.type === 'orderedList' ? `${Number(node.attrs?.start ?? 1) + index}. `
      : node.type === 'taskList' ? item.attrs?.checked ? '- [x] ' : '- [ ] ' : '- '
    const body = (item.content ?? []).map(child => markdownBlock(child, assets)).join('\n\n')
    return `${prefix}${body.replace(/\n/gu, '\n    ')}`
  }).join('\n')
  const body = (node.content ?? []).map(child => markdownBlock(child, assets)).join('\n\n')
  return node.type === 'blockquote' ? body.split('\n').map(line => `> ${line}`).join('\n') : body
}

function markOptions(marks: RichMark[] = []): IRunOptions {
  const options: IRunOptions = { font: { name: 'Noto Sans SC', eastAsia: 'Noto Sans SC' } }
  return marks.reduce<IRunOptions>((result, mark) => {
    if (mark.type === 'bold') return { ...result, bold: true }
    if (mark.type === 'italic') return { ...result, italics: true }
    if (mark.type === 'underline') return { ...result, underline: { type: UnderlineType.SINGLE } }
    if (mark.type === 'strike') return { ...result, strike: true }
    if (mark.type === 'code') return { ...result, font: { name: 'Consolas', eastAsia: 'Noto Sans SC' } }
    if (mark.attrs?.color && mark.type === 'textStyle') return { ...result, color: String(mark.attrs.color).slice(1) }
    if (mark.attrs?.color && mark.type === 'highlight') return { ...result, shading: { type: ShadingType.CLEAR, fill: String(mark.attrs.color).slice(1) } }
    return result
  }, options)
}
function docxInline(node: RichNode): ParagraphChild[] {
  if (node.type === 'hardBreak') return [new TextRun({ break: 1 })]
  const run = new TextRun({ text: node.text ?? '', ...markOptions(node.marks) })
  const link = node.marks?.find(mark => mark.type === 'link')
  return [link ? new ExternalHyperlink({ link: String(link.attrs?.href), children: [run] }) : run]
}
async function wordDocument(input: Input, assets: Assets): Promise<Buffer> {
  let counter = 0
  const numbering: { reference: string; levels: { level: number; format: typeof LevelFormat.DECIMAL; text: string; start: number }[] }[] = []
  const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
  const blocks = (nodes: RichNode[], depth = 0): (Paragraph | Table)[] => nodes.flatMap(node => {
    if (node.type === 'table') return [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: (node.content ?? []).map(row => new TableRow({
        // Allow Word to split a tall row instead of clipping its content.
        tableHeader: row.content?.every(cell => cell.type === 'tableHeader'),
        children: (row.content ?? []).map(cell => {
          const aligned = cell.attrs?.align as 'left' | 'center' | 'right' | 'justify' | null
          const children = aligned ? (cell.content ?? []).flatMap(child => {
            if (child.type !== 'paragraph' && child.type !== 'heading') return blocks([child], depth)
            return [new Paragraph({ children: (child.content ?? []).flatMap(docxInline),
              alignment: aligned === 'justify' ? AlignmentType.JUSTIFIED : aligned,
              spacing: { after: 120 },
            })]
          }) : blocks(cell.content ?? [], depth)
          if (!(children.at(-1) instanceof Paragraph)) children.push(new Paragraph({}))
          return new TableCell({ children, columnSpan: Number(cell.attrs?.colspan), rowSpan: Number(cell.attrs?.rowspan),
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            ...(cell.type === 'tableHeader' ? { shading: { fill: 'F1F5F9', type: ShadingType.CLEAR } } : {}),
          })
        }),
      })),
    }), new Paragraph({ spacing: { after: 80 } })]
    if (node.type === 'image' || node.type === 'attachment') {
      const file = asset(node, assets)
      if (node.type === 'image' && file?.image) {
        const scale = Math.min(1, 480 / file.image.width, 600 / file.image.height)
        return [new Paragraph({ children: [new ImageRun({ data: file.data, type: file.image.type,
          transformation: { width: Math.max(1, Math.round(file.image.width * scale)), height: Math.max(1, Math.round(file.image.height * scale)) },
          altText: { title: file.name, description: String(node.attrs?.alt ?? ''), name: file.name },
        })] }), new Paragraph({ children: [new TextRun({ text: attachmentLabel(node, assets), size: 18 })] })]
      }
      return [new Paragraph({ children: [new TextRun(attachmentLabel(node, assets))] })]
    }
    if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) {
      let reference: string | undefined
      if (node.type === 'orderedList') {
        reference = `jot-ordered-${counter++}`
        numbering.push({ reference, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', start: Number(node.attrs?.start ?? 1) }] })
      }
      return (node.content ?? []).flatMap(item => {
        const first = item.content?.[0]
        const prefix = node.type === 'taskList' ? [new TextRun(item.attrs?.checked ? '☒ ' : '☐ ')] : []
        return [new Paragraph({ children: [...prefix, ...(first?.content ?? []).flatMap(docxInline)],
          spacing: { after: 80 }, indent: { left: 360 * (depth + 1), hanging: 180 },
          ...(reference ? { numbering: { reference, level: 0 } } : node.type === 'bulletList' ? { bullet: { level: Math.min(depth, 8) } } : {}),
        }), ...blocks(item.content?.slice(1) ?? [], depth + 1)]
      })
    }
    if (node.type === 'blockquote') return blocks(node.content ?? [], depth + 1)
    if (node.type === 'horizontalRule') return [new Paragraph({ border: { bottom: { color: 'CBD5E1', size: 6, style: 'single' } } })]
    return [new Paragraph({ children: (node.content ?? []).flatMap(docxInline), spacing: { after: 120 },
      ...(depth ? { indent: { left: depth * 360 } } : {}),
      ...(node.type === 'heading' ? { heading: heading[Number(node.attrs?.level) - 1] } : {}),
      ...(node.type === 'codeBlock' ? { shading: { fill: 'F1F5F9', type: ShadingType.CLEAR }, run: { font: 'Consolas' } } : {}),
    })]
  })
  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(input.title || 'Untitled')] }), ...blocks(input.content.content)]
  return Packer.toBuffer(new Document({ title: input.title, creator: 'Jot', numbering: { config: numbering },
    styles: { default: { document: { run: { font: { name: 'Noto Sans SC', eastAsia: 'Noto Sans SC' }, size: 22 }, paragraph: { spacing: { line: 300 } } } } },
    sections: [{ properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } }, children }],
  }))
}

interface PdfRun { text: string; marks?: RichMark[] }
interface PdfFragment extends PdfRun { width: number }
interface PdfLine { fragments: PdfFragment[] }
async function pdfDocument(input: Input, assets: Assets, fontDirectory?: string): Promise<Buffer> {
  const fonts = fontDirectory ?? fileURLToPath(new URL('../assets/fonts/', import.meta.url))
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: input.title, Creator: 'Jot' } })
  const stream = doc as unknown as Readable
  const chunks: Buffer[] = []
  let bytes = 0
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_EXPORT_BYTES) { stream.destroy(new StoreError('INVALID_INPUT', 'Export exceeds 50 MiB')); return }
      chunks.push(chunk)
    })
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  // Attach a rejection handler before synchronous layout to avoid unhandled stream errors.
  void finished.catch(() => {})
  try {
    doc.registerFont('jot-regular', path.join(fonts, 'NotoSansSC-Regular.otf'))
    doc.registerFont('jot-bold', path.join(fonts, 'NotoSansSC-Bold.otf'))
    const left = 48, width = doc.page.width - 96
    const bottom = () => doc.page.height - 48
    const font = (marks: RichMark[] = []) => marks.some(mark => mark.type === 'bold') ? 'jot-bold' : 'jot-regular'
    const cache = new Map<string, number>()
    const wrap = (runs: PdfRun[], available: number, size: number): PdfLine[] => {
      const lines: PdfLine[] = []
      let fragments: PdfFragment[] = [], occupied = 0
      let pending: string[] = [], pendingMarks: RichMark[] | undefined, pendingWidth = 0
      const flushFragment = () => {
        if (pending.length) fragments.push({ text: pending.join(''), marks: pendingMarks, width: pendingWidth })
        pending = []; pendingWidth = 0
      }
      const flushLine = () => { flushFragment(); lines.push({ fragments }); fragments = []; occupied = 0 }
      for (const run of runs) {
        flushFragment(); pendingMarks = run.marks
        for (const char of run.text) {
          if (char === '\r') continue
          if (char === '\n') { flushLine(); continue }
          const expanded = char === '\t' ? '    ' : char
          const key = `${font(run.marks)}:${size}:${expanded}`
          let advance = cache.get(key)
          if (advance === undefined) {
            doc.font(font(run.marks)).fontSize(size)
            advance = doc.widthOfString(expanded); cache.set(key, advance)
          }
          if (occupied + advance > available && occupied > 0) flushLine()
          pending.push(expanded); pendingWidth += advance; occupied += advance
        }
      }
      // A paragraph's terminating newline closes its last line. It does not
      // create another empty line that can become a blank table continuation.
      if (pending.length || fragments.length || !lines.length) flushLine()
      return lines
    }
    const renderLine = (line: PdfLine, x: number, y: number, size: number) => {
      for (const fragment of line.fragments) {
        const marks = fragment.marks ?? []
        const color = marks.find(mark => mark.type === 'textStyle')?.attrs?.color as string | undefined
        const highlight = marks.find(mark => mark.type === 'highlight')?.attrs?.color as string | undefined
        doc.font(font(marks)).fontSize(size)
        if (highlight) doc.save().fillColor(highlight).rect(x, y, fragment.width, size * 1.45).fill().restore()
        doc.fillColor(color || '#111827').text(fragment.text, x, y, { lineBreak: false,
          oblique: marks.some(mark => mark.type === 'italic'),
        })
        // PDFKit's automatic decorations require its wrapping metadata. We own
        // line layout, so use public vector/link APIs with explicit dimensions.
        for (const [mark, baseline] of [['underline', 1.22], ['strike', 0.75]] as const) {
          if (marks.some(value => value.type === mark)) doc.save().strokeColor(color || '#111827').lineWidth(0.6)
            .moveTo(x, y + size * baseline).lineTo(x + fragment.width, y + size * baseline).stroke().restore()
        }
        const link = marks.find(mark => mark.type === 'link')
        if (link) doc.link(x, y, fragment.width, size * 1.5, String(link.attrs?.href))
        x += fragment.width
      }
    }
    const ensure = (height: number) => { if (doc.y + height > bottom()) { doc.addPage(); doc.y = 48 } }
    const write = (runs: PdfRun[], size = 10.5, indent = 0, after = 7, checkbox?: boolean) => {
      const lineHeight = size * 1.5
      const textIndent = indent + (checkbox === undefined ? 0 : 15)
      let first = true
      for (const line of wrap(runs, Math.max(24, width - textIndent), size)) {
        ensure(lineHeight)
        const y = doc.y
        if (first && checkbox !== undefined) {
          // The bundled Chinese font has no dependable checkbox glyphs.
          // Public vector paths preserve checked/unchecked state on every OS.
          const x = left + indent, top = y + 3, edge = 8.5
          doc.save().lineWidth(0.8).strokeColor('#626a75').rect(x, top, edge, edge).stroke()
          if (checkbox) doc.lineWidth(1.1).strokeColor('#2563eb').moveTo(x + 1.7, top + 4.4)
            .lineTo(x + 3.5, top + 6.3).lineTo(x + 7, top + 2).stroke()
          doc.restore()
        }
        renderLine(line, left + textIndent, y, size); doc.y = y + lineHeight; first = false
      }
      doc.y += after
    }
    const runs = (node: RichNode): PdfRun[] => node.type === 'text' ? [{ text: node.text ?? '', marks: node.marks }]
      : node.type === 'hardBreak' ? [{ text: '\n' }] : (node.content ?? []).flatMap(runs)
    const cellRuns = (node: RichNode): PdfRun[] => {
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') return [...runs(node), { text: '\n' }]
      if (node.type === 'image' || node.type === 'attachment') return [{ text: attachmentLabel(node, assets) + '\n' }]
      if (node.type === 'horizontalRule') return [{ text: '---\n' }]
      return (node.content ?? []).flatMap(cellRuns)
    }
    const renderAttachment = (node: RichNode, indent: number) => {
      const file = asset(node, assets)
      if (node.type === 'image' && file?.image) {
        const scale = Math.min(1, Math.max(24, width - indent) / file.image.width, 380 / file.image.height)
        const imageWidth = file.image.width * scale, imageHeight = file.image.height * scale
        ensure(imageHeight + 10)
        const y = doc.y
        try { doc.image(file.data, left + indent, y, { width: imageWidth, height: imageHeight }); doc.y = y + imageHeight + 6 }
        catch { doc.y = y; write([{ text: '[Image could not be decoded]' }], 10, indent) }
      }
      write([{ text: attachmentLabel(node, assets) }], 9.5, indent)
    }
    const tableImageAppendix = (node: RichNode, indent: number) => {
      const images: RichNode[] = []
      const visit = (child: RichNode) => { if (child.type === 'image') images.push(child); (child.content ?? []).forEach(visit) }
      ;(node.content ?? []).forEach(visit)
      // Tall table cells remain text-paginated; their images follow the table
      // with their original description instead of disappearing from the PDF.
      for (const image of images) renderAttachment(image, indent)
    }
    const renderTable = (node: RichNode, indent: number) => {
      const rows = node.content ?? []
      type Cell = { node: RichNode; row: number; column: number; rowspan: number; colspan: number; lines: PdfLine[] }
      const grid: Cell[][] = rows.map(() => [])
      const cells: Cell[] = []
      let columns = 0
      rows.forEach((row, index) => {
        let column = 0
        for (const node of row.content ?? []) {
          while (grid[index]![column]) column++
          const cell: Cell = { node, row: index, column, rowspan: Number(node.attrs?.rowspan), colspan: Number(node.attrs?.colspan), lines: [] }
          for (let r = index; r < index + cell.rowspan; r++) for (let c = column; c < column + cell.colspan; c++) grid[r]![c] = cell
          cells.push(cell); column += cell.colspan; columns = Math.max(columns, column)
        }
      })
      // A 50-column document cannot stay legible on A4. Preserve every cell as
      // labeled rows for very wide tables rather than shrink text or clip values.
      if (columns > 8) {
        rows.forEach((row, index) => {
          write([{ text: `Row ${index + 1}`, marks: [{ type: 'bold' }] }], 10.5, indent, 3)
          for (const cell of cells.filter(cell => cell.row === index)) write([{ text: `Column ${cell.column + 1}: ` }, ...cellRuns(cell.node)], 10, indent + 8, 3)
        })
        tableImageAppendix(node, indent)
        return
      }
      const available = Math.max(24, width - indent), unit = available / columns
      const size = 9, lineHeight = 13.5, padding = 5
      const capacities = rows.map(() => 1)
      for (const cell of cells) {
        cell.lines = wrap((cell.node.content ?? []).flatMap(cellRuns), Math.max(8, unit * cell.colspan - padding * 2), size)
        for (let r = cell.row; r < cell.row + cell.rowspan; r++) capacities[r] = Math.max(capacities[r]!, Math.ceil(cell.lines.length / cell.rowspan))
      }
      rows.forEach((_row, rowIndex) => {
        let offset = 0
        const rowCells = [...new Set(grid[rowIndex])]
        const fullHeight = capacities[rowIndex]! * lineHeight + padding * 2
        // Keep ordinary rows intact. Only a genuinely page-tall row needs to
        // split, avoiding tiny continuation bands at the next page's top.
        if (fullHeight <= bottom() - 48) ensure(fullHeight)
        while (offset < capacities[rowIndex]!) {
          ensure(lineHeight + padding * 2)
          const count = Math.min(capacities[rowIndex]! - offset, Math.max(1, Math.floor((bottom() - doc.y - padding * 2) / lineHeight)))
          const y = doc.y, height = count * lineHeight + padding * 2
          for (const cell of rowCells) {
            const x = left + indent + cell.column * unit, cellWidth = cell.colspan * unit
            if (cell.node.type === 'tableHeader') doc.save().fillColor('#f1f5f9').rect(x, y, cellWidth, height).fill().restore()
            doc.save().lineWidth(0.5).strokeColor('#cbd5e1').rect(x, y, cellWidth, height).stroke().restore()
            const previous = capacities.slice(cell.row, rowIndex).reduce((sum, value) => sum + value, 0)
            cell.lines.slice(previous + offset, previous + offset + count).forEach((line, index) => renderLine(line, x + padding, y + padding + index * lineHeight, size))
          }
          doc.y = y + height; offset += count
          if (offset < capacities[rowIndex]!) { doc.addPage(); doc.y = 48 }
        }
      })
      doc.y += 8
      tableImageAppendix(node, indent)
    }
    const blocks = (nodes: RichNode[], indent = 0) => {
      for (const node of nodes) {
        if (node.type === 'table') { renderTable(node, indent); continue }
        if (node.type === 'image' || node.type === 'attachment') {
          renderAttachment(node, indent); continue
        }
        if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) {
          ;(node.content ?? []).forEach((item, index) => {
            const prefix = node.type === 'orderedList' ? `${Number(node.attrs?.start ?? 1) + index}. ` : node.type === 'taskList' ? '' : '• '
            write([{ text: prefix }, ...runs(item.content?.[0] ?? { type: 'paragraph' })], 10.5, indent + 12, 4,
              node.type === 'taskList' ? Boolean(item.attrs?.checked) : undefined)
            blocks(item.content?.slice(1) ?? [], indent + 18)
          }); continue
        }
        if (node.type === 'blockquote') { blocks(node.content ?? [], indent + 16); continue }
        if (node.type === 'horizontalRule') {
          ensure(12); const y = doc.y
          doc.save().strokeColor('#cbd5e1').moveTo(left + indent, y + 4).lineTo(left + width, y + 4).stroke().restore(); doc.y = y + 12; continue
        }
        const level = Number(node.attrs?.level ?? 0)
        const size = node.type === 'heading' ? [18, 16, 14, 12, 11, 10.5][level - 1]! : 10.5
        const content = runs(node).map(run => node.type === 'heading' ? { ...run, marks: [...(run.marks ?? []).filter(mark => mark.type !== 'bold'), { type: 'bold' as const }] } : run)
        write(content, size, indent + (node.type === 'codeBlock' ? 8 : 0))
      }
    }
    doc.y = 48
    write([{ text: input.title || 'Untitled', marks: [{ type: 'bold' }] }], 22, 0, 16)
    blocks(input.content.content)
    const range = doc.bufferedPageRange()
    for (let index = range.start; index < range.start + range.count; index++) {
      doc.switchToPage(index)
      const label = `${index + 1} / ${range.count}`
      doc.font('jot-regular').fontSize(8).fillColor('#9ca3af')
      doc.text(label, (doc.page.width - doc.widthOfString(label)) / 2, doc.page.height - 30, { lineBreak: false })
    }
    doc.end()
  } catch (error) {
    stream.destroy(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
  return finished
}

/** Export a detached draft without updating notes or resolving paths from its content. */
export async function exportJotNote(input: Input, format: ExportFormat, options: ExportOptions = {}): Promise<NoteExport> {
  if (!EXPORT_FORMATS.includes(format)) invalid('Unsupported export format')
  const title = boundedString(input.title, MAX_TITLE_LENGTH, 'title')
  const content = validateRichDoc(input.content)
  const validated = { title, content }
  const assets = await loadAssets(content, options.attachmentLoader)
  let buffer: Buffer, extension: string = format, contentType: string
  if (format === 'txt') {
    buffer = Buffer.from(`${title}\n\n${content.content.map(node => plainBlock(node, assets)).join('\n\n')}\n`, 'utf8')
    contentType = 'text/plain; charset=utf-8'
  } else if (format === 'md') {
    const text = `# ${mdEscape(title || 'Untitled')}\n\n${content.content.map(node => markdownBlock(node, assets)).join('\n\n')}\n`
    if (assets.size) {
      const entries: Record<string, Uint8Array> = { 'note.md': strToU8(text) }
      for (const file of assets.values()) entries[file.assetPath] = file.data
      buffer = Buffer.from(zipSync(entries, { level: 6 })); extension = 'zip'; contentType = 'application/zip'
    } else { buffer = Buffer.from(text, 'utf8'); contentType = 'text/markdown; charset=utf-8' }
  } else if (format === 'docx') {
    buffer = await wordDocument(validated, assets)
    contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  } else { buffer = await pdfDocument(validated, assets, options.fontDirectory); contentType = 'application/pdf' }
  if (buffer.length > MAX_EXPORT_BYTES) invalid('Export exceeds 50 MiB')
  return { buffer, filename: `${filename(title)}.${extension}`, contentType }
}

export const LIBRARY_EXPORT_FORMATS = ['docx', 'pdf', 'md'] as const
export type LibraryExportFormat = typeof LIBRARY_EXPORT_FORMATS[number]
/** Larger libraries export folder by folder; this bounds one request's time and memory. */
export const MAX_LIBRARY_EXPORT_NOTES = 2_000
/** Each PDF embeds its own font subset (about 40 ms and 90 KiB per note), so PDF archives are smaller. */
export const MAX_LIBRARY_PDF_NOTES = 500
export const MAX_LIBRARY_EXPORT_BYTES = 200 * 1_024 * 1_024
export interface LibraryExportNote { id: string; title: string; text: string; content: RichDoc; folderId: string | null }
export interface LibraryExport extends NoteExport { notes: number; attachments: number }
export interface LibraryExportOptions extends ExportOptions {
  locale?: 'zh' | 'en'
  now?: Date
  /** Trusted host limit, optionally lowered for constrained hosts; requests cannot raise the 200 MiB cap. */
  maxBytes?: number
}

/** The list's name for a note: its title, or its first line, as untitled notes appear in Jot. */
function displayTitle(note: LibraryExportNote, untitled: string): string {
  const firstLine = note.text.replace(/^\[(?:x| )\] /gmu, '').split('\n').find(line => line.trim())?.trim() ?? ''
  return note.title.trim() || firstLine.slice(0, 80) || untitled
}

/** Case-insensitive unique file names inside one folder: "名称", "名称 (2)", … */
function uniquePath(used: Set<string>, directory: string, base: string, extension: string): string {
  for (let count = 1; ; count++) {
    const name = `${base}${count === 1 ? '' : ` (${count})`}${extension}`
    const full = directory ? `${directory}/${name}` : name
    if (!used.has(full.toLocaleLowerCase())) { used.add(full.toLocaleLowerCase()); return full }
  }
}

/**
 * Export many notes as one ZIP: a file per note in the chosen format, inside a
 * directory per folder, plus every referenced attachment once in a shared
 * folder. Word and PDF embed PNG/JPEG images; the original files keep GIF,
 * WebP and other attachments. Markdown links to that folder.
 */
export async function exportJotLibrary(input: { notes: readonly LibraryExportNote[]; folders: readonly { id: string; name: string }[] },
  format: LibraryExportFormat, options: LibraryExportOptions = {}): Promise<LibraryExport> {
  if (!LIBRARY_EXPORT_FORMATS.includes(format)) invalid('Unsupported export format')
  const en = options.locale === 'en'
  if (!input.notes.length) invalid('There are no notes to export')
  if (input.notes.length > MAX_LIBRARY_EXPORT_NOTES) invalid(`Export at most ${MAX_LIBRARY_EXPORT_NOTES} notes at once; export one folder at a time`)
  if (format === 'pdf' && input.notes.length > MAX_LIBRARY_PDF_NOTES) {
    invalid(`Export at most ${MAX_LIBRARY_PDF_NOTES} notes as PDF at once; export one folder at a time or choose Word`)
  }
  const maxBytes = options.maxBytes ?? MAX_LIBRARY_EXPORT_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LIBRARY_EXPORT_BYTES) invalid('Invalid library export size limit')
  const notes = input.notes.map(note => ({ ...note, content: validateRichDoc(note.content) }))
  const used = new Set<string>()
  const folders = new Map<string, string>()
  for (const folder of input.folders) folders.set(folder.id, uniquePath(used, '', filename(folder.name), ''))
  const attachmentDirectory = uniquePath(used, '', en ? 'attachments' : '附件', '')

  // Every attachment is read once, however many notes use it.
  const ids = new Set<string>()
  const visit = (node: RichNode) => {
    if (node.type === 'image' || node.type === 'attachment') ids.add(validateAttachmentId(node.attrs?.attachmentId))
    for (const child of node.content ?? []) visit(child)
  }
  for (const note of notes) note.content.content.forEach(visit)
  const assets: Assets = new Map()
  let total = 0
  if (options.attachmentLoader) for (const id of ids) {
    const value = await options.attachmentLoader(id)
    if (!value || !Buffer.isBuffer(value.data) || value.size !== value.data.length || typeof value.name !== 'string'
      || typeof value.mimeType !== 'string') invalid('Invalid export attachment')
    total += value.size
    if (total > maxBytes) invalid('Attachments exceed 200 MiB; export one folder at a time')
    const name = filename(value.name)
    const dot = name.lastIndexOf('.')
    const assetPath = uniquePath(used, attachmentDirectory, dot > 0 ? name.slice(0, dot) : name, dot > 0 ? name.slice(dot) : '')
    assets.set(id, { ...value, name, assetPath, image: imageInfo(value.data) })
  }

  // Already-compressed files are stored, not deflated again.
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}
  let archiveBytes = 22 // End-of-central-directory record.
  const addEntry = (path: string, data: Uint8Array, compressed: boolean) => {
    // Bound retained entry bytes before building the ZIP. Counting ZIP headers
    // and conservative deflate overhead also prevents many duplicated embedded
    // images from allocating an enormous archive before the final size check.
    archiveBytes += data.byteLength + 76 + Buffer.byteLength(path, 'utf8') * 2
      + (compressed ? Math.ceil(data.byteLength / 1_000) * 5 + 128 : 0)
    if (archiveBytes > maxBytes) invalid('The export exceeds 200 MiB; export one folder at a time')
    entries[path] = compressed ? data : [data, { level: 0 }]
  }
  for (const file of assets.values()) addEntry(file.assetPath, file.data, false)
  const untitled = en ? 'Untitled' : '无标题'
  for (const note of notes) {
    const directory = note.folderId ? folders.get(note.folderId) ?? '' : ''
    const title = displayTitle(note, untitled)
    const path = uniquePath(used, directory, filename(title), `.${format}`)
    const document = { title, content: note.content }
    if (format === 'md') {
      // Links are relative to the note's own folder.
      const local: Assets = directory ? new Map([...assets].map(([id, file]) => [id, { ...file, assetPath: `../${file.assetPath}` }])) : assets
      addEntry(path, strToU8(`# ${mdEscape(title)}\n\n${note.content.content.map(node => markdownBlock(node, local)).join('\n\n')}\n`), true)
    } else {
      const data = format === 'docx' ? await wordDocument(document, assets) : await pdfDocument(document, assets, options.fontDirectory)
      if (data.length > MAX_EXPORT_BYTES) invalid('Export exceeds 50 MiB')
      addEntry(path, data, false)
    }
  }
  const zipped = zipSync(entries, { level: 6 })
  const buffer = Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength)
  if (buffer.length > maxBytes) invalid('The export exceeds 200 MiB; export one folder at a time')
  const now = options.now ?? new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { buffer, filename: `${en ? 'Jot' : '随记'}-${day}.zip`, contentType: 'application/zip', notes: notes.length, attachments: assets.size }
}
