import { Fragment, Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'

export interface DocumentMatch { from: number; to: number; text: string }

/** Literal matches within a text block, including across differently marked text nodes. */
export function findMatches(doc: ProseMirrorNode, query: string, options: { caseSensitive?: boolean } = {}): DocumentMatch[] {
  if (!query) return []
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase()
  const matches: DocumentMatch[] = []
  doc.descendants((node, position) => {
    if (!node.isTextblock) return
    let text = ''
    node.forEach(child => {
      text += child.isText ? child.text! : child.type.name === 'hardBreak' ? '\n' : '\uFFFC'.repeat(child.nodeSize)
    })
    const folded = options.caseSensitive ? text : text.toLocaleLowerCase()
    let offsets: Array<{ from: number; to: number }> | undefined
    if (folded.length !== text.length) {
      offsets = []
      let offset = 0
      for (const character of text) {
        for (let count = 0; count < character.toLocaleLowerCase().length; count++) offsets.push({ from: offset, to: offset + character.length })
        offset += character.length
      }
    }
    for (let cursor = 0; cursor <= folded.length - needle.length;) {
      const index = folded.indexOf(needle, cursor)
      if (index < 0) break
      const from = offsets?.[index]?.from ?? index
      const to = offsets?.[index + needle.length - 1]?.to ?? index + needle.length
      const original = text.slice(from, to)
      if (!original.includes('\uFFFC')) {
        const match = { from: position + 1 + from, to: position + 1 + to, text: original }
        if (matches[matches.length - 1]?.to !== match.to) matches.push(match)
      }
      cursor = index + needle.length
    }
    return false
  })
  return matches
}

interface TextBlockMatches { node: ProseMirrorNode; start: number; matches: DocumentMatch[] }

function groupMatches(state: EditorState, matches: readonly DocumentMatch[]): TextBlockMatches[] {
  const ordered = [...matches].sort((a, b) => a.from - b.from)
  let previousEnd = -1
  const invalid = () => { throw new Error('The document changed. Find the text again before replacing it.') }
  for (const match of ordered) {
    if (!Number.isSafeInteger(match.from) || !Number.isSafeInteger(match.to) || match.from < 0 || match.from >= match.to
      || match.to > state.doc.content.size || match.from < previousEnd) invalid()
    previousEnd = match.to
  }
  const groups: TextBlockMatches[] = []
  let cursor = 0
  state.doc.descendants((node, position) => {
    if (!node.isTextblock) return
    const start = position + 1
    const end = start + node.content.size
    if (cursor < ordered.length && ordered[cursor]!.from < start) invalid()
    const contained: DocumentMatch[] = []
    while (cursor < ordered.length && ordered[cursor]!.from < end) {
      const match = ordered[cursor++]!
      if (match.to > end || node.textBetween(match.from - start, match.to - start, '\n', '\n') !== match.text) invalid()
      contained.push(match)
    }
    if (contained.length) groups.push({ node, start, matches: contained })
    return false
  })
  if (cursor !== ordered.length) invalid()
  return groups
}

/** Coalesce equal-mark text in one join, rather than retaining a document snapshot for every hit. */
function replacedFragment(state: EditorState, group: TextBlockMatches, replacement: string): Fragment {
  const nodes: ProseMirrorNode[] = []
  let chunks: string[] = []
  let marks: readonly Mark[] = []
  const flush = () => {
    if (chunks.length) { nodes.push(state.schema.text(chunks.join(''), marks)); chunks = [] }
  }
  const text = (value: string, nextMarks: readonly Mark[]) => {
    if (!value) return
    if (chunks.length && !Mark.sameSet(marks, nextMarks)) flush()
    if (!chunks.length) marks = nextMarks
    chunks.push(value)
  }
  const fragment = (value: Fragment) => value.forEach(node => {
    if (node.isText) text(node.text!, node.marks)
    else { flush(); nodes.push(node) }
  })
  let cursor = group.matches[0]!.from - group.start
  for (const match of group.matches) {
    const from = match.from - group.start
    if (cursor < from) fragment(group.node.content.cut(cursor, from))
    if (replacement) text(replacement, group.node.nodeAt(from)?.marks ?? [])
    cursor = match.to - group.start
  }
  flush()
  return Fragment.fromArray(nodes)
}

/** Replacements are schema text nodes, never HTML; one transaction is one undo operation. */
export function replaceAllMatches(state: EditorState, matches: readonly DocumentMatch[], replacement: string): Transaction {
  if (typeof replacement !== 'string') throw new Error('Replacement must be text.')
  const groups = groupMatches(state, matches)
  const transaction = closeHistory(state.tr)
  // Descending block order keeps earlier document positions unchanged. Each block
  // contributes at most one step, even when a 200k-character paragraph is all hits.
  for (const group of groups.reverse()) {
    const first = group.matches[0]!
    const last = group.matches[group.matches.length - 1]!
    transaction.replaceWith(first.from, last.to, replacedFragment(state, group, replacement))
  }
  return transaction
}

export function replaceMatch(state: EditorState, match: DocumentMatch, replacement: string): Transaction {
  return replaceAllMatches(state, [match], replacement)
}
