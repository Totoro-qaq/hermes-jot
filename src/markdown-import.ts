/**
 * Markdown, text and ZIP import. Markdown becomes the same rich documents the
 * editor saves; nothing here renders or trusts HTML. ZIP paths never become
 * file-system paths: entries are read in memory and matched by normalized name.
 */
import MarkdownIt, { type MarkdownIt as Parser, type Token } from 'markdown-it'
import { unzipSync } from 'fflate'
import { stat } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import {
  StoreError, HIGHLIGHT_COLORS, MAX_FOLDER_NAME_LENGTH, MAX_NODES, MAX_STATE_BYTES, MAX_TITLE_LENGTH, TEXT_COLORS,
  docFromText, documentAttachmentIds, normalizePaletteColor, validateId, validateRichDoc, validatedDocText,
  type RichDoc, type RichMark, type RichMarkType, type RichNode,
} from './model.js'
import type { ImportNoteInput, JotStore } from './store.js'
import type { AttachmentInfo, AttachmentStore } from './attachments.js'

export interface ImportResult {
  notes: number
  attachments: number
  /** Folders this import created; existing folders with the same name are reused. */
  folders: number
  noteIds: string[]
  skipped: Array<{ path: string; reason: string }>
}
export type ImportExtension = 'md' | 'markdown' | 'txt' | 'zip'
export const MAX_IMPORT_BYTES = 100 * 1_048_576
export const MAX_IMPORT_NOTES = 2_000
export const MAX_IMPORT_ATTACHMENTS = 1_000
/** One note's source; the document limits (200,000 characters, 1 MiB) apply after conversion. */
export const MAX_IMPORT_NOTE_BYTES = 4 * 1_048_576
const MAX_ZIP_ENTRIES = 100_000
const MAX_SKIPPED = 1_000
/** A saved note's fields besides its title, document and text: id, folder, dates, revision and JSON keys. */
const NOTE_OVERHEAD_BYTES = 320
const NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt'])
const MARK_ORDER: RichMarkType[] = ['bold', 'italic', 'strike', 'underline', 'code', 'link', 'textStyle', 'highlight']

function invalid(message: string): never { throw new StoreError('INVALID_INPUT', message) }

/** Cut to a UTF-16 length without leaving half of a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return /[\ud800-\udbff]$/u.test(cut) ? cut.slice(0, -1) : cut
}
const safeHref = (href: string): boolean => href.length <= 2_048 && /^(https?:\/\/|mailto:|tel:|#)/iu.test(href)
  && !/[\u0000- ]/u.test(href) && href.trim().length > 0
const extensionOf = (name: string): string => /\.([^./]+)$/u.exec(name)?.[1]?.toLowerCase() ?? ''
const basename = (path: string): string => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''

/** A file name without a note extension, used as the title of a note without a leading H1. */
export function titleStem(filename: string): string {
  const name = basename(filename)
  const stem = NOTE_EXTENSIONS.has(extensionOf(name)) ? name.slice(0, name.lastIndexOf('.')) : name
  return truncate(stem.trim(), MAX_TITLE_LENGTH).trim()
}

let parser: Parser | undefined
function markdown(): Parser {
  if (!parser) {
    parser = MarkdownIt('default', { html: true, linkify: false, typographer: false }).enable(['table', 'strikethrough'])
    // Every destination is checked against Jot's own link rules below; an
    // unsafe link keeps its visible text instead of its Markdown source.
    parser.validateLink = () => true
  }
  return parser
}

const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u

