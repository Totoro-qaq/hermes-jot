/**
 * The agent's view of a note: the Markdown subset that docFromMarkdown reads
 * back. Anything the subset cannot express is still written readably, and
 * agentMarkdownRoundTrips decides whether a text rewrite would keep formatting.
 */
import { MAX_TEXT_LENGTH, boundedString, docFromMarkdown, docFromText, validateRichDoc, type RichDoc, type RichMark, type RichNode } from './model.js'

// Inner to outer, so a combined mark still reads as nested Markdown. The
// underscore forms parse the same and keep a run readable next to a literal *.
const WRAP = [['strike', '~~', '~~'], ['italic', '*', '_'], ['bold', '**', '__']] as const

const sameMarks = (a?: RichMark[], b?: RichMark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

/** Adjacent text with equal marks is one run; empty text disappears. */
function mergeText(nodes: readonly RichNode[]): RichNode[] {
  const result: RichNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && !node.text) continue
    const last = result.at(-1)
    if (node.type === 'text' && last?.type === 'text' && sameMarks(last.marks, node.marks)) {
      result[result.length - 1] = { ...last, text: last.text! + node.text! }
    } else result.push(node)
  }
  return result
}

function run(node: RichNode, lineBreak: string, before = '', after = ''): string {
  if (node.type === 'hardBreak') return lineBreak
  let text = node.text ?? ''
  const marks = new Map((node.marks ?? []).map(mark => [mark.type, mark]))
  if (marks.has('code')) text = '`' + text + '`'
  const link = marks.get('link')
  if (link) text = `[${text}](${String(link.attrs?.href ?? '')})`
  for (const [type, star, underscore] of WRAP) if (marks.has(type)) {
    const alternate = underscore !== '~~' && !text.includes('_') && (text.includes('*') || before === '*' || after === '*')
    text = alternate ? underscore + text + underscore : star + text + star
  }
  return text
}

function inline(nodes: readonly RichNode[] | undefined, lineBreak: string): string {
  const runs = mergeText(nodes ?? [])
  let output = ''
  runs.forEach((node, index) => {
    const next = runs[index + 1]
    output += run(node, lineBreak, output.at(-1), next ? run(next, lineBreak)[0] : '')
  })
  return output
}

const indent = (text: string, prefix: string, rest = prefix) =>
  text.split('\n').map((line, index) => (index === 0 ? prefix : rest) + line).join('\n')

function listItem(item: RichNode, marker: string): string {
  const [first, ...rest] = item.content ?? []
  const head = first?.type === 'paragraph' ? inline(first.content, '\n') : first ? block(first) : ''
  const lines = [indent(head, marker, '  '), ...rest.map(child => indent(block(child), '  '))]
  return lines.join('\n')
}

function cell(node: RichNode): string {
  return (node.content ?? []).map(child => child.type === 'paragraph' ? inline(child.content, ' ') : block(child))
    .join(' ').replace(/\n/gu, ' ').trim()
}

function block(node: RichNode): string {
  switch (node.type) {
    case 'paragraph': return inline(node.content, '\n')
    case 'heading': return '#'.repeat(Number(node.attrs?.level ?? 1)) + ' ' + inline(node.content, '\n')
    case 'codeBlock': {
      const text = (node.content ?? []).map(child => child.text ?? '').join('')
      return '```' + String(node.attrs?.language ?? '') + '\n' + (text ? text + '\n' : '') + '```'
    }
    case 'horizontalRule': return '---'
    case 'bulletList': return (node.content ?? []).map(item => listItem(item, '- ')).join('\n')
    case 'taskList': return (node.content ?? []).map(item => listItem(item, item.attrs?.checked ? '- [x] ' : '- [ ] ')).join('\n')
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return (node.content ?? []).map((item, index) => listItem(item, `${start + index}. `)).join('\n')
    }
    case 'blockquote':
      return (node.content ?? []).map(block).join('\n').split('\n').map(line => line ? '> ' + line : '>').join('\n')
    case 'table': {
      const rows = (node.content ?? []).map(row => (row.content ?? []).flatMap(item =>
        [cell(item), ...Array.from({ length: Number(item.attrs?.colspan ?? 1) - 1 }, () => '')]))
      const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |'
      return rows.map((cells, index) => index === 0
        ? line(cells) + '\n' + line(cells.map(() => '---')) : line(cells)).join('\n')
    }
    case 'image': return node.attrs?.alt ? `[image: ${String(node.attrs.alt)}]` : '[image]'
    case 'attachment': return node.attrs?.caption ? `[file: ${String(node.attrs.caption)}]` : '[file]'
    default: return (node.content ?? []).map(block).join('\n')
  }
}

