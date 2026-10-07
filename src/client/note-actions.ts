import { docFromText, MAX_TITLE_LENGTH, validateRichDoc } from '../model.js'
import type { NoteDraft } from './drafts.js'
import { translator } from './i18n.js'
import type { JotLocale, Note, NoteInput, RichDoc } from './types.js'

export type NoteSortMode = 'modified' | 'created' | 'title'
export interface ExcerptSource { label?: string; url?: string }

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const descendingDate = (left: string, right: string): number => {
  const a = Date.parse(left)
  const b = Date.parse(right)
  return (Number.isNaN(b) ? 0 : b) - (Number.isNaN(a) ? 0 : a)
}

/** Search relevance and pins retain priority; the selected sort orders each remaining rank. */
export function sortNotes(notes: readonly Note[], mode: NoteSortMode, query = ''): Note[] {
  const needle = query.trim().toLocaleLowerCase()
  return [...notes].sort((a, b) => {
    const titleRank = needle ? Number(b.title.toLocaleLowerCase().includes(needle)) - Number(a.title.toLocaleLowerCase().includes(needle)) : 0
    const priority = titleRank || Number(b.pinned) - Number(a.pinned)
    if (priority) return priority
    const selected = mode === 'title' ? titleCollator.compare(a.title, b.title)
      : mode === 'created' ? descendingDate(a.createdAt, b.createdAt) : descendingDate(a.updatedAt, b.updatedAt)
    return selected || descendingDate(a.updatedAt, b.updatedAt) || descendingDate(a.createdAt, b.createdAt)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

function titleWithin(text: string, max: number): string {
  let result = ''
  for (const part of segments.segment(text)) {
    if (result.length + part.segment.length > max) break
    result += part.segment
  }
  return result
}

/** Duplicate editable content without sharing nested marks, cells, or attachment attributes. */
export function duplicateNoteInput(draft: Pick<NoteDraft, 'title' | 'content' | 'folderId'>, locale: JotLocale = 'zh'): NoteInput {
  const t = translator(locale)
  const title = draft.title.trim() || t('Untitled')
  // The wording around the title ("{title} copy", "{title} のコピー") counts against the length limit.
  const room = MAX_TITLE_LENGTH - t('{title} copy', { title: '' }).length
  return { title: t('{title} copy', { title: titleWithin(title, room).trimEnd() }),
    content: structuredClone(draft.content), folderId: draft.folderId }
}

function safeSourceUrl(value: string): string | null {
  if (/[\u0000-\u0020]/u.test(value)) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2_048 ? url.href : null
  } catch { return null }
}

/** Append literal paragraphs and an optional source line, never parse captured text as HTML. */
export function appendExcerpt(existingDoc: RichDoc, text: string, source?: string | ExcerptSource): RichDoc {
  const current = validateRichDoc(existingDoc)
  const added = docFromText(text)
  const label = (typeof source === 'string' ? source : source?.label ?? '').trim()
  const rawUrl = (typeof source === 'string' ? source : source?.url ?? '').trim()
  const url = safeSourceUrl(rawUrl)
  const sourceText = typeof source === 'string' ? label : [label, rawUrl].filter(Boolean).join(' ')
  const blank = current.content.length === 1 && current.content[0]?.type === 'paragraph' && !current.content[0].content?.length
  const content = [...(blank ? [] : current.content), ...added.content]
  if (sourceText) {
    const prefix = '来源：'
    if (url) {
      const visibleUrl = typeof source === 'string' ? label : rawUrl
      content.push({ type: 'paragraph', content: [
        { type: 'text', text: prefix + (typeof source !== 'string' && label ? `${label} ` : '') },
        { type: 'text', text: visibleUrl, marks: [{ type: 'link', attrs: { href: url } }] },
      ] })
    } else content.push({ type: 'paragraph', content: [{ type: 'text', text: prefix + sourceText }] })
  }
  return validateRichDoc({ type: 'doc', content })
}