/** HTML entities as markdown-it decodes them in Markdown text; a match holds no backslash, so only the entity changes. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/giu, match => markdown().utils.unescapeAll(match))
}
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'thead', 'tbody',
  'ul', 'ol', 'section', 'article', 'header', 'footer', 'details', 'summary'])
/** One attribute of a single HTML tag, entities decoded; a quoted value never yields another attribute. */
function htmlAttribute(tag: string, name: string): string {
  for (const match of tag.matchAll(/\s([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)) {
    if (match[1]!.toLowerCase() === name) return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return ''
}

/**
 * Visible text of an HTML block, one paragraph per line; tags and scripts never
 * survive. `<img>` and `<a>` that name a file in the import (Jot writes them in
 * tables with merged cells) become image and file blocks, and other images
 * keep their alt text. Tags are found by a single forward scan, so unclosed
 * `<` runs stay linear.
 */
function htmlBlockNodes(html: string, context: ConvertContext): RichNode[] {
  const source = html
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/<(script|style|template)\b[\s\S]*?(?:<\/\1\s*>|$)/giu, '')
  const blocks: RichNode[] = []
  let text = ''
  let link: { href: string; start: number } | null = null
  const flush = () => {
    for (const line of text.split('\n').map(value => value.trim()).filter(Boolean)) {
      context.spend(2)
      blocks.push({ type: 'paragraph', content: [{ type: 'text', text: line }] })
    }
    text = ''
    if (link) link.start = 0
  }
  const describe = (value: string) => truncate(value.replace(/\s+/gu, ' ').trim(), 1_000)
  let from = 0
  for (;;) {
    const open = source.indexOf('<', from)
    const end = open < 0 ? -1 : source.indexOf('>', open + 1)
    if (end < 0) { text += decodeEntities(source.slice(from)); break }
    text += decodeEntities(source.slice(from, open))
    from = end + 1
    const tag = source.slice(open, end + 1)
    const parts = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)/iu.exec(tag)
    if (!parts) continue
    const closing = parts[1] === '/'
    const name = parts[2]!.toLowerCase()
    if (closing && BLOCK_TAGS.has(name)) text += '\n'
    else if (closing && (name === 'td' || name === 'th')) text += ' '
    else if (closing && name === 'a') {
      const id = link ? context.resolveFile(link.href) : null
      if (link && id) {
        const caption = describe(text.slice(link.start))
        text = text.slice(0, link.start)
        flush()
        context.spend(1)
        blocks.push({ type: 'attachment', attrs: { attachmentId: id, caption } })
      }
      link = null
    } else if (closing) continue
    else if (name === 'br') text += '\n'
    else if (name === 'a') link = { href: htmlAttribute(tag, 'href'), start: text.length }
    else if (name === 'img') {
      const alt = describe(htmlAttribute(tag, 'alt'))
      const id = context.resolveFile(htmlAttribute(tag, 'src'))
      if (id) { flush(); context.spend(1); blocks.push({ type: 'image', attrs: { attachmentId: id, alt } }) }
      else text += alt
    }
  }
  flush()
  return blocks
}

function sameMarks(a: RichMark[] | undefined, b: RichMark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}
/** Append inline nodes, joining text that carries identical marks. */
function pushInline(nodes: RichNode[], node: RichNode): void {
  if (node.type === 'text') {
    if (!node.text) return
    const last = nodes.at(-1)
    if (last?.type === 'text' && sameMarks(last.marks, node.marks)) { last.text += node.text; return }
  }
  nodes.push(node)
}
function textNode(text: string, marks: RichMark[]): RichNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text }
}
function plainText(tokens: readonly Token[] | null): string {
  return (tokens ?? []).map(token => token.type === 'text' || token.type === 'code_inline' ? token.content
    : token.type === 'softbreak' || token.type === 'hardbreak' ? ' '
    : token.type === 'image' ? plainText(token.children) : '').join('')
}
function spanMarks(attributes: string): RichMark[] {
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attributes)
  const marks: RichMark[] = []
  for (const declaration of (style?.[1] ?? style?.[2] ?? '').split(';')) {
    const separator = declaration.indexOf(':')
    if (separator < 0) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const value = decodeEntities(declaration.slice(separator + 1)).trim()
    if (property === 'color') {
      const color = normalizePaletteColor(value, TEXT_COLORS)
      if (color) marks.push({ type: 'textStyle', attrs: { color } })
    } else if (property === 'background-color') {
      const color = normalizePaletteColor(value, HIGHLIGHT_COLORS)
      if (color) marks.push({ type: 'highlight', attrs: { color } })
    }
  }
  return marks
}

interface ConvertContext {
  /** Attachment id for a link or image destination that names a file in the import. */
  resolveFile(href: string): string | null
  /**
   * Count block nodes as they are made; past Jot's node limit the note fails at
   * once (a StoreError, so an archive skips it) instead of growing without bound.
   */
  spend(count: number): void
}

/** Inline HTML that Jot's Markdown export writes where `**`, `*` or `~~` could not open or close. */
const HTML_MARKS: Partial<Record<string, readonly RichMark[]>> = Object.assign(Object.create(null) as object, {
  strong: [{ type: 'bold' }], em: [{ type: 'italic' }], s: [{ type: 'strike' }], u: [{ type: 'underline' }],
})
/** Deeper inline nesting adds no marks; the bound keeps each step constant on unclosed `<u>`/`<span>` runs. */
const MAX_INLINE_DEPTH = 128

