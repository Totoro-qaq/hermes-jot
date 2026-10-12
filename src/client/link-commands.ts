import { getMarkRange } from '@tiptap/core'
import type { Mark, MarkType } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'

const MAX_HREF = 2_048
const STORED_SCHEME = /^(?:https?:\/\/|mailto:|tel:|#)/iu
const WHITESPACE = /[\u0000-\u0020]/u
const EMAIL = /^[^\s@:]+@[^\s@]+\.[^\s@]+$/u
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/iu

/** 把用户输入收成存储层接受的 href。保留用户原文，不用 URL.href 改写。 */
export function normalizeLinkHref(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_HREF) return null
  if (STORED_SCHEME.test(trimmed)) {
    if (WHITESPACE.test(trimmed)) return null
    if (/^https?:\/\//iu.test(trimmed)) {
      try {
        const url = new URL(trimmed)
        if (url.username || url.password) return null
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      } catch { return null }
    }
    return trimmed
  }
  if (!WHITESPACE.test(trimmed) && EMAIL.test(trimmed)) {
    const href = `mailto:${trimmed}`
    return href.length <= MAX_HREF ? href : null
  }
  const phone = phoneHref(trimmed)
  if (phone) return phone
  if (!WHITESPACE.test(trimmed) && DOMAIN.test(trimmed)) {
    const href = `https://${trimmed}`
    if (href.length > MAX_HREF) return null
    try {
      const url = new URL(href)
      if (url.username || url.password) return null
    } catch { return null }
    return href
  }
  return null
}

function phoneHref(value: string): string | null {
  const compact = value.replace(/[\u0000-\u0020]+/gu, '')
  if (!/^\+?[\d().-]{5,}$/u.test(compact)) return null
  const digits = compact.replace(/\D/gu, '')
  if (digits.length < 5 || digits.length > 15) return null
  const href = `tel:${compact}`
  return href.length <= MAX_HREF && !WHITESPACE.test(href) ? href : null
}

/** 只有网页和邮箱可以在宿主里打开；电话和页内锚点只保存。 */
export function openableLinkHref(raw: string): string | null {
  const href = normalizeLinkHref(raw)
  return href && /^(?:https?:\/\/|mailto:)/iu.test(href) ? href : null
}

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

export function applyLinkEdit(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, input: { href: string; text: string }): boolean {
  const type = state.schema.marks.link
  if (!type) return false
  const href = normalizeLinkHref(input.href)
  if (!href) return false
  const range = linkTarget(state, type)
  if (!range) return false
  const current = state.doc.textBetween(range.from, range.to)
  const text = input.text.trim() || current || href
  if (!text || text.length > 10_000 || /[\u0000\n\r]/u.test(text)) return false
  const existing = state.doc.nodeAt(range.from)?.marks.find(mark => mark.type === type)
  if (text === current && range.from < range.to && existing?.attrs.href === href) return true
  if (!dispatch) return true
  const link = type.create({ ...(existing?.attrs ?? {}), href })
  let tr = state.tr
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
