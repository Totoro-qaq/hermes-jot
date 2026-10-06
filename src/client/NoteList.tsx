import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { JotActionIcon } from './icons.js'
import { activateNoteListItem, buildNoteListRows, formatNoteDate, highlightSegments, nextActiveNoteId, noteDateValue, noteDisplay, noteExcerpt, taskProgress } from './note-list.js'
import type { NavigationKey, NoteDateBasis } from './note-list.js'
import type { Folder, JotLocale, Note } from './types.js'

export interface NoteListProps {
  /** The caller owns filtering and the Recent collection's size. */
  notes: Note[]
  selectedId?: string | null
  onSelect: (note: Note) => void
  query?: string
  folders?: Folder[]
  locale?: JotLocale
  view: 'recent' | 'all' | 'trash'
  selectMode?: boolean
  selectedNoteIds?: ReadonlySet<string>
  onToggleSelection?: (note: Note) => void
  onContextMenu?: (note: Note, event: MouseEvent) => void
  dateBasis?: NoteDateBasis
  /** The current folder scope already names this metadata. */
  hideFolderName?: boolean
  /** Notes whose latest saved revision came from an agent tool. */
  agentEditedIds?: ReadonlySet<string>
}

function Highlight({ text, query }: { text: string; query: string }) {
  return <>{highlightSegments(text, query).map((part, index) => part.matched
    ? <mark key={index} style={{ background: 'var(--jot-search-highlight, #f5de94)', color: 'inherit', borderRadius: 2 }}>{part.text}</mark>
    : <span key={index}>{part.text}</span>)}</>
}

/** One continuous scroll surface; only the viewport, overscan, and active keyboard row are mounted. */
const noSelectedNotes: ReadonlySet<string> = new Set()