/** Inline tokens to text and hard breaks; marks nest by a stack, and the innermost color wins. */
function inlineNodes(tokens: readonly Token[] | null): RichNode[] {
  const nodes: RichNode[] = []
  const stack: Array<{ tag: string; marks: RichMark[] }> = []
  /** Tags opened beyond MAX_INLINE_DEPTH; they are always the innermost, so their closes match first. */
  const dropped = new Map<string, number>()
  const marks = (): RichMark[] => {
    const active = new Map<RichMarkType, RichMark>()
    for (const entry of stack) for (const mark of entry.marks) active.set(mark.type, mark)
    return MARK_ORDER.filter(type => active.has(type)).map(type => structuredClone(active.get(type)!))
  }
  const open = (tag: string, added: RichMark[]) => {
    if (stack.length < MAX_INLINE_DEPTH) stack.push({ tag, marks: added })
    else dropped.set(tag, (dropped.get(tag) ?? 0) + 1)
  }
  const close = (tag: string) => {
    const extra = dropped.get(tag)
    if (extra) { dropped.set(tag, extra - 1); return }
    for (let index = stack.length - 1; index >= 0; index--) if (stack[index]!.tag === tag) { stack.splice(index, 1); return }
  }
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text': pushInline(nodes, textNode(token.content, marks())); break
      case 'code_inline': {
        const current = [...marks(), { type: 'code' as const }]
        pushInline(nodes, textNode(token.content, MARK_ORDER.flatMap(type => current.filter(mark => mark.type === type))))
        break
      }
      case 'softbreak': case 'hardbreak': nodes.push({ type: 'hardBreak' }); break
      case 'strong_open': open('strong', [{ type: 'bold' }]); break
      case 'em_open': open('em', [{ type: 'italic' }]); break
      case 's_open': open('s', [{ type: 'strike' }]); break
      case 'strong_close': close('strong'); break
      case 'em_close': close('em'); break
      case 's_close': close('s'); break
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '')
        open('link', safeHref(href) ? [{ type: 'link', attrs: { href } }] : [])
        break
      }
      case 'link_close': close('link'); break
      case 'image': pushInline(nodes, textNode(plainText(token.children), marks())); break
      case 'html_inline': {
        const tag = /^<\s*(\/)?\s*([a-z][a-z0-9-]*)\b([^>]*)>$/iu.exec(token.content.trim())
        if (!tag) break
        const name = tag[2]!.toLowerCase()
        const selfClosing = /\/\s*$/u.test(tag[3]!)
        const tagMarks = HTML_MARKS[name]
        if (name === 'br') nodes.push({ type: 'hardBreak' })
        else if (tagMarks || name === 'span') {
          // HTML tags pair only with HTML tags, never with Markdown's own delimiters.
          if (tag[1]) close(`<${name}>`)
          else if (!selfClosing) open(`<${name}>`, tagMarks ? [...tagMarks] : spanMarks(tag[3]!))
        }
        break
      }
      default: break
    }
  }
  return nodes
}

