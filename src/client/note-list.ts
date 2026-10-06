import type { JotLocale, Note, RichNode } from './types.js'

export type NoteDateGroup = 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier'
export type NoteListRow =
  | { kind: 'header'; key: string; group: NoteDateGroup; label: string; count: number }
  | { kind: 'note'; key: string; note: Note; position: number }
export type NavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
export type NoteDateBasis = 'modified' | 'created' | 'none'
export interface HighlightSegment { text: string; matched: boolean }

const GROUPS: NoteDateGroup[] = ['pinned', 'today', 'yesterday', 'week', 'earlier']
const GROUP_LABELS = {
  zh: { pinned: '置顶', today: '今天', yesterday: '昨天', week: '过去 7 天', earlier: '更早' },
  en: { pinned: 'Pinned', today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 Days', earlier: 'Earlier' },
}

/** Calendar dates, rather than elapsed 24-hour periods, keep midnight and DST boundaries correct. */
function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
}

export function noteDateValue(note: Pick<Note, 'createdAt' | 'updatedAt'>, basis: NoteDateBasis = 'modified'): string {
  return basis === 'created' ? note.createdAt : note.updatedAt
}

export function noteDateGroup(note: Pick<Note, 'pinned' | 'updatedAt'> & Partial<Pick<Note, 'createdAt'>>, now = new Date(), basis: NoteDateBasis = 'modified'): NoteDateGroup {
  if (note.pinned) return 'pinned'
  const date = new Date(basis === 'created' ? note.createdAt ?? '' : note.updatedAt)
  if (Number.isNaN(date.getTime())) return 'earlier'
  const age = calendarDay(now) - calendarDay(date)
  if (age === 0) return 'today'
  if (age === 1) return 'yesterday'
  return age > 1 && age < 7 ? 'week' : 'earlier'
}

/** The library search predicate shared by the list and its empty state. */
export function noteMatchesQuery(note: Pick<Note, 'title' | 'text'>, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || note.title.toLocaleLowerCase().includes(needle) || note.text.toLocaleLowerCase().includes(needle)
}

/** Where else a search with no visible results would match, so the empty state can offer that scope. */
export interface SearchElsewhere {
  /** Matches in the same view (notes or Trash) once the folder filter is removed; 0 when no folder filter applies. */
  otherFolders: number
  /** Matches in the opposite view across all folders: Trash from the notes views, notes from Trash. */
  otherView: number
}

export function searchElsewhere(notes: readonly Note[], query: string, options: { trash: boolean; folderFiltered: boolean }): SearchElsewhere {
  if (!query.trim()) return { otherFolders: 0, otherView: 0 }
  let otherFolders = 0
  let otherView = 0
  for (const note of notes) {
    if (!noteMatchesQuery(note, query)) continue
    if ((note.deletedAt !== null) === options.trash) { if (options.folderFiltered) otherFolders++ }
    else otherView++
  }
  return { otherFolders, otherView }
}

/** Keep the caller's order inside each rank. Search results must never be regrouped by date. */
export function titleMatchesFirst(notes: readonly Note[], query = ''): Note[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...notes]
  return notes.map((note, index) => ({ note, index, titleMatch: note.title.toLocaleLowerCase().includes(needle) }))
    .sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || a.index - b.index)
    .map(item => item.note)
}

export function buildNoteListRows(notes: readonly Note[], options: { query?: string; locale?: JotLocale; now?: Date; dateBasis?: NoteDateBasis } = {}): NoteListRow[] {
  const { query = '', locale = 'zh', now = new Date(), dateBasis = 'modified' } = options
  if (query.trim() || dateBasis === 'none') return titleMatchesFirst(notes, query).map((note, index) => ({
    kind: 'note', key: `note:${note.id}`, note, position: index + 1,
  }))
  const grouped = new Map<NoteDateGroup, Note[]>(GROUPS.map(group => [group, []]))
  for (const note of notes) grouped.get(noteDateGroup(note, now, dateBasis))!.push(note)
  const rows: NoteListRow[] = []
  let position = 0
  for (const group of GROUPS) {
    const members = grouped.get(group)!
    if (!members.length) continue
    rows.push({ kind: 'header', key: `header:${group}`, group, label: GROUP_LABELS[locale][group], count: members.length })
    for (const note of members) rows.push({ kind: 'note', key: `note:${note.id}`, note, position: ++position })
  }
  return rows
}

/** A batch-selection gesture must never open a note, including while its handler is unavailable. */
export function activateNoteListItem(note: Note, options: {
  selectMode?: boolean
  onSelect: (note: Note) => void
  onToggleSelection?: (note: Note) => void
}): void {
  if (options.selectMode) options.onToggleSelection?.(note)
  else options.onSelect(note)
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Map case-folded match positions back to the original graphemes, including expanding Unicode lowercase forms. */
function firstMatch(text: string, query: string): { start: number; end: number } | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return null
  const folded = text.toLocaleLowerCase()
  const start = folded.indexOf(needle)
  if (start < 0) return null
  const end = start + needle.length
  if (folded.length === text.length) {
    const segments = segmenter.segment(text)
    const first = segments.containing(start)
    const last = segments.containing(end - 1)
    if (first && last) return { start: first.index, end: last.index + last.segment.length }
  }
  let offset = 0
  let originalStart: number | undefined
  for (const part of segmenter.segment(text)) {
    const nextOffset = offset + part.segment.toLocaleLowerCase().length
    if (originalStart === undefined && start < nextOffset) originalStart = part.index
    if (end <= nextOffset) return { start: originalStart ?? part.index, end: part.index + part.segment.length }
    offset = nextOffset
  }
  return null
}

