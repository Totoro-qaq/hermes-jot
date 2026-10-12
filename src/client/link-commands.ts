import { getMarkRange } from '@tiptap/core'
import type { Mark, MarkType } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { httpHrefHasCredentials, normalizeLinkHref, openableLinkHref } from '../link-href.js'
import { validateRichDoc } from '../model.js'

export { normalizeLinkHref, openableLinkHref }

export interface LinkDraft { href: string; text: string }

/**
 * 点击处文档里的链接地址。
 * 两条链接相接时，边界上的 `marks()` 会因为链接标记 inclusive 而落到左侧，所以先看右侧的 `nodeAfter`。
 * 渲染时若没有 href，仍以标记为准，避免浏览器把空地址当成当前页。
 */
export function linkMarkHref(state: EditorState, pos: number): string | null {
  const link = state.schema.marks.link
  if (!link) return null
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)))
  const hrefOf = (marks: readonly Mark[] | undefined) => {
    const mark = marks ? link.isInSet(marks) : undefined
    const href = mark ? String(mark.attrs.href ?? '') : ''
    return href || null
  }
  return hrefOf($pos.nodeAfter?.marks) ?? hrefOf($pos.marks()) ?? hrefOf($pos.nodeBefore?.marks)
}

/** 空选区在两条链接相接处取右侧那条，和 `linkMarkHref` 用同一侧。 */
function linkRangePreferringNext(state: EditorState, pos: number, type: MarkType): { from: number; to: number } | null {
  const href = linkMarkHref(state, pos)
  if (!href) return null
  const size = state.doc.content.size
  const clamped = Math.max(0, Math.min(pos, size))
  const $pos = state.doc.resolve(clamped)
  const after = $pos.nodeAfter
  const afterHref = after?.isText ? linkMarkHref(state, Math.min(clamped + 1, size)) : null
  if (after?.isText && afterHref === href) {
    const range = getMarkRange(state.doc.resolve(Math.min(clamped + 1, size)), type)
    if (range) return range
  }
  return getMarkRange($pos, type) ?? null
}

/** 光标所在的链接。空选区在边界上取右侧；选区跨出链接时仍返回起点那条，由调用方决定要不要用。 */
export function linkUnderCaret(state: EditorState): { from: number; to: number; href: string; text: string } | null {
  const type = state.schema.marks.link
  if (!type) return null
  const range = state.selection.empty
    ? linkRangePreferringNext(state, state.selection.from, type)
    : getMarkRange(state.selection.$from, type) ?? null
  if (!range) return null
  const mark = state.doc.nodeAt(range.from)?.marks.find(item => item.type === type)
  if (!mark || typeof mark.attrs.href !== 'string') return null
  return { from: range.from, to: range.to, href: mark.attrs.href, text: state.doc.textBetween(range.from, range.to) }
}

export function readLinkDraft(state: EditorState): LinkDraft | null {
  const found = linkUnderCaret(state)
  return found ? { href: found.href, text: found.text } : null
}

/** 光标在链接内时改整段链接；否则只处理当前选区。选区必须落在同一个文本块里。 */
function linkTarget(state: EditorState, type: MarkType): { from: number; to: number } | null {
  const { selection } = state
  const { $from, $to } = selection
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  const around = selection.empty
    ? linkRangePreferringNext(state, selection.from, type)
    : getMarkRange($from, type) ?? null
  if (around && (selection.empty || (selection.from >= around.from && selection.to <= around.to))) return around
  if (!$from.parent.type.allowsMarkType(type)) return null
  return { from: selection.from, to: selection.to }
}

/**
 * 插入时要留下的标记。光标收起时没有字符可读，用当前存储的标记，避免丢掉刚打开的粗体。
 * 空数组表示用户清掉了标记，不能再退回到光标两侧的标记。
 * 和链接互斥的标记（例如行内代码）返回 null，调用方整次编辑都取消。
 */