/** A paragraph that is only an image, or only a link to an imported file, becomes that image or file card. */
function standalone(inline: Token, context: ConvertContext): RichNode | null {
  const children = (inline.children ?? []).filter(token => !(token.type === 'text' && !token.content.trim()))
  if (children.length === 1 && children[0]!.type === 'image') {
    const image = children[0]!
    const src = String(image.attrGet('src') ?? '')
    const alt = truncate(plainText(image.children).trim(), 1_000)
    const id = context.resolveFile(src)
    if (id) return { type: 'image', attrs: { attachmentId: id, alt } }
    const safe = safeHref(src)
    let label = alt
    if (!label) {
      try { label = safe ? src : decodeURIComponent(basename(src.split(/[?#]/u)[0]!)) } catch { label = basename(src) }
    }
    return { type: 'paragraph', ...(label ? { content: [textNode(label, safe ? [{ type: 'link', attrs: { href: src } }] : [])] } : {}) }
  }
  if (children.length >= 2 && children[0]!.type === 'link_open' && children.at(-1)!.type === 'link_close') {
    let depth = 0
    for (const [index, token] of children.entries()) {
      if (token.type === 'link_open') depth++
      else if (token.type === 'link_close' && --depth === 0 && index !== children.length - 1) return null
    }
    const id = context.resolveFile(String(children[0]!.attrGet('href') ?? ''))
    if (id) return { type: 'attachment', attrs: { attachmentId: id, caption: truncate(plainText(children.slice(1, -1)).trim(), 1_000) } }
  }
  return null
}

function paragraph(inline: Token, context: ConvertContext): RichNode {
  const special = standalone(inline, context)
  if (special) return special
  const content = inlineNodes(inline.children)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

const TASK_MARKER = /^\[([ xX])\](?=\s|$)/u

function cellAlign(token: Token): string | null {
  const align = /text-align:\s*(left|center|right)/u.exec(String(token.attrGet('style') ?? ''))?.[1]
  return align ?? null
}

type ListEntry = { blocks: RichNode[]; marker: RegExpExecArray | null }
function taskItem({ blocks: item, marker }: ListEntry): RichNode {
  const content = [...item[0]!.content!]
  const rest = content[0]!.text!.slice(marker![0].length).replace(/^[ \t]+/u, '')
  if (rest) content[0] = { ...content[0]!, text: rest }
  else {
    content.shift()
    if (content[0]?.type === 'hardBreak') content.shift()
  }
  return { type: 'taskItem', attrs: { checked: marker![1] !== ' ' },
    content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }, ...item.slice(1)] }
}

function blocksFrom(tokens: readonly Token[], context: ConvertContext): RichNode[] {
  let index = 0
  const add = (blocks: RichNode[], node: RichNode) => { context.spend(1); blocks.push(node) }
  const parse = (closing?: string): RichNode[] => {
    const blocks: RichNode[] = []
    while (index < tokens.length) {
      const token = tokens[index++]!
      if (closing && token.type === closing) return blocks
      switch (token.type) {
        case 'paragraph_open': {
          const inline = tokens[index++]!
          index++
          add(blocks, paragraph(inline, context))
          break
        }
        case 'heading_open': {
          const inline = tokens[index++]!
          index++
          const content = inlineNodes(inline.children)
          add(blocks, { type: 'heading', attrs: { level: Number(token.tag.slice(1)) }, ...(content.length ? { content } : {}) })
          break
        }
        case 'bullet_list_open': case 'ordered_list_open': {
          const ordered = token.type === 'ordered_list_open'
          const items: ListEntry[] = []
          while (tokens[index]?.type === 'list_item_open') {
            index++
            context.spend(1)
            const first = tokens[index]?.type === 'paragraph_open' ? tokens[index + 1]?.content ?? '' : null
            const item = parse('list_item_close')
            if (item[0]?.type !== 'paragraph') item.unshift({ type: 'paragraph' })
            const leading = item[0]!.content?.[0]
            const marker = first === null ? null : TASK_MARKER.exec(first)
            items.push({ blocks: item, marker: marker && leading?.type === 'text' && leading.text!.startsWith(marker[0]) ? marker : null })
          }
          index++
          const start = Math.min(1_000_000, Math.max(1, Math.trunc(Number(token.attrGet('start') ?? 1)) || 1))
          // Task status is per item: each run of task items is a checklist and the items between stay a list,
          // so a GFM list that mixes both, or Jot's own list exported next to a checklist, keeps its checkboxes.
          for (let from = 0; from < items.length;) {
            const task = items[from]!.marker !== null
            let to = from + 1
            while (to < items.length && (items[to]!.marker !== null) === task) to++
            const run = items.slice(from, to)
            if (task) add(blocks, { type: 'taskList', content: run.map(taskItem) })
            else {
              add(blocks, { type: ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { start: Math.min(1_000_000, start + from) } } : {}),
                content: run.map(item => ({ type: 'listItem', content: item.blocks })) })
            }
            from = to
          }
          break
        }
        case 'blockquote_open': {
          const content = parse('blockquote_close')
          add(blocks, { type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] })
          break
        }
        case 'fence': case 'code_block': {
          const info = token.type === 'fence' ? token.info.trim().split(/\s+/u)[0] ?? '' : ''
          const language = /^[\w+#.-]{1,80}$/u.test(info) ? info : null
          const text = token.content.replace(/\n$/u, '')
          add(blocks, { type: 'codeBlock', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) })
          break
        }
        case 'hr': add(blocks, { type: 'horizontalRule' }); break
        // Never spread these into push: an HTML block or table can yield more nodes than a call takes arguments.
        case 'html_block': for (const node of htmlBlockNodes(token.content, context)) blocks.push(node); break
        case 'table_open': for (const node of table()) blocks.push(node); break
        default: break
      }
    }
    return blocks
  }
  const table = (): RichNode[] => {
    const rows: Array<Array<{ header: boolean; align: string | null; inline: Token | undefined }>> = []
    while (index < tokens.length) {
      const token = tokens[index++]!
      if (token.type === 'table_close') break
      if (token.type === 'tr_open') rows.push([])
      else if (token.type === 'th_open' || token.type === 'td_open') {
        const inline = tokens[index]?.type === 'inline' ? tokens[index] : undefined
        rows.at(-1)?.push({ header: token.type === 'th_open', align: cellAlign(token), inline })
      }
    }
    const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
    if (!rows.length || !width) return []
    if (width > 50 || rows.length > 200) {
      // Too large for a Jot table: keep every value as one readable line per row.
      context.spend(rows.length)
      return rows.map(row => {
        const content: RichNode[] = []
        row.forEach((cell, column) => {
          if (column) pushInline(content, { type: 'text', text: ' | ' })
          for (const node of inlineNodes(cell.inline?.children ?? null)) pushInline(content, node)
        })
        return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
      })
    }
    // Jot writes a blank header row for a table without one; keep that table header-less.
    const blankHeader = rows.length > 1 && rows[0]!.every(cell => !cell.inline?.content.trim())
    const body = blankHeader ? rows.slice(1) : rows
    context.spend(1 + body.length * (1 + 2 * width))
    return [{ type: 'table', content: body.map((row, rowIndex) => ({ type: 'tableRow', content: Array.from({ length: width }, (_, column) => {
      const cell = row[column]
      return { type: rowIndex === 0 && !blankHeader ? 'tableHeader' : 'tableCell',
        attrs: { colspan: 1, rowspan: 1, colwidth: null, align: cell?.align ?? null },
        content: [cell?.inline ? paragraph(cell.inline, context) : { type: 'paragraph' }] }
    }) })) }]
  }
  return parse()
}

const inlineText = (node: RichNode): string => node.type === 'text' ? node.text ?? '' : node.type === 'hardBreak' ? ' '
  : (node.content ?? []).map(inlineText).join('')

/**
 * Convert one Markdown note. A leading H1 becomes the title; otherwise the
 * fallback (normally the file name) does. Throws INVALID_INPUT when the result
 * exceeds Jot's document limits.
 */
export function markdownToNote(source: string, options: { fallbackTitle?: string; resolveFile?: (href: string) => string | null } = {}): { title: string; content: RichDoc } {
  if (typeof source !== 'string') invalid('Markdown text is required')
  const body = source.replace(/^\ufeff/u, '').replace(FRONT_MATTER, '')
  /** Blocks only, so never more than the document holds; -1 allows for a leading H1 that becomes the title. */
  let nodes = -1
  const context: ConvertContext = {
    resolveFile: href => href ? options.resolveFile?.(href) ?? null : null,
    spend: count => { if ((nodes += count) > MAX_NODES) invalid('Document is too complex') },
  }
  const blocks = blocksFrom(markdown().parse(body, {}), context)
  let title = truncate((options.fallbackTitle ?? '').trim(), MAX_TITLE_LENGTH).trim()
  const first = blocks[0]
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    blocks.shift()
    const heading = truncate(inlineText(first).replace(/\s+/gu, ' ').trim(), MAX_TITLE_LENGTH).trim()
    if (heading) title = heading
  }
  return { title, content: validateRichDoc({ type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] }) }
}

