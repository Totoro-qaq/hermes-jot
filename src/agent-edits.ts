/**
 * Exact visible-text replacements for agents. Each edit changes text inside one
 * textblock and leaves every other node, mark and attribute as it was.
 *
 * Marks: text that find and replace share at either end stays untouched. When
 * the edit both removes and adds text, that shared context ends only where it
 * splits no word, or at a formatting edge in the note. Text added without
 * replacing any extends its neighbours' marks (see insertionMarks). Text that
 * replaces text takes, token by token, the marks of the words and characters it
 * replaces when both split into matching tokens; otherwise all of it takes the
 * marks shared by every replaced character. So a link only covers new text that
 * replaced text wholly inside that link.
 */
import { StoreError, onlyKeys, record, validateRichDoc, type RichDoc, type RichMark, type RichNode } from './model.js'

export interface TextEdit { find: string; replace: string }
export const MAX_EDITS = 20
export const MAX_FIND_LENGTH = 2_000
export const MAX_REPLACE_LENGTH = 20_000

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])
const invalid = (message: string): never => { throw new StoreError('INVALID_INPUT', message) }

export function validateTextEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EDITS) invalid(`edits must be an array of 1 to ${MAX_EDITS} { find, replace } objects.`)
  return (value as unknown[]).map((item, index) => {
    const name = `Edit ${index + 1}`
    const data = record(item, name)
    onlyKeys(data, ['find', 'replace'], name.toLowerCase())
    if (typeof data.find !== 'string' || data.find.length < 1 || data.find.length > MAX_FIND_LENGTH) {
      invalid(`${name}: find must be a non-empty string of at most 2,000 characters.`)
    }
    if (typeof data.replace !== 'string' || data.replace.length > MAX_REPLACE_LENGTH) {
      invalid(`${name}: replace must be a string of at most 20,000 characters.`)
    }
    const lines = (text: string) => text.replace(/\r\n?/gu, '\n')
    return { find: lines(data.find as string), replace: lines(data.replace as string) }
  })
}

const visibleText = (block: RichNode) => (block.content ?? []).map(node => node.type === 'hardBreak' ? '\n' : node.text ?? '').join('')
const length = (node: RichNode) => node.type === 'text' ? node.text!.length : 1

/** Inline nodes covering visible offsets [from, to). */
function slice(nodes: readonly RichNode[], from: number, to: number): RichNode[] {
  const result: RichNode[] = []
  let position = 0
  for (const node of nodes) {
    const start = position
    position += length(node)
    if (position <= from || start >= to) continue
    if (node.type !== 'text') { result.push(node); continue }
    result.push({ ...node, text: node.text!.slice(Math.max(0, from - start), Math.min(node.text!.length, to - start)) })
  }
  return result
}

/** Marks of the text character at a visible offset, or undefined for a line break or the block's end. */
function marksAt(nodes: readonly RichNode[], offset: number): RichMark[] | undefined | null {
  let position = 0
  for (const node of nodes) {
    const end = position + length(node)
    if (offset < end) return node.type === 'text' ? node.marks ?? [] : null
    position = end
  }
  return null
}

const markKey = (mark: RichMark) => JSON.stringify(mark)

/**
 * Marks for text replacing no characters (only line breaks, or nothing). A
 * neighbour inside the find wins over one outside it, so lengthening a
 * formatted run keeps its formatting; two neighbours on the same side of the
 * find give their shared marks. A link only grows into a gap it already spans.
 */
function insertionMarks(nodes: readonly RichNode[], from: number, to: number, beforeInFind: boolean, afterInFind: boolean): RichMark[] {
  const before = from > 0 ? marksAt(nodes, from - 1) : null
  const after = marksAt(nodes, to)
  const shared = (marks: RichMark[], other: RichMark[] | null | undefined) => {
    const keys = new Set((other ?? []).map(markKey))
    return marks.filter(mark => keys.has(markKey(mark)))
  }
  if (before && after && beforeInFind === afterInFind) return shared(before, after)
  const [inside, outside] = before && (beforeInFind || !after) ? [before, after] : [after ?? [], before]
  const links = shared(inside, outside)
  return inside.filter(mark => mark.type !== 'link' || links.includes(mark))
}

function mergeInline(nodes: readonly RichNode[]): RichNode[] {
  const result: RichNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && !node.text) continue
    const last = result.at(-1)
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      result[result.length - 1] = { ...last, text: last.text! + node.text! }
    } else result.push(node)
  }
  return result
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

const WORD = /[\p{L}\p{N}\p{M}_]/u
const isWord = (code: number | undefined) => code !== undefined && WORD.test(String.fromCodePoint(code))
/** True when offset `at` (never inside a surrogate pair) falls between two word characters. */
function splitsWord(text: string, at: number): boolean {
  if (at < 1 || at >= text.length) return false
  const back = at > 1 && isLowSurrogate(text.charCodeAt(at - 1)) ? 2 : 1
  return isWord(text.codePointAt(at - back)) && isWord(text.codePointAt(at))
}
/** Words, and every other character on its own. */
const tokens = (text: string) => text.match(/[\p{L}\p{N}\p{M}_]+|./gsu) ?? []