/**
 * Derived note text is also the persisted search/agent representation and keeps
 * its `[x]` task markers. List previews present the words, not that syntax.
 */
export function noteListText(text: string): string {
  return text.replace(/^\[(?:x| )\] /gmu, '').replace(/^-{3}$/gmu, '')
}

export interface NoteDisplay {
  /** The saved title, or the first body line when the title is empty. */
  title: string
  /** True when the title was borrowed from the body. */
  derived: boolean
  /** Preview text, without the borrowed first line. */
  body: string
}

/** Untitled notes borrow their first line, as most note apps do; nothing is written back. */
export function noteDisplay(note: Pick<Note, 'title' | 'text'>, maxTitle = 80): NoteDisplay {
  const body = noteListText(note.text)
  if (note.title.trim()) return { title: note.title, derived: false, body }
  const lines = body.split('\n')
  const index = lines.findIndex(line => line.trim())
  if (index < 0) return { title: '', derived: false, body: '' }
  const first = lines[index]!.replace(/\s+/gu, ' ').trim()
  let title = ''
  let count = 0
  for (const part of segmenter.segment(first)) {
    if (count++ >= maxTitle) { title += '…'; break }
    title += part.segment
  }
  return { title, derived: true, body: lines.slice(index + 1).join('\n') }
}

export interface TaskProgress { done: number; total: number }

/** Count checklist items anywhere in a document, including nested lists and table cells. */
export function taskProgress(node: RichNode | undefined): TaskProgress {
  const progress = { done: 0, total: 0 }
  const visit = (current: RichNode) => {
    if (current.type === 'taskItem') {
      progress.total++
      if (current.attrs?.checked === true) progress.done++
    }
    for (const child of current.content ?? []) visit(child)
  }
  if (node) visit(node)
  return progress
}

/** A body hit gets its surrounding context; clipping never divides emoji, surrogate pairs, or combining characters. */
export function noteExcerpt(text: string, query = '', maxGraphemes = 140): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const segments = segmenter.segment(normalized)
  const limit = Number.isFinite(maxGraphemes) ? Math.max(1, Math.floor(maxGraphemes)) : 140
  const match = firstMatch(normalized, query.replace(/\s+/gu, ' '))
  let matchSize = 0
  if (match) for (let index = match.start; index < match.end;) {
    const part = segments.containing(index)!
    index = part.index + part.segment.length
    matchSize++
  }
  const budget = Math.max(limit, matchSize)
  let start = match?.start ?? 0
  // A narrow panel shows only two lines; keep the actual hit inside that viewport.
  const before = match ? Math.min(16, Math.floor((budget - matchSize) * 0.35)) : 0
  for (let count = 0; count < before && start > 0; count++) start = segments.containing(start - 1)!.index
  let end = start
  let included = 0
  while (end < normalized.length && included < budget) {
    const part = segments.containing(end)!
    end = part.index + part.segment.length
    included++
  }
  if (end === normalized.length) {
    while (start > 0 && included < budget) { start = segments.containing(start - 1)!.index; included++ }
  }
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`
}

export function highlightSegments(text: string, query = ''): HighlightSegment[] {
  if (!query.trim()) return [{ text, matched: false }]
  const result: HighlightSegment[] = []
  let remaining = text
  while (remaining) {
    const match = firstMatch(remaining, query)
    if (!match) { result.push({ text: remaining, matched: false }); break }
    if (match.start > 0) result.push({ text: remaining.slice(0, match.start), matched: false })
    result.push({ text: remaining.slice(match.start, match.end), matched: true })
    remaining = remaining.slice(match.end)
  }
  return result.length ? result : [{ text, matched: false }]
}

/** Navigation operates on note ids only, so date headers never receive keyboard selection. */
export function nextActiveNoteId(ids: readonly string[], current: string | null, key: NavigationKey): string | null {
  if (!ids.length) return null
  if (key === 'Home') return ids[0]!
  if (key === 'End') return ids[ids.length - 1]!
  const index = current === null ? -1 : ids.indexOf(current)
  if (index < 0) return key === 'ArrowUp' ? ids[ids.length - 1]! : ids[0]!
  const next = Math.max(0, Math.min(ids.length - 1, index + (key === 'ArrowDown' ? 1 : -1)))
  return ids[next]!
}

export function formatNoteDate(value: string, locale: JotLocale, now = new Date()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const sameDay = calendarDay(date) === calendarDay(now)
  return new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'zh-CN', sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }) }).format(date)
}