/** Strict UTF-8; TextDecoder also drops a leading byte-order mark. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return null }
}

/** Resolve a relative link against a note's directory inside the archive; never above its root. */
export function resolveArchivePath(href: string, directory: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/iu.test(href) || /^[/\\#?]/u.test(href)) return null
  let raw = href.split(/[?#]/u)[0]!
  try { raw = decodeURIComponent(raw) } catch { return null }
  const parts: string[] = []
  for (const segment of `${directory ? `${directory}/` : ''}${raw.replace(/\\/gu, '/').normalize('NFC')}`.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(segment)
  }
  return parts.length ? parts.join('/') : null
}

/** A portable stored name for an imported attachment, within AttachmentStore's name rules. */
function attachmentName(name: string): string {
  let clean = name.replace(/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/gu, '_').trim()
  if (!clean || clean === '.' || clean === '..') return 'attachment'
  const dot = clean.lastIndexOf('.')
  const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
  let stem = extension ? clean.slice(0, dot) : clean
  const fits = () => (stem + extension).length <= 200 && Buffer.byteLength(stem + extension, 'utf8') <= 500
  while (!fits() && stem.length) stem = truncate(stem, stem.length - 1)
  clean = (stem + extension) || 'attachment'
  return clean
}

interface Candidate { title: string; content: RichDoc; folderName: string | null; path: string }
interface ArchiveEntry { index: number; name: string; path: string; size: number }

function folderName(path: string): string | null {
  const segments = path.split('/')
  if (segments.length < 2) return null
  return truncate(segments[0]!.trim(), MAX_FOLDER_NAME_LENGTH).trim() || null
}

/**
 * Where Jot's exports put attachments: directly in the library export's `附件`
 * or `attachments` directory, or as `assets/<attachment id>-<name>` in a
 * single-note export.
 */
const exportedAttachmentPath = (path: string): boolean => {
  const segments = path.split('/')
  return segments.length === 2 && (/^(?:attachments|附件)(?: \(\d+\))?$/iu.test(segments[0]!)
    || segments[0] === 'assets' && /^[0-9a-f]{32}-./iu.test(segments[1]!))
}
const directoryOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
/** A single-note export prefixes each asset with its attachment id; the original name is the rest. */
const archiveFileName = (path: string): string => /^assets\/[0-9a-f]{32}-[^/]+$/iu.test(path) ? basename(path).slice(33) : basename(path)

/**
 * Markdown and text files that a Jot export attached to notes: they sit where
 * Jot's exports put attachments and another note links to them as a file card
 * or image. Anywhere else a linked .md file stays a note of its own, so an
 * index note listing its chapters keeps them as notes.
 */
function attachedNoteFiles(notes: readonly ArchiveEntry[], readable: readonly ArchiveEntry[], data: Map<number, Uint8Array>): Set<string> {
  const attached = new Set<string>()
  const possible = new Map<string, ArchiveEntry>()
  for (const entry of notes) {
    if (exportedAttachmentPath(entry.path)) possible.set(entry.path.toLowerCase(), entry)
  }
  if (!possible.size) return attached
  for (const entry of readable) {
    if (possible.has(entry.path.toLowerCase()) || extensionOf(entry.path) === 'txt') continue
    const text = decodeUtf8(data.get(entry.index)!)
    if (text === null) continue
    const directory = directoryOf(entry.path)
    try {
      markdownToNote(text, { resolveFile: href => {
        const target = resolveArchivePath(href, directory)
        const file = target === null ? undefined : possible.get(target.toLowerCase())
        if (file) attached.add(file.path)
        return null
      } })
    } catch (error) { if (!(error instanceof StoreError)) throw error }
  }
  return attached
}

/**
 * Import one uploaded Markdown, text or ZIP file. Per-file problems are
 * reported in `skipped`; archive-wide limits fail before anything is saved.
 * Attachments are uploaded first and removed again if the notes cannot be saved.
 */
export async function importNotesFile(store: JotStore, attachments: AttachmentStore, input: {
  bytes: Uint8Array; filename: string; extension: ImportExtension; folderId: string | null
}): Promise<ImportResult> {
  const { bytes, extension } = input
  if (!(bytes instanceof Uint8Array)) invalid('Import bytes are required')
  if (bytes.byteLength > MAX_IMPORT_BYTES) invalid('Import files are limited to 100 MiB')
  if (!['md', 'markdown', 'txt', 'zip'].includes(extension)) invalid('Import Markdown, text or ZIP files')
  if (typeof input.filename !== 'string' || input.filename.length > 1_024) invalid('Invalid import file name')
  const folderId = input.folderId === null ? null : validateId(input.folderId)
  if (folderId !== null && !(await store.readState('user')).folders.some(folder => folder.id === folderId)) {
    throw new StoreError('NOT_FOUND', 'Folder not found')
  }
  const skipped: ImportResult['skipped'] = []
  let omitted = 0
  const skip = (path: string, reason: string) => { if (skipped.length < MAX_SKIPPED) skipped.push({ path, reason }); else omitted++ }
  const report = () => omitted ? [...skipped, { path: '…', reason: `${omitted} more files were skipped.` }] : skipped
  const candidates: Candidate[] = []
  /** Placeholder attachment id → archive entry, replaced by managed ids after upload. */
  const placeholders = new Map<string, ArchiveEntry>()
  /**
   * The notes file after this import, estimated as each note is converted. The
   * import stops before any upload once it would pass the state limit; each
   * note's document stays in memory until the save, so this also bounds memory.
   */
  let stateBytes = await stat(store.statePath).then(info => info.size, () => 0)
  const convert = (path: string, data: Uint8Array, plain: boolean, fallbackTitle: string, resolveFile?: (href: string) => string | null) => {
    if (data.byteLength > MAX_IMPORT_NOTE_BYTES) { skip(path, 'The note is larger than 4 MiB.'); return }
    const text = decodeUtf8(data)
    if (text === null) { skip(path, 'The file is not UTF-8 text.'); return }
    let note: { title: string; content: RichDoc }
    try {
      note = plain
        ? { title: fallbackTitle, content: docFromText(text) }
        : markdownToNote(text, { fallbackTitle, resolveFile })
    } catch (error) {
      if (!(error instanceof StoreError)) throw error
      skip(path, `The note is too large or complex for Jot: ${error.message}.`)
      return
    }
    stateBytes += NOTE_OVERHEAD_BYTES + Buffer.byteLength(JSON.stringify(note.title), 'utf8')
      + Buffer.byteLength(JSON.stringify(note.content), 'utf8') + Buffer.byteLength(JSON.stringify(validatedDocText(note.content)), 'utf8')
    if (stateBytes > MAX_STATE_BYTES) {
      invalid(`These notes would take Jot's notes storage past its ${MAX_STATE_BYTES / 1_048_576} MiB limit; import fewer notes at a time`)
    }
    candidates.push({ ...note, folderName: extension === 'zip' ? folderName(path) : null, path })
  }

  let archive: { bytes: Uint8Array; central: CentralEntry[] } | undefined
  if (extension !== 'zip') convert(basename(input.filename) || `note.${extension}`, bytes, extension === 'txt', titleStem(input.filename))
  else {
    const entries: ArchiveEntry[] = []
    const names = new Set<string>()
    const paths = new Set<string>()
    let position = -1
    // fflate reads a name without the UTF-8 flag as Latin-1. Folders, titles and links use the name the
    // archiver meant; fflate's own name stays the key of its output.
    archive = { bytes, central: centralDirectory(bytes) }
    const central = archive.central
    try {
      unzipSync(bytes, { filter: file => {
        position++
        if (position >= MAX_ZIP_ENTRIES) invalid(`The ZIP archive has more than ${MAX_ZIP_ENTRIES.toLocaleString('en')} entries`)
        const display = central[position]?.name ?? invalid('The ZIP archive is damaged')
        const path = display.replace(/\\/gu, '/').normalize('NFC')
        if (path.endsWith('/')) return false
        const segments = path.split('/')
        if (/^(?:\/|[a-z]:)/iu.test(path) || segments.includes('..')) { skip(display, 'Unsafe path in the archive.'); return false }
        const parts = segments.filter(segment => segment && segment !== '.')
        if (!parts.length || parts[0] === '__MACOSX' || parts.some(segment => segment.startsWith('.'))) return false
        const normalized = parts.join('/')
        if (names.has(file.name) || paths.has(normalized)) { skip(display, 'Duplicate entry in the archive.'); return false }
        names.add(file.name)
        paths.add(normalized)
        if (file.compression !== 0 && file.compression !== 8) { skip(normalized, 'Unsupported ZIP compression.'); return false }
        entries.push({ index: position, name: file.name, path: normalized, size: file.originalSize })
        return false
      } })
    } catch (error) {
      if (error instanceof StoreError) throw error
      invalid('The file is not a readable ZIP archive')
    }
    const notes = entries.filter(entry => NOTE_EXTENSIONS.has(extensionOf(entry.path)))
    if (notes.length > MAX_IMPORT_NOTES) invalid(`A ZIP import holds at most ${MAX_IMPORT_NOTES.toLocaleString('en')} notes; import one folder at a time`)
    const readable = notes.filter(entry => entry.size <= MAX_IMPORT_NOTE_BYTES)
    if (readable.reduce((sum, entry) => sum + entry.size, 0) > MAX_IMPORT_BYTES) invalid('The archive expands to more than 100 MiB')
    const noteData = inflate(archive, readable)
    const attached = attachedNoteFiles(notes, readable, noteData)
    const wanted = notes.filter(entry => {
      if (attached.has(entry.path)) return false
      if (entry.size <= MAX_IMPORT_NOTE_BYTES) return true
      skip(entry.path, 'The note is larger than 4 MiB.')
      return false
    })
    const files = new Map<string, ArchiveEntry>()
    const lowerFiles = new Map<string, ArchiveEntry | null>()
    for (const entry of entries) if (!NOTE_EXTENSIONS.has(extensionOf(entry.path)) || attached.has(entry.path)) {
      files.set(entry.path, entry)
      const lower = entry.path.toLowerCase()
      lowerFiles.set(lower, lowerFiles.has(lower) ? null : entry)
    }
    const byPath = new Map<string, string>()
    const oversized = new Set<string>()
    for (const entry of wanted.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))) {
      const directory = directoryOf(entry.path)
      convert(entry.path, noteData.get(entry.index)!, extensionOf(entry.path) === 'txt', titleStem(entry.path), href => {
        const target = resolveArchivePath(href, directory)
        const file = target === null ? undefined : files.get(target) ?? lowerFiles.get(target.toLowerCase()) ?? undefined
        if (!file) return null
        if (file.size > attachments.maxFileBytes) {
          if (!oversized.has(file.path)) { oversized.add(file.path); skip(file.path, 'The file exceeds the attachment size limit.') }
          return null
        }
        let id = byPath.get(file.path)
        if (!id) {
          id = (placeholders.size + 1).toString(16).padStart(32, '0')
          byPath.set(file.path, id)
          placeholders.set(id, file)
        }
        return id
      })
    }
    const referenced = new Set(candidates.flatMap(candidate => [...documentAttachmentIds(candidate.content)]))
    if (referenced.size > MAX_IMPORT_ATTACHMENTS) invalid(`A ZIP import links at most ${MAX_IMPORT_ATTACHMENTS.toLocaleString('en')} attachments`)
    for (const id of placeholders.keys()) if (!referenced.has(id)) placeholders.delete(id)
    const declared = [...wanted, ...placeholders.values()].reduce((sum, entry) => sum + entry.size, 0)
    if (declared > MAX_IMPORT_BYTES) invalid('The archive expands to more than 100 MiB')
    const linked = new Set([...placeholders.values()].map(entry => entry.path))
    for (const entry of entries) {
      if (files.has(entry.path) && !linked.has(entry.path) && !oversized.has(entry.path)) {
        skip(entry.path, 'Not a Markdown or text note, and no imported note links to it.')
      }
    }
  }
  if (!candidates.length) return { notes: 0, attachments: 0, folders: 0, noteIds: [], skipped: report() }

  const uploaded = new Map<string, AttachmentInfo>()
  const rollback = async () => { if (uploaded.size) await attachments.remove([...uploaded.values()].map(item => item.id)).catch(() => {}) }
  try {
    if (archive && placeholders.size) {
      const data = inflate(archive, [...placeholders.values()])
      for (const [placeholder, entry] of placeholders) {
        try { uploaded.set(placeholder, await attachments.upload({ name: attachmentName(archiveFileName(entry.path)), bytes: data.get(entry.index)! })) }
        catch (error) {
          // The engine and this lazily loaded library are separate bundles: match the error code, not its class.
          const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code !== 'ATTACHMENT_TOO_LARGE' && code !== 'INVALID_ATTACHMENT') throw error
          skip(entry.path, code === 'ATTACHMENT_TOO_LARGE' ? 'The file exceeds the attachment size limit.' : 'The file could not be attached.')
        }
      }
    }
    const notes: ImportNoteInput[] = []
    for (const candidate of candidates) {
      let content = candidate.content
      // A file that could not be attached becomes its description, which can push a note past the text limit.
      try { if (placeholders.size) content = replacePlaceholders(content, placeholders, uploaded) }
      catch (error) {
        if (!(error instanceof StoreError)) throw error
        skip(candidate.path, `The note is too large or complex for Jot: ${error.message}.`)
        continue
      }
      notes.push({ title: candidate.title, content, folderName: candidate.folderName, folderId: candidate.folderName === null ? folderId : null })
    }
    // Files linked only from notes skipped above are not kept.
    const used = new Set(notes.flatMap(note => [...documentAttachmentIds(note.content)]))
    const unused = [...uploaded].filter(([, file]) => !used.has(file.id))
    if (unused.length) {
      await attachments.remove(unused.map(([, file]) => file.id)).catch(() => {})
      for (const [placeholder] of unused) uploaded.delete(placeholder)
    }
    if (!notes.length) return { notes: 0, attachments: 0, folders: 0, noteIds: [], skipped: report() }
    const managed = new Set([...uploaded.values()].map(item => item.id))
    let verified = false
    const result = await store.importNotes({ folders: [...new Set(notes.flatMap(note => note.folderName ?? []))], notes }, async content => {
      const ids = [...documentAttachmentIds(content)]
      if (!ids.length) return
      if (!verified) { await attachments.assertReferences([...managed]); verified = true }
      if (ids.some(id => !managed.has(id))) await attachments.assertReferences(ids)
    })
    return { notes: result.noteIds.length, attachments: uploaded.size, folders: result.folders, noteIds: result.noteIds, skipped: report() }
  } catch (error) {
    await rollback()
    throw error
  }
}