/** Marks every text character in [from, to) carries, or undefined when the range holds no text. */
function sharedMarks(nodes: readonly RichNode[], from: number, to: number): RichMark[] | undefined {
  const runs = slice(nodes, from, to).filter(node => node.type === 'text')
  if (!runs.length) return undefined
  return runs.reduce((marks, node) => {
    const keys = new Set((node.marks ?? []).map(markKey))
    return marks.filter(mark => keys.has(markKey(mark)))
  }, runs[0]!.marks ?? [])
}

/**
 * Text replacing visible offsets [from, to) with its marks. When the replaced
 * text and the new text split into the same sequence of words and single
 * other characters, each new token takes the marks shared by the token it
 * replaces; otherwise all new text takes the marks shared by every replaced
 * character. Either way a link covers new text only where it covered all of
 * the old text that text replaces.
 */
function replacementRuns(nodes: readonly RichNode[], text: string, from: number, to: number, inserted: string, fallback: () => RichMark[]) {
  const before = tokens(text.slice(from, to))
  const after = tokens(inserted)
  if (before.length !== after.length || before.length < 2
    || before.some((token, index) => WORD.test(token) !== WORD.test(after[index]!))) {
    return [{ text: inserted, marks: sharedMarks(nodes, from, to) ?? fallback() }]
  }
  let position = from
  return after.map((token, index) => {
    const start = position
    position += before[index]!.length
    return { text: token, marks: sharedMarks(nodes, start, position) ?? [] }
  })
}

function replaceInBlock(block: RichNode, start: number, find: string, replace: string): void {
  // Characters that find and replace share at either end stay untouched, so the
  // context an agent adds to make a match unique keeps its formatting.
  let prefix = 0
  while (prefix < find.length && prefix < replace.length && find[prefix] === replace[prefix]) prefix++
  if (prefix > 0 && isHighSurrogate(find.charCodeAt(prefix - 1))) prefix--
  let suffix = 0
  while (suffix < find.length - prefix && suffix < replace.length - prefix
    && find[find.length - 1 - suffix] === replace[replace.length - 1 - suffix]) suffix++
  if (suffix > 0 && isLowSurrogate(find.charCodeAt(find.length - suffix))) suffix--
  const nodes = block.content ?? []
  const text = visibleText(block)
  if (prefix + suffix < Math.min(find.length, replace.length) && block.type !== 'codeBlock') {
    // When text is both removed and added, the untouched context ends only
    // where it splits no word of find or replace, or at a formatting edge.
    const runEdge = (offset: number) => JSON.stringify(marksAt(nodes, offset - 1)) !== JSON.stringify(marksAt(nodes, offset))
    const keeps = (at: number, findAt: number, replaceAt: number) =>
      at === 0 || (!splitsWord(find, findAt) && !splitsWord(replace, replaceAt)) || runEdge(start + findAt)
    while (!keeps(prefix, prefix, prefix)) prefix -= isLowSurrogate(find.charCodeAt(prefix - 1)) ? 2 : 1
    while (!keeps(suffix, find.length - suffix, replace.length - suffix)) suffix -= isHighSurrogate(find.charCodeAt(find.length - suffix)) ? 2 : 1
  }
  const from = start + prefix
  const to = start + find.length - suffix
  const inserted = replace.slice(prefix, replace.length - suffix)
  const added: RichNode[] = []
  if (inserted) {
    if (block.type === 'codeBlock') added.push({ type: 'text', text: inserted })
    else {
      const insertion = () => insertionMarks(nodes, from, to, prefix > 0, suffix > 0)
      const runs = from < to ? replacementRuns(nodes, text, from, to, inserted, insertion) : [{ text: inserted, marks: insertion() }]
      for (const { text: value, marks } of runs) value.split('\n').forEach((line, index) => {
        if (index > 0) added.push({ type: 'hardBreak' })
        if (line) added.push(marks.length ? { type: 'text', text: line, marks } : { type: 'text', text: line })
      })
    }
  }
  const content = mergeInline([...slice(nodes, 0, from), ...added, ...slice(nodes, to, Infinity)])
  if (content.length) block.content = content
  else delete block.content
}

/**
 * Apply edits in order to a copy of the document. Each find must occur exactly
 * once as visible text inside a single paragraph, heading or code block (line
 * breaks read as "\n"); any failure leaves the document unchanged.
 */
export function applyTextEdits(doc: RichDoc, value: unknown): RichDoc {
  const edits = validateTextEdits(value)
  const copy = validateRichDoc(doc)
  const blocks: RichNode[] = []
  const collect = (node: RichNode) => {
    if (TEXTBLOCKS.has(node.type)) blocks.push(node)
    else for (const child of node.content ?? []) collect(child)
  }
  copy.content.forEach(collect)
  edits.forEach(({ find, replace }, index) => {
    let match: { block: RichNode; start: number } | undefined
    let count = 0
    for (const block of blocks) {
      const text = visibleText(block)
      for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) {
        count++
        match ??= { block, start: at }
      }
    }
    if (count === 0) invalid(`Edit ${index + 1}: text not found. Match the note's visible text inside one paragraph, heading, list item, table cell or code block, without Markdown markers such as ** or #.`)
    if (count > 1) invalid(`Edit ${index + 1} matches ${count} places; include more surrounding text.`)
    replaceInBlock(match!.block, match!.start, find, replace)
  })
  return validateRichDoc(copy)
}
