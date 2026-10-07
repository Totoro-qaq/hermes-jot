/**
 * Markdown, text and ZIP import. Markdown becomes the same rich documents the
 * editor saves; nothing here renders or trusts HTML. ZIP paths never become
 * file-system paths: entries are read in memory and matched by normalized name.
 */
import MarkdownIt, { type MarkdownIt as Parser, type Token } from 'markdown-it'
import { unzipSync } from 'fflate'
import { crc32 } from 'node:zlib'
import {
  StoreError, HIGHLIGHT_COLORS, MAX_FOLDER_NAME_LENGTH, MAX_TITLE_LENGTH, TEXT_COLORS,
  docFromText, documentAttachmentIds, normalizePaletteColor, validateId, validateRichDoc,
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�'
  })
}
/** Visible text of an HTML block, one paragraph per line; tags and scripts never survive. */
function htmlBlockText(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/<(script|style|template)\b[\s\S]*?(?:<\/\1\s*>|$)/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre|table|thead|tbody|ul|ol|section|article|header|footer|details|summary)\s*>/giu, '\n')
    .replace(/<\/t[dh]\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, '')
  return decodeEntities(text).split('\n').map(line => line.trim()).filter(Boolean)
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
}

/** Inline tokens to text and hard breaks; marks nest by a stack, and the innermost color wins. */
function inlineNodes(tokens: readonly Token[] | null): RichNode[] {
  const nodes: RichNode[] = []
  const stack: Array<{ tag: string; marks: RichMark[] }> = []
  const marks = (): RichMark[] => {
    const active = new Map<RichMarkType, RichMark>()
    for (const entry of stack) for (const mark of entry.marks) active.set(mark.type, mark)
    return MARK_ORDER.filter(type => active.has(type)).map(type => structuredClone(active.get(type)!))
  }
  const close = (tag: string) => {
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
      case 'strong_open': stack.push({ tag: 'strong', marks: [{ type: 'bold' }] }); break
      case 'em_open': stack.push({ tag: 'em', marks: [{ type: 'italic' }] }); break
      case 's_open': stack.push({ tag: 's', marks: [{ type: 'strike' }] }); break
      case 'strong_close': close('strong'); break
      case 'em_close': close('em'); break
      case 's_close': close('s'); break
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '')
        stack.push({ tag: 'link', marks: safeHref(href) ? [{ type: 'link', attrs: { href } }] : [] })
        break
      }
      case 'link_close': close('link'); break
      case 'image': pushInline(nodes, textNode(plainText(token.children), marks())); break
      case 'html_inline': {
        const tag = /^<\s*(\/)?\s*([a-z][a-z0-9-]*)\b([^>]*)>$/iu.exec(token.content.trim())
        if (!tag) break
        const name = tag[2]!.toLowerCase()
        const selfClosing = /\/\s*$/u.test(tag[3]!)
        if (name === 'br') nodes.push({ type: 'hardBreak' })
        else if (name === 'u' || name === 'span') {
          if (tag[1]) close(name)
          else if (!selfClosing) stack.push({ tag: name, marks: name === 'u' ? [{ type: 'underline' }] : spanMarks(tag[3]!) })
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

function blocksFrom(tokens: readonly Token[], context: ConvertContext): RichNode[] {
  let index = 0
  const parse = (closing?: string): RichNode[] => {
    const blocks: RichNode[] = []
    while (index < tokens.length) {
      const token = tokens[index++]!
      if (closing && token.type === closing) return blocks
      switch (token.type) {
        case 'paragraph_open': {
          const inline = tokens[index++]!
          index++
          blocks.push(paragraph(inline, context))
          break
        }
        case 'heading_open': {
          const inline = tokens[index++]!
          index++
          const content = inlineNodes(inline.children)
          blocks.push({ type: 'heading', attrs: { level: Number(token.tag.slice(1)) }, ...(content.length ? { content } : {}) })
          break
        }
        case 'bullet_list_open': case 'ordered_list_open': {
          const ordered = token.type === 'ordered_list_open'
          const items: Array<{ blocks: RichNode[]; marker: RegExpExecArray | null }> = []
          while (tokens[index]?.type === 'list_item_open') {
            index++
            const first = tokens[index]?.type === 'paragraph_open' ? tokens[index + 1]?.content ?? '' : null
            const item = parse('list_item_close')
            if (item[0]?.type !== 'paragraph') item.unshift({ type: 'paragraph' })
            const leading = item[0]!.content?.[0]
            const marker = first === null ? null : TASK_MARKER.exec(first)
            items.push({ blocks: item, marker: marker && leading?.type === 'text' && leading.text!.startsWith(marker[0]) ? marker : null })
          }
          index++
          if (items.length && items.every(item => item.marker)) {
            blocks.push({ type: 'taskList', content: items.map(({ blocks: item, marker }) => {
              const first = item[0]!
              const content = [...first.content!]
              const rest = content[0]!.text!.slice(marker![0].length).replace(/^[ \t]+/u, '')
              if (rest) content[0] = { ...content[0]!, text: rest }
              else {
                content.shift()
                if (content[0]?.type === 'hardBreak') content.shift()
              }
              return { type: 'taskItem', attrs: { checked: marker![1] !== ' ' },
                content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }, ...item.slice(1)] }
            }) })
          } else if (items.length) {
            const start = Math.min(1_000_000, Math.max(1, Math.trunc(Number(token.attrGet('start') ?? 1)) || 1))
            blocks.push({ type: ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { start } } : {}),
              content: items.map(item => ({ type: 'listItem', content: item.blocks })) })
          }
          break
        }
        case 'blockquote_open': {
          const content = parse('blockquote_close')
          blocks.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] })
          break
        }
        case 'fence': case 'code_block': {
          const info = token.type === 'fence' ? token.info.trim().split(/\s+/u)[0] ?? '' : ''
          const language = /^[\w+#.-]{1,80}$/u.test(info) ? info : null
          const text = token.content.replace(/\n$/u, '')
          blocks.push({ type: 'codeBlock', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) })
          break
        }
        case 'hr': blocks.push({ type: 'horizontalRule' }); break
        case 'html_block':
          for (const line of htmlBlockText(token.content)) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: line }] })
          break
        case 'table_open': blocks.push(...table()); break
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
    const width = Math.max(0, ...rows.map(row => row.length))
    if (!rows.length || !width) return []
    if (width > 50 || rows.length > 200) {
      // Too large for a Jot table: keep every value as one readable line per row.
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
  const context: ConvertContext = { resolveFile: href => href ? options.resolveFile?.(href) ?? null : null }
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
  let clean = name.replace(/[\u0000-\u001f\u007f/\\‪-‮⁦-⁩]/gu, '_').trim()
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
  const convert = (path: string, data: Uint8Array, plain: boolean, fallbackTitle: string, resolveFile?: (href: string) => string | null) => {
    if (data.byteLength > MAX_IMPORT_NOTE_BYTES) { skip(path, 'The note is larger than 4 MiB.'); return }
    const text = decodeUtf8(data)
    if (text === null) { skip(path, 'The file is not UTF-8 text.'); return }
    try {
      const note = plain
        ? { title: fallbackTitle, content: docFromText(text) }
        : markdownToNote(text, { fallbackTitle, resolveFile })
      candidates.push({ ...note, folderName: extension === 'zip' ? folderName(path) : null, path })
    } catch (error) {
      if (!(error instanceof StoreError)) throw error
      skip(path, `The note is too large or complex for Jot: ${error.message}.`)
    }
  }

  let archive: { bytes: Uint8Array; crcs: number[] } | undefined
  if (extension !== 'zip') convert(basename(input.filename) || `note.${extension}`, bytes, extension === 'txt', titleStem(input.filename))
  else {
    const entries: ArchiveEntry[] = []
    const names = new Set<string>()
    const paths = new Set<string>()
    let position = -1
    try {
      unzipSync(bytes, { filter: file => {
        position++
        if (position >= MAX_ZIP_ENTRIES) invalid(`The ZIP archive has more than ${MAX_ZIP_ENTRIES.toLocaleString('en')} entries`)
        const path = file.name.replace(/\\/gu, '/').normalize('NFC')
        if (path.endsWith('/')) return false
        const segments = path.split('/')
        if (/^(?:\/|[a-z]:)/iu.test(path) || segments.includes('..')) { skip(file.name, 'Unsafe path in the archive.'); return false }
        const parts = segments.filter(segment => segment && segment !== '.')
        if (!parts.length || parts[0] === '__MACOSX' || parts.some(segment => segment.startsWith('.'))) return false
        const normalized = parts.join('/')
        if (names.has(file.name) || paths.has(normalized)) { skip(file.name, 'Duplicate entry in the archive.'); return false }
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
    archive = { bytes, crcs: centralCrcs(bytes) }
    const notes = entries.filter(entry => NOTE_EXTENSIONS.has(extensionOf(entry.path)))
    if (notes.length > MAX_IMPORT_NOTES) invalid(`A ZIP import holds at most ${MAX_IMPORT_NOTES.toLocaleString('en')} notes; import one folder at a time`)
    const wanted = notes.filter(entry => {
      if (entry.size <= MAX_IMPORT_NOTE_BYTES) return true
      skip(entry.path, 'The note is larger than 4 MiB.')
      return false
    })
    let declared = wanted.reduce((sum, entry) => sum + entry.size, 0)
    if (declared > MAX_IMPORT_BYTES) invalid('The archive expands to more than 100 MiB')
    const noteData = inflate(archive, wanted)
    const files = new Map<string, ArchiveEntry>()
    const lowerFiles = new Map<string, ArchiveEntry | null>()
    for (const entry of entries) if (!NOTE_EXTENSIONS.has(extensionOf(entry.path))) {
      files.set(entry.path, entry)
      const lower = entry.path.toLowerCase()
      lowerFiles.set(lower, lowerFiles.has(lower) ? null : entry)
    }
    const byPath = new Map<string, string>()
    const oversized = new Set<string>()
    for (const entry of wanted.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))) {
      const directory = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
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
    declared += [...placeholders.values()].reduce((sum, entry) => sum + entry.size, 0)
    if (declared > MAX_IMPORT_BYTES) invalid('The archive expands to more than 100 MiB')
    const linked = new Set([...placeholders.values()].map(entry => entry.path))
    for (const entry of entries) {
      if (!NOTE_EXTENSIONS.has(extensionOf(entry.path)) && !linked.has(entry.path) && !oversized.has(entry.path)) {
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
        try { uploaded.set(placeholder, await attachments.upload({ name: attachmentName(basename(entry.path)), bytes: data.get(entry.index)! })) }
        catch (error) {
          // The engine and this lazily loaded library are separate bundles: match the error code, not its class.
          const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code !== 'ATTACHMENT_TOO_LARGE' && code !== 'INVALID_ATTACHMENT') throw error
          skip(entry.path, error instanceof Error ? error.message : 'The file could not be attached.')
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

/**
 * CRC-32 values from the central directory, by entry position, read the same
 * way fflate walks it. fflate inflates into a buffer of the declared size and
 * does not check CRCs, so a damaged or understated entry would be silently cut.
 */
function centralCrcs(data: Uint8Array): number[] {
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
  const crcs: number[] = []
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || u32(offset) !== 0x02014b50) invalid('The ZIP archive is damaged')
    crcs.push(u32(offset + 16))
    offset += 46 + u16(offset + 28) + u16(offset + 30) + u16(offset + 32)
  }
  return crcs
}

/** Inflate chosen entries by their central-directory position and check their declared sizes and CRCs. */
function inflate(archive: { bytes: Uint8Array; crcs: number[] }, entries: readonly ArchiveEntry[]): Map<number, Uint8Array> {
  const wanted = new Map(entries.map(entry => [entry.index, entry]))
  const result = new Map<number, Uint8Array>()
  if (!wanted.size) return result
  let position = -1
  let files: Record<string, Uint8Array>
  try { files = unzipSync(archive.bytes, { filter: file => wanted.has(++position) }) }
  catch { invalid('The ZIP archive is damaged') }
  for (const entry of entries) {
    const data = files[entry.name]
    if (!data || data.byteLength !== entry.size || crc32(data) !== archive.crcs[entry.index]) invalid('The ZIP archive is damaged')
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