interface CentralEntry { crc: number; name: string }

/**
 * Central-directory entries by position, read the same way fflate walks them.
 * fflate inflates into a buffer of the declared size and does not check CRCs,
 * so a damaged or understated entry would be silently cut; the CRC-32 here
 * catches that. Names follow {@link entryName}.
 */
function centralDirectory(data: Uint8Array): CentralEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u16 = (offset: number) => view.getUint16(offset, true)
  const u32 = (offset: number) => view.getUint32(offset, true)
  let end = data.length - 22
  while (end >= 0 && u32(end) !== 0x06054b50) {
    if (data.length - end > 65_558) invalid('The file is not a readable ZIP archive')
    end--
  }
  if (end < 0) invalid('The file is not a readable ZIP archive')
  let count = u16(end + 8), offset = u32(end + 16)
  if (end >= 20 && u32(end - 20) === 0x07064b50) {
    const zip64 = u32(end - 12)
    if (zip64 + 56 <= data.length && u32(zip64) === 0x06064b50) { count = u32(zip64 + 32); offset = u32(zip64 + 48) }
  }
  if (count > MAX_ZIP_ENTRIES) invalid(`The ZIP archive has more than ${MAX_ZIP_ENTRIES.toLocaleString('en')} entries`)
  const entries: CentralEntry[] = []
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || u32(offset) !== 0x02014b50) invalid('The ZIP archive is damaged')
    const nameEnd = offset + 46 + u16(offset + 28), extraEnd = nameEnd + u16(offset + 30)
    if (extraEnd > data.length) invalid('The ZIP archive is damaged')
    entries.push({ crc: u32(offset + 16), name: entryName(data.subarray(offset + 46, nameEnd), u16(offset + 8), data.subarray(nameEnd, extraEnd)) })
    offset = extraEnd + u16(offset + 32)
  }
  return entries
}