/** Top-level paragraphs holding nothing visible are spacing; Markdown blank lines cannot keep them. */
function isSpacing(node: RichNode): boolean {
  return node.type === 'paragraph' && (node.content ?? []).every(child =>
    child.type === 'hardBreak' || (child.type === 'text' && !child.marks?.length && !child.text!.trim()))
}

/** Serialize to the Markdown subset docFromMarkdown parses, without escaping (the parser has none). */
export function docToAgentMarkdown(doc: RichDoc): string {
  return validateRichDoc(doc).content.filter(node => !isSpacing(node)).map(block).join('\n\n')
}

/** Editor-only attributes and no-op marks that a Markdown rewrite may drop without visible change. */
function canonicalMarks(marks: readonly RichMark[] | undefined): RichMark[] | undefined {
  const result = (marks ?? []).flatMap((mark): RichMark[] => {
    if (mark.type === 'textStyle' && mark.attrs?.color == null) return []
    if (mark.type === 'link') {
      // target, rel and class are the editor's rendering defaults; Markdown links receive them on load.
      const title = mark.attrs?.title
      return [{ type: 'link', attrs: { href: mark.attrs!.href!, ...title ? { title } : {} } }]
    }
    return [mark.attrs ? { type: mark.type, attrs: mark.attrs } : { type: mark.type }]
  }).sort((a, b) => a.type.localeCompare(b.type))
  return result.length ? result : undefined
}

function canonical(node: RichNode): RichNode {
  if (node.type === 'text') {
    const marks = canonicalMarks(node.marks)
    return { type: 'text', text: node.text!, ...marks ? { marks } : {} }
  }
  let attrs = node.attrs
  if (node.type === 'orderedList') attrs = { start: Number(attrs?.start ?? 1) }
  if (node.type === 'codeBlock') attrs = { language: attrs?.language || null }
  const content = mergeText((node.content ?? []).map(canonical))
  return { type: node.type, ...attrs ? { attrs } : {}, ...content.length ? { content } : {} }
}

const comparable = (doc: RichDoc) => JSON.stringify(validateRichDoc(doc).content.filter(node => !isSpacing(node)).map(canonical))

/**
 * True when writing the note back from its agent Markdown reproduces it,
 * ignoring spacing paragraphs and editor-only defaults.
 */
export function agentMarkdownRoundTrips(doc: RichDoc): boolean {
  try {
    return comparable(docFromMarkdown(docToAgentMarkdown(doc))) === comparable(doc)
  } catch { return false }
}

/**
 * Agent text in format "plain": every line is a literal paragraph. Blank lines
 * separate paragraphs, as in the Markdown jot_read returns, and are not kept.
 */
export function docFromAgentText(text: string): RichDoc {
  boundedString(text, MAX_TEXT_LENGTH, 'text')
  return docFromText(text.replace(/\r\n?/gu, '\n').replace(/\n{2,}/gu, '\n'))
}

/**
 * True when writing the note back from its agent Markdown with format "plain"
 * reproduces it, ignoring spacing paragraphs and editor-only defaults: in
 * practice, unformatted paragraphs without line breaks.
 */
export function plainTextRoundTrips(doc: RichDoc): boolean {
  try {
    return comparable(docFromAgentText(docToAgentMarkdown(doc))) === comparable(doc)
  } catch { return false }
}