export function NoteList({ notes, selectedId = null, onSelect, query = '', folders = [], locale = 'zh', view,
  selectMode = false, selectedNoteIds = noSelectedNotes, onToggleSelection, onContextMenu, dateBasis = 'modified',
  hideFolderName = false, agentEditedIds = noSelectedNotes,
}: NoteListProps) {
  const parent = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<number | null>(null)
  const [activeId, setActiveId] = useState<string | null>(selectedId ?? notes[0]?.id ?? null)
  const en = locale === 'en'
  const needle = query.trim()
  const rows = useMemo(() => buildNoteListRows(notes, { query: needle, locale, dateBasis }), [notes, needle, locale, dateBasis])
  const noteRows = useMemo(() => rows.filter(row => row.kind === 'note'), [rows])
  const ids = useMemo(() => noteRows.map(row => row.note.id), [noteRows])
  const rowIndexes = useMemo(() => new Map(rows.flatMap((row, index) => row.kind === 'note' ? [[row.note.id, index] as const] : [])), [rows])
  const activeRowIndex = activeId === null ? undefined : rowIndexes.get(activeId)
  const folderNames = useMemo(() => new Map(folders.map(folder => [folder.id, folder.name])), [folders])
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows])
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const visible = defaultRangeExtractor(range)
    // Retaining one active row keeps native focus and screen-reader position stable during scrolling.
    if (activeRowIndex !== undefined && !visible.includes(activeRowIndex)) visible.push(activeRowIndex)
    return visible.sort((a, b) => a - b)
  }, [activeRowIndex])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: index => rows[index]?.kind === 'header' ? 30 : 88,
    getItemKey,
    overscan: 6,
    rangeExtractor,
  })

  useEffect(() => {
    if (selectedId !== null && rowIndexes.has(selectedId)) setActiveId(selectedId)
  }, [selectedId])
  useEffect(() => {
    setActiveId(current => current !== null && rowIndexes.has(current) ? current
      : selectedId !== null && rowIndexes.has(selectedId) ? selectedId : ids[0] ?? null)
  }, [rowIndexes, ids, selectedId])
  useEffect(() => {
    virtualizer.scrollToOffset(0)
  }, [needle, view])
  useEffect(() => () => {
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current)
  }, [])

  const activate = (note: Note) => activateNoteListItem(note, { selectMode, onSelect, onToggleSelection })

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Enter' || event.key === ' ') {
      const note = noteRows.find(row => row.note.id === activeId)?.note
      if (note) { event.preventDefault(); event.stopPropagation(); activate(note) }
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const nextId = nextActiveNoteId(ids, activeId, event.key as NavigationKey)
    if (nextId === null) return
    setActiveId(nextId)
    virtualizer.scrollToIndex(rowIndexes.get(nextId)!, { align: 'auto' })
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current)
    pendingFocus.current = requestAnimationFrame(() => {
      pendingFocus.current = null
      buttons.current.get(nextId)?.focus({ preventScroll: true })
    })
  }

  const label = needle
    ? en ? `${notes.length} search results` : `${notes.length} 条搜索结果`
    : en ? `${notes.length} ${view === 'trash' ? 'deleted notes' : 'notes'}` : `${notes.length} 条${view === 'trash' ? '已删除笔记' : '笔记'}`

  return <div ref={parent} className={`jot-note-list jot-virtual-note-list${needle ? ' jot-search-results' : ''}`} role="list" aria-label={label}
    tabIndex={ids.length ? -1 : 0} onKeyDown={navigate} style={{ overflowAnchor: 'none' }}>
    <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
      {virtualizer.getVirtualItems().map(item => {
        const row = rows[item.index]!
        const position = { position: 'absolute' as const, top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }
        if (row.kind === 'header') return <div key={item.key} ref={virtualizer.measureElement} data-index={item.index}
          role="presentation" style={position}>
          <h3 className="jot-list-label" style={{ margin: 0, fontWeight: 500 }}>
            <span>{row.label}</span><span aria-hidden="true">{row.count}</span>
          </h3>
        </div>
        const { note } = row
        const display = noteDisplay(note)
        const title = display.title || (en ? 'Untitled' : '无标题')
        const excerpt = noteExcerpt(display.body, needle) || (display.derived ? '' : en ? 'No content yet' : '还没有正文')
        const timestamp = noteDateValue(note, dateBasis)
        const date = formatNoteDate(timestamp, locale)
        // Unfiled is the default state, so only a real folder adds information.
        const folder = note.folderId === null ? '' : folderNames.get(note.folderId) ?? ''
        const progress = taskProgress(note.content)
        const agentEdited = agentEditedIds.has(note.id)
        return <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-note-id={note.id} role="listitem"
          aria-posinset={row.position} aria-setsize={notes.length}
          className={selectMode ? 'jot-note-selection-row' : undefined}
          onContextMenu={event => {
            if (!onContextMenu) return
            event.preventDefault()
            setActiveId(note.id)
            onContextMenu(note, event)
          }}
          style={selectMode ? { ...position, display: 'flex', alignItems: 'center', gap: 6 } : position}>
          {selectMode && <input type="checkbox" tabIndex={-1} checked={selectedNoteIds.has(note.id)}
            aria-label={en ? `Select ${title}` : `选择${title}`} style={{ flex: '0 0 auto', marginLeft: 12 }}
            onFocus={() => setActiveId(note.id)} onChange={() => { setActiveId(note.id); activate(note) }} />}
          <button type="button" className="jot-note-row" data-note-id={note.id} aria-current={selectedId === note.id ? 'true' : undefined}
            aria-pressed={selectMode ? selectedNoteIds.has(note.id) : undefined}
            style={selectMode ? { flex: '1 1 auto', minWidth: 0 } : undefined}
            tabIndex={activeId === note.id ? 0 : -1}
            ref={element => { if (element) buttons.current.set(note.id, element); else buttons.current.delete(note.id) }}
            onFocus={() => setActiveId(note.id)} onClick={() => { setActiveId(note.id); activate(note) }}>
            <span className={`jot-note-title${display.title ? '' : ' is-untitled'}`}><span><Highlight text={title} query={needle} /></span>
              {note.pinned && <span className="jot-note-pin" role="img" aria-label={en ? 'Pinned' : '已置顶'}><JotActionIcon name="pin" size={12} /></span>}
            </span>
            {excerpt && <div className="jot-note-excerpt" style={{ whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              <Highlight text={excerpt} query={needle} />
            </div>}
            <div className="jot-note-meta"><time dateTime={timestamp}>{date}</time>
              {progress.total > 0 && <span className="jot-note-progress" title={en ? `${progress.done} of ${progress.total} to-dos done` : `已完成 ${progress.done} / ${progress.total} 项待办`}
                aria-label={en ? `${progress.done} of ${progress.total} to-dos done` : `已完成 ${progress.done} / ${progress.total} 项待办`}>
                <JotActionIcon name="checklist" size={12} />{progress.done}/{progress.total}</span>}
              {agentEdited && <span className="jot-note-agent" title={en ? 'Last changed by AI' : '最近一次由 AI 修改'}>
                <JotActionIcon name="sparkle" size={12} />{en ? 'AI edited' : 'AI 修改'}</span>}
              {!hideFolderName && folder && <span className="jot-note-folder">{folder}</span>}</div>
          </button>
        </div>
      })}
    </div>
  </div>
}

export default NoteList