/** The upper half of CP437, the ZIP format's default code page. */
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
let gb18030: TextDecoder | null | undefined

/**
 * An entry name as the archiver meant it. The UTF-8 flag (bit 11) decides when
 * set. Otherwise an Info-ZIP Unicode Path field (0x7075) whose CRC matches the
 * stored name wins; then the name itself if it is valid UTF-8 (macOS Archive
 * Utility, ditto and Info-ZIP zip store UTF-8 without the flag); then GB18030,
 * which Chinese Windows writes; and last CP437, the ZIP default.
 */
function entryName(raw: Uint8Array, flags: number, extra: Uint8Array): string {
  if (flags & 0x800) return new TextDecoder().decode(raw)
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra[at]! | extra[at + 1]! << 8, size = extra[at + 2]! | extra[at + 3]! << 8
    const field = extra.subarray(at + 4, at + 4 + size)
    if (id === 0x7075 && field.length > 5 && field[0] === 1
      && (field[1]! | field[2]! << 8 | field[3]! << 16 | field[4]! << 24) >>> 0 === crc32(raw)) {
      const name = decodeUtf8(field.subarray(5))
      if (name) return name
    }
    at += 4 + size
  }
  const utf8 = decodeUtf8(raw)
  if (utf8 !== null) return utf8
  if (gb18030 === undefined) {
    try { gb18030 = new TextDecoder('gb18030', { fatal: true }) } catch { gb18030 = null }
  }
  if (gb18030) {
    try { return gb18030.decode(raw) } catch { /* not GB18030 either */ }
  }
  return Array.from(raw, byte => byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80]!).join('')
}

