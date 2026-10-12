import { getMarkRange } from '@tiptap/core'
import type { Mark, MarkType } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { normalizeLinkHref, openableLinkHref } from '../link-href.js'

export { normalizeLinkHref, openableLinkHref }

export interface LinkDraft { href: string; text: string }

export function readLinkDraft(state: EditorState): LinkDraft | null {
  const type = state.schema.marks.link
  if (!type) return null
  const range = getMarkRange(state.selection.$from, type)
  if (!range) return null
  const mark = state.doc.nodeAt(range.from)?.marks.find(item => item.type === type)
  if (!mark || typeof mark.attrs.href !== 'string') return null
  return { href: mark.attrs.href, text: state.doc.textBetween(range.from, range.to) }
}

/** 光标在链接内时改整段链接；否则只处理当前选区。选区必须落在同一个文本块里。 */
function linkTarget(state: EditorState, type: MarkType): { from: number; to: number } | null {
  const { selection } = state
  const { $from, $to } = selection
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  const around = getMarkRange($from, type)
  if (around && (selection.empty || (selection.from >= around.from && selection.to <= around.to))) return around
  if (!$from.parent.type.allowsMarkType(type)) return null
  return { from: selection.from, to: selection.to }
}

function keptMarks(state: EditorState, from: number, type: MarkType): readonly Mark[] {
  const node = state.doc.nodeAt(from)
  const marks = node?.isText ? node.marks : state.storedMarks ?? state.selection.$from.marks()
  return marks.filter(mark => mark.type !== type)
}

/** 选区里每一段文字都已经是这个 href 时，才算已经加上，不能只看开头。 */
function rangeCarriesLink(state: EditorState, range: { from: number; to: number }, type: MarkType, href: string): boolean {
  let carries = true
  let sawText = false
  state.doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isText) return
    const start = Math.max(pos, range.from)
    const end = Math.min(pos + node.nodeSize, range.to)
    if (start >= end) return
    sawText = true
    const mark = type.isInSet(node.marks)
    if (!mark || mark.attrs.href !== href) carries = false
  })
  return carries && sawText
}

export function applyLinkEdit(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, input: { href: string; text: string }): boolean {
  const type = state.schema.marks.link
  if (!type) return false
  const href = normalizeLinkHref(input.href)
  if (!href) return false
  const range = linkTarget(state, type)
  if (!range) return false
  const current = state.doc.textBetween(range.from, range.to)
  // 空白输入表示沿用选区原文。用户留下的首尾空格要保留，不能 trim 后再写回去。
  const typed = typeof input.text === 'string' ? input.text : ''
  const text = typed.trim() ? typed : (current || href)
  if (!text || text.length > 10_000 || /[\u0000\n\r]/u.test(text)) return false
  const existing = state.doc.nodeAt(range.from)?.marks.find(mark => mark.type === type)
  if (text === current && range.from < range.to && rangeCarriesLink(state, range, type, href)) return true
  if (!dispatch) return true
  const link = type.create({ ...(existing?.attrs ?? {}), href })
  let tr = state.tr
  // 文字没改时只加链接标记，原有的加粗、斜体和空格都留在各自的文本节点上。
  if (text === current && range.from < range.to) tr = tr.removeMark(range.from, range.to, type).addMark(range.from, range.to, link)
  else {
    const node = state.schema.text(text, [...keptMarks(state, range.from, type), link])
    tr = range.from === range.to ? tr.insert(range.from, node) : tr.replaceWith(range.from, range.to, node)
    tr = tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
  }
  dispatch(tr.scrollIntoView())
  return true
}

/** 去掉光标所在的整段链接，不改文字。 */
export function removeLink(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const type = state.schema.marks.link
  if (!type) return false
  const range = getMarkRange(state.selection.$from, type)
  if (!range) return false
  dispatch?.(state.tr.removeMark(range.from, range.to, type).scrollIntoView())
  return true
}