function keptMarks(state: EditorState, from: number, type: MarkType, empty: boolean): readonly Mark[] | null {
  const node = state.doc.nodeAt(from)
  const marks = empty
    ? (state.storedMarks ?? state.doc.resolve(from).marks())
    : node?.isText ? node.marks : state.storedMarks ?? state.selection.$from.marks()
  const kept = marks.filter(mark => mark.type !== type)
  if (kept.some(mark => mark.type.excludes(type) || type.excludes(mark.type))) return null
  return kept
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

/** 这一段里的链接地址。混着不同地址或有的字没有链接时返回 null。 */
function hrefInRange(state: EditorState, from: number, to: number): string | null {
  const link = state.schema.marks.link
  if (!link || from === to) return null
  let href: string | null | undefined
  state.doc.nodesBetween(from, to, node => {
    if (!node.isText) return
    const mark = link.isInSet(node.marks)
    const value = mark ? String(mark.attrs.href ?? '') : null
    if (href === undefined) href = value
    else if (href !== value) href = null
  })
  return href || null
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
  if (!text || /[\u0000\n\r]/u.test(text)) return false
  const existing = state.doc.nodeAt(range.from)?.marks.find(mark => mark.type === type)
  if (text === current && range.from < range.to && rangeCarriesLink(state, range, type, href)) return true
  const link = type.create({ ...(existing?.attrs ?? {}), href })
  const empty = range.from === range.to
  let tr = state.tr
  // 文字没改时只加链接标记，原有的加粗、斜体和空格都留在各自的文本节点上。
  if (text === current && range.from < range.to) tr = tr.removeMark(range.from, range.to, type).addMark(range.from, range.to, link)
  else {
    const kept = keptMarks(state, range.from, type, empty)
    if (!kept) return false
    let node
    try { node = state.schema.text(text, [...kept, link]) } catch { return false }
    tr = empty ? tr.insert(range.from, node) : tr.replaceWith(range.from, range.to, node)
    tr = tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
  }
  // 先建事务并做和正式提交相同的校验。干跑不能在超长文字上提前返回 true。
  try { validateRichDoc(tr.doc.toJSON()) } catch { return false }
  if (!dispatch) return true
  dispatch(tr.scrollIntoView())
  return true
}

/**
 * 去掉光标所在的整段链接，不改文字。
 * 传入浮层打开时记下的地址和原文时，对不上就不动，避免选区已经滑到旁边的链接上。
 */
export function removeLink(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  captured?: { from: number; to: number; href?: string | null; original?: string },
): boolean {
  const type = state.schema.marks.link
  if (!type) return false
  let from: number
  let to: number
  if (captured) {
    const size = state.doc.content.size
    if (captured.from < 0 || captured.to < captured.from || captured.from > size || captured.to > size) return false
    from = captured.from
    to = captured.to
    if (from === to) {
      const found = linkRangePreferringNext(state, from, type)
      if (!found) return false
      from = found.from
      to = found.to
    }
  } else {
    const range = state.selection.empty
      ? linkRangePreferringNext(state, state.selection.from, type)
      : getMarkRange(state.selection.$from, type) ?? null
    if (!range) return false
    from = range.from
    to = range.to
  }
  if (from >= to || !state.doc.rangeHasMark(from, to, type)) return false
  if (captured?.href != null && hrefInRange(state, from, to) !== captured.href) return false
  if (captured?.original !== undefined && state.doc.textBetween(from, to) !== captured.original) return false
  if (!dispatch) return true
  dispatch(state.tr.removeMark(from, to, type).scrollIntoView())
  return true
}

/**
 * 原生 `click` 和中键 `auxclick` 会跟着 href 导航，mouseup 上的 preventDefault 拦不住。
 * 只拦带账号口令的地址；附件卡片和普通链接仍走原来的点击处理。
 */
export function blockCredentialLinkEvent(event: { type: string; preventDefault(): void }, href: string | null, attachment: boolean): boolean {
  if (attachment || (event.type !== 'click' && event.type !== 'auxclick')) return false
  if (!href || !httpHrefHasCredentials(href)) return false
  event.preventDefault()
  return true
}

/** 删除时只用浮层打开那一刻的地址和原文。之后改过的输入不能拿来比对，否则删除会静默失败。 */
export function openedLinkRange(draft: {
  from: number
  to: number
  original: string
  originalHref: string | null
}): { from: number; to: number; original: string; href: string | null } {
  return { from: draft.from, to: draft.to, original: draft.original, href: draft.originalHref }
}