/** Inflate chosen entries by their central-directory position and check their declared sizes and CRCs. */
function inflate(archive: { bytes: Uint8Array; central: CentralEntry[] }, entries: readonly ArchiveEntry[]): Map<number, Uint8Array> {
  const wanted = new Map(entries.map(entry => [entry.index, entry]))
  const result = new Map<number, Uint8Array>()
  if (!wanted.size) return result
  let position = -1
  let files: Record<string, Uint8Array>
  try { files = unzipSync(archive.bytes, { filter: file => wanted.has(++position) }) }
  catch { invalid('The ZIP archive is damaged') }
  for (const entry of entries) {
    const data = files[entry.name]
    if (!data || data.byteLength !== entry.size || crc32(data) !== archive.central[entry.index]?.crc) invalid('The ZIP archive is damaged')
    result.set(entry.index, data)
  }
  return result
}

/** Swap placeholder ids for uploaded attachments; a file that was not uploaded keeps its description as text. */
function replacePlaceholders(doc: RichDoc, placeholders: Map<string, ArchiveEntry>, uploaded: Map<string, AttachmentInfo>): RichDoc {
  const visit = (node: RichNode): RichNode => {
    if (node.type === 'image' || node.type === 'attachment') {
      const placeholder = String(node.attrs!.attachmentId)
      const file = uploaded.get(placeholder)
      const description = String(node.attrs![node.type === 'image' ? 'alt' : 'caption'] ?? '')
      if (!file) {
        const label = description || basename(placeholders.get(placeholder)?.path ?? '')
        return label ? { type: 'paragraph', content: [{ type: 'text', text: label }] } : { type: 'paragraph' }
      }
      // An unverifiable "image" (SVG, damaged bytes) stays available as a file card.
      if (node.type === 'image' && file.kind !== 'image') return { type: 'attachment', attrs: { attachmentId: file.id, caption: description } }
      return { ...node, attrs: { ...node.attrs, attachmentId: file.id } }
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node
  }
  return validateRichDoc({ type: 'doc', content: doc.content.map(visit) })
}
