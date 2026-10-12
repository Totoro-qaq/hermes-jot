import { getMarkRange } from '@tiptap/core'
import type { Mark, MarkType, Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { normalizeLinkHref } from '../link-href.js'
import { validateRichDoc } from '../model.js'

/**
 * 点击处文档里的链接地址。
 * 两条链接相接时，边界上的 `marks()` 会因为链接标记 inclusive 而落到左侧，所以先看右侧的 `nodeAfter`。
 */
function linkMarkHref(state: EditorState, pos: number): string | null {
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

/** 选区里一段连续文字和它的链接地址。没有链接时 href 为 null。 */
export interface LinkHrefSegment { text: string; href: string | null }

/** 选区里每一段文字当时的地址。相邻且地址相同的并成一段，换行等非文字节点跳过。 */
export function linkHrefSegments(doc: ProseMirrorNode, from: number, to: number): LinkHrefSegment[] {
  const link = doc.type.schema.marks.link
  if (!link || from >= to) return []
  const segments: LinkHrefSegment[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || !node.text) return
    const text = node.text.slice(Math.max(0, from - pos), Math.min(node.text.length, to - pos))
    if (!text) return
    const mark = link.isInSet(node.marks)
    const href = mark && mark.attrs.href ? String(mark.attrs.href) : null
    const last = segments.at(-1)
    if (last && last.href === href) last.text += text
    else segments.push({ text, href })
  })
  return segments
}

/**
 * 浮层打开时记下的范围，以及其中每一段的文字和地址。
 * 保存和删除前都要和正文对上；别人在这期间改了文字或任何一段的地址，就不写。
 */
export interface LinkCapture { from: number; to: number; segments: readonly LinkHrefSegment[] }

/**
 * 浮层要处理的范围。光标在链接里或选区落在一条链接之内时取整条链接，否则取选区。
 * `href` 是正在编辑的那条链接的地址，新建时为 null。
 */
export function captureLink(state: EditorState): LinkCapture & { href: string | null; text: string } {
  const { from, to, empty } = state.selection
  const found = linkUnderCaret(state)
  const editing = found && (empty || (from >= found.from && to <= found.to)) ? found : null
  const range = editing ?? { from, to }
  return {
    from: range.from,
    to: range.to,
    segments: linkHrefSegments(state.doc, range.from, range.to),
    href: editing?.href ?? null,
    text: state.doc.textBetween(range.from, range.to),
  }
}

function captureMatches(state: EditorState, captured: LinkCapture): boolean {
  if (captured.from < 0 || captured.to < captured.from || captured.to > state.doc.content.size) return false
  const now = linkHrefSegments(state.doc, captured.from, captured.to)
  return now.length === captured.segments.length
    && now.every((segment, index) => segment.text === captured.segments[index]!.text && segment.href === captured.segments[index]!.href)
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

/** 范围里第一段文字上的链接标记。选区从换行开始时 `nodeAt(from)` 是换行，读不到原有的链接属性。 */
function firstLinkMark(state: EditorState, range: { from: number; to: number }, type: MarkType): Mark | undefined {
  let first: ProseMirrorNode | null = null
  state.doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (first || !node.isText || Math.max(pos, range.from) >= Math.min(pos + node.nodeSize, range.to)) return
    first = node
  })
  return (first ?? state.doc.nodeAt(range.from))?.marks.find(mark => mark.type === type)
}

/**
 * 把范围改成链接。不传 `captured` 时按当前选区现取。
 * 正文和打开浮层时对不上返回 'stale'；跨段落、和链接互斥的标记或超出笔记限制时返回 false。
 */
export function applyLinkEdit(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  input: { href: string; text: string; captured?: LinkCapture },
): boolean | 'stale' {
  const type = state.schema.marks.link
  const href = normalizeLinkHref(input.href)
  if (!type || !href) return false
  if (input.captured && !captureMatches(state, input.captured)) return 'stale'
  const range = input.captured ?? captureLink(state)
  const $from = state.doc.resolve(range.from)
  if (!$from.sameParent(state.doc.resolve(range.to)) || !$from.parent.isTextblock || !$from.parent.type.allowsMarkType(type)) return false
  const current = state.doc.textBetween(range.from, range.to)
  // 空白输入表示沿用选区原文。用户留下的首尾空格要保留，不能 trim 后再写回去。
  const text = input.text.trim() ? input.text : (current || href)
  if (/[\u0000\n\r]/u.test(text)) return false
  const unchanged = text === current && range.from < range.to
  const segments = linkHrefSegments(state.doc, range.from, range.to)
  if (unchanged && segments.length === 1 && segments[0]!.href === href) return true
  const link = type.create({ ...(firstLinkMark(state, range, type)?.attrs ?? {}), href })
  let tr = state.tr
  if (unchanged) {
    // 文字没改时只加链接标记，原有的加粗、斜体和空格都留在各自的文本节点上。
    // 换行和其他行内节点不能带链接标记，只给文字段加，否则校验会把整次修改退回。
    tr = tr.removeMark(range.from, range.to, type)
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (!node.isText) return
      const start = Math.max(pos, range.from)
      const end = Math.min(pos + node.nodeSize, range.to)
      if (start < end) tr = tr.addMark(start, end, link)
    })
  } else {
    const empty = range.from === range.to
    const kept = keptMarks(state, range.from, type, empty)
    if (!kept) return false
    let node
    try { node = state.schema.text(text, [...kept, link]) } catch { return false }
    tr = empty ? tr.insert(range.from, node) : tr.replaceWith(range.from, range.to, node)
    tr = tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
  }
  // 先建事务并做和正式提交相同的校验。干跑不能在超长文字上提前返回 true。
  try { validateRichDoc(tr.doc.toJSON()) } catch { return false }
  dispatch?.(tr.scrollIntoView())
  return true
}

/**
 * 去掉链接，不改文字。传入浮层打开时的 `captured` 时，正文对不上就不动，避免删到旁边已经变了的链接。
 * 不传时去掉光标所在的整条链接。
 */
export function removeLink(state: EditorState, dispatch?: (tr: Transaction) => void, captured?: LinkCapture): boolean {
  const type = state.schema.marks.link
  if (!type || (captured && !captureMatches(state, captured))) return false
  const range = captured ?? linkUnderCaret(state)
  if (!range || range.from >= range.to || !state.doc.rangeHasMark(range.from, range.to, type)) return false
  dispatch?.(state.tr.removeMark(range.from, range.to, type).scrollIntoView())
  return true
}
