import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JotApiError } from './api.js'
import { saveHumanDraft } from './save-draft.js'
import { draftFromNote, draftFingerprint, emptyDocument, receiveLatestDraft, reconcileDraft, sameDraftGeneration, sharedDraftStorage as defaultDraftStorage } from './drafts.js'
import type { NoteDraft } from './drafts.js'
import type { JotPersistence } from '../hermes/persistence.js'
import type { ReactNode } from 'react'
import { editHumanDraft, takeUntouchedFreshNote } from './draft-lifecycle.js'
import { RichEditor, type RichEditorActions } from '../hermes/EmbeddedEditor.js'
import { appShortcut } from './app-shortcuts.js'
import { ActionMenu, type ActionMenuEntry } from './ActionMenu.js'
import { JotActionIcon, type JotActionIconName } from './icons.js'
import { JotIcon } from './JotIcon.js'
import { Modal } from './Modal.js'
import { AttachmentPreview } from './AttachmentPreview.js'
import { CaptureDialog, type CaptureSubmission } from './CaptureDialog.js'
import { ShortcutHelp } from './ShortcutHelp.js'
import { ExportDialog } from './ExportDialog.js'
import { appendExcerpt, duplicateNoteInput, sortNotes, type NoteSortMode } from './note-actions.js'
import { downloadNote } from './downloads.js'
import { exportSavedLibrary } from './library-export.js'
import { describeError } from './errors.js'
import { jotStyles } from './styles.js'
import { NoteList } from './NoteList.js'
import { noteMatchesQuery, searchElsewhere } from './note-list.js'
import { NoteOpenConsumer, readHandoffDraft, type NoteOpenRequest } from './note-handoff.js'
import { consumeJotCommand, type JotCommandRequest } from './commands.js'
import { startLiveRefresh, type ChangeSignal } from './live-refresh.js'
import { askAgentMessage, type AskAgentNote, type AskAgentOutcome } from './ask-agent.js'
import { IMPORT_ACCEPT, importFileProblem, mergeImportResults, summarizeImport } from './import-notes.js'
import type { AttachmentInfo, ExportFormat, ImportResult, JotApi, JotLocale, JotState, LibraryExportFormat, Note, RichNode } from './types.js'
import type { AttachmentDialogRequest } from './attachment-dialog.js'

export interface JotAppProps {
  readSelectedText?: () => string
  onEditorSelection?: (text: string | null) => void
  persistence?: JotPersistence
  attachmentPreviewContent?: (attachment: AttachmentInfo) => ReactNode
  mode: 'compact' | 'wide'
  onExpand?: (noteId?: string, draftId?: string, noteRevision?: number) => void
  openNoteRequest?: NoteOpenRequest
  onNoteRequestHandled?: (revision: number) => void
  api: JotApi
  locale?: JotLocale
  onLocaleChange?: (locale: JotLocale) => void
  chromeInset?: boolean
  onEditorFocus?: (owner: object) => () => void
  /** false requests the local dialog; undefined retires a superseded gesture. */
  onAttachmentPreview?: (attachmentId: string, options?: { signal?: AbortSignal }) => Promise<boolean | undefined>
  attachmentDialogRequest?: AttachmentDialogRequest
  onAttachmentDialogHandled?: (revision: number) => void
  /** Host keyboard commands (new note, capture) addressed to this panel. */
  commandRequest?: JotCommandRequest
  /** Atomically acquire a still-current host recipient before any side effect. */
  onCommandClaim?: (revision: number) => boolean
  onCommandHandled?: (revision: number) => void
  /** Library changes pushed by the Host; without it the panel polls every few seconds. */
  changeSignal?: ChangeSignal
  /** Hand the open note to the conversation, as a reference the agent can read. */
  onAskAgent?: (note: AskAgentNote) => Promise<AskAgentOutcome>
}

type SavePhase = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
interface SaveStatus { phase: SavePhase; message?: string }
type ListView = 'recent' | 'all' | 'trash'
interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

const LIST_WIDTH = { min: 220, max: 480, initial: 280 }
const defaultPreferences = {
  get(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } },
  set(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* keep the session value */ }
  },
}
const editableTarget = (target: EventTarget | null) => target instanceof Element
  && Boolean(target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]'))

function Icon({ name }: { name: JotActionIconName }) {
  return <JotActionIcon name={name} />
}

export function JotApp({ readSelectedText, onEditorSelection, persistence, attachmentPreviewContent, mode, onExpand, openNoteRequest, onNoteRequestHandled, api, locale = 'en', onLocaleChange, chromeInset = false, onEditorFocus, onAttachmentPreview, attachmentDialogRequest, onAttachmentDialogHandled, commandRequest, onCommandClaim, onCommandHandled, changeSignal, onAskAgent }: JotAppProps) {
  const storage = persistence?.preferences ?? defaultPreferences
  const sharedDraftStorage = persistence?.drafts ?? defaultDraftStorage
  const { readDraft, persistDraft, editDraft, savedDraft, recoveryDrafts } = useMemo(() => ({
    readDraft: sharedDraftStorage.read.bind(sharedDraftStorage),
    persistDraft: sharedDraftStorage.persist.bind(sharedDraftStorage),
    editDraft: sharedDraftStorage.edit.bind(sharedDraftStorage),
    savedDraft: sharedDraftStorage.saved.bind(sharedDraftStorage),
    recoveryDrafts: sharedDraftStorage.all.bind(sharedDraftStorage),
  }), [sharedDraftStorage])
  const en = locale === 'en'
  const copy = (zh: string, english: string) => en ? english : zh
  const explain = (cause: unknown) => describeError(cause, locale)
  const [snapshot, setSnapshot] = useState<JotState | null>(null)
  const snapshotRef = useRef<JotState | null>(null)
  const refreshSequence = useRef(0)
  const acceptedRefresh = useRef(0)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const draftRef = useRef<NoteDraft | null>(null)
  const editorActions = useRef<RichEditorActions | null>(null)
  const [editorRevisions, setEditorRevisions] = useState<Record<string, number>>({})
  const editorFocusLease = useRef<(() => void) | null>(null)
  const releaseEditorFocus = useCallback(() => {
    editorFocusLease.current?.()
    editorFocusLease.current = null
  }, [])
  useEffect(() => releaseEditorFocus, [releaseEditorFocus])
  const drafts = useRef(new Map<string, NoteDraft>())
  const selectionGeneration = useRef(0)
  const uploadTarget = useRef<{ draft: NoteDraft; generation: number } | null>(null)
  const noteRequests = useRef(new NoteOpenConsumer(sharedDraftStorage))
  const requestedRefresh = useRef(0)
  const freshRequest = useRef(0)
  const currentOpenRequest = useRef(openNoteRequest)
  currentOpenRequest.current = openNoteRequest
  const inFlight = useRef(new Map<string, Promise<boolean>>())
  /** Notes this panel created that are still untouched; leaving one removes it instead of keeping clutter. */
  const freshNotes = useRef(new Set<string>())
  const focusTitle = useRef(false)
  const titleInput = useRef<HTMLInputElement>(null)
  const restoredLast = useRef(false)
  const [statuses, setStatuses] = useState<Record<string, SaveStatus>>({})
  const statusesRef = useRef<Record<string, SaveStatus>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<ListView>('recent')
  const [folderFilter, setFolderFilter] = useState('__all__')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [compactEditor, setCompactEditor] = useState(false)
  const [folderForm, setFolderForm] = useState<'create' | 'rename' | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderDeleteConfirm, setFolderDeleteConfirm] = useState(false)
  const [sortMode, setSortMode] = useState<NoteSortMode>(() => {
    const value = storage.get('hermes-jot:sort:v1')
    return value === 'created' || value === 'title' ? value : 'modified'
  })
  useEffect(() => { storage.set('hermes-jot:sort:v1', sortMode) }, [sortMode])
  const [listWidth, setListWidth] = useState(() => {
    const value = Number(storage.get('hermes-jot:list-width:v1'))
    return Number.isFinite(value) && value >= LIST_WIDTH.min && value <= LIST_WIDTH.max ? value : LIST_WIDTH.initial
  })
  const [listCollapsed, setListCollapsed] = useState(() => storage.get('hermes-jot:list-collapsed:v1') === '1')
  useEffect(() => { storage.set('hermes-jot:list-collapsed:v1', listCollapsed ? '1' : null) }, [listCollapsed])
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set<string>())
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureText, setCaptureText] = useState('')
  const [captureSource, setCaptureSource] = useState('')
  const [captureError, setCaptureError] = useState('')
  const pendingCapture = useRef<{ key: string; noteId: string } | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveFolder, setMoveFolder] = useState('')
  const [purgeConfirm, setPurgeConfirm] = useState<'note' | 'trash' | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportError, setExportError] = useState('')
  const [revertConfirm, setRevertConfirm] = useState(false)
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentInfo | null>(null)
  const attachmentRequest = useRef<AbortController | null>(null)
  useEffect(() => () => { if (mode === 'compact') attachmentRequest.current?.abort() }, [mode])
  useEffect(() => {
    if (!attachmentDialogRequest) return
    let active = true
    const { attachmentId, revision } = attachmentDialogRequest
    void api.getAttachment(attachmentId).then(attachment => {
      if (active) { setAttachmentPreview(attachment); onAttachmentDialogHandled?.(revision) }
    }, cause => {
      if (active) { setError(describeError(cause, locale)); onAttachmentDialogHandled?.(revision) }
    })
    return () => { active = false }
  }, [attachmentDialogRequest, onAttachmentDialogHandled, api])
  const [uploadBusy, setUploadBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastSequence = useRef(0)
  const showToast = useCallback((text: string, action?: Toast['action']) => {
    setToast({ id: ++toastSequence.current, text, action })
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(current => current?.id === toast.id ? null : current), toast.action ? 6000 : 3500)
    return () => clearTimeout(timer)
  }, [toast])
  const fileInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const apiRef = useRef(api)
  apiRef.current = api

  const setStatus = useCallback((id: string, status: SaveStatus) => {
    const next = { ...statusesRef.current, [id]: status }
    statusesRef.current = next
    if (mounted.current) setStatuses(next)
  }, [])

  const installDraft = useCallback((next: NoteDraft) => {
    const stored = persistDraft(next)
    if (uploadTarget.current?.generation === selectionGeneration.current && uploadTarget.current.draft.noteId === stored.noteId) uploadTarget.current.draft = stored
    drafts.current.set(stored.noteId, stored)
    draftRef.current = stored
    if (mounted.current) setDraft(stored)
  }, [])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    const source = apiRef.current
    let next: JotState
    try { next = await source.getState() }
    catch (cause) {
      if (!mounted.current || source !== apiRef.current || sequence < acceptedRefresh.current) return
      throw cause
    }
    // An unchanged library returns the identical object; nothing to reconcile or render.
    if (!mounted.current || source !== apiRef.current || sequence < acceptedRefresh.current) return
    const current = draftRef.current
    const remote = current ? next.notes.find(note => note.id === current.noteId) : undefined
    // A delayed poll must never replace a just-saved document with an older
    // revision, including when an embedding supplies its own JotApi.
    if (current && remote && remote.revision < current.baseRevision) return
    acceptedRefresh.current = sequence
    if (next === snapshotRef.current) return
    snapshotRef.current = next
    setSnapshot(next)
    if (!current) return
    if (!remote) {
      if (current.dirty) setStatus(current.noteId, { phase: 'conflict' })
      return
    }
    const result = reconcileDraft(current, remote)
    if (result.remoteChanged && !inFlight.current.has(current.noteId)) setStatus(current.noteId, { phase: 'conflict' })
    if (result.draft !== current && !inFlight.current.has(current.noteId)) installDraft(result.draft)
  }, [installDraft, setStatus])

  const saveDraft = useCallback((id: string): Promise<boolean> => {
    const existing = inFlight.current.get(id)
    if (existing) return existing
    const submitted = drafts.current.get(id)
    if (!submitted?.dirty) return Promise.resolve(true)
    setStatus(id, { phase: 'saving' })
    const operation = (async () => {
      try {
        const saved = await saveHumanDraft(apiRef.current, submitted)
        const current = drafts.current.get(id) ?? submitted
        const next = savedDraft(current, submitted, saved)
        drafts.current.set(id, next)
        persistDraft(next)
        if (draftRef.current?.noteId === id) installDraft(next)
        setStatus(id, { phase: current.draftId !== submitted.draftId && next.dirty ? 'conflict' : next.dirty ? 'dirty' : 'saved' })
        // Keep a mutation response visible even if the following refresh fails.
        if (mounted.current) {
          setSnapshot(previous => {
            if (!previous) return previous
            const updated = { ...previous, notes: previous.notes.map(note => note.id === saved.id && note.revision <= saved.revision ? saved : note) }
            snapshotRef.current = updated
            return updated
          })
        }
        return true
      } catch (cause) {
        const conflict = cause instanceof JotApiError && cause.status === 409
          || typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 409
        setStatus(id, { phase: conflict ? 'conflict' : 'error', message: describeError(cause, locale) })
        return false
      } finally {
        inFlight.current.delete(id)
        if (mounted.current) void refresh().catch(() => {})
      }
    })()
    inFlight.current.set(id, operation)
    return operation
  }, [installDraft, refresh, setStatus, locale])

  useEffect(() => {
    mounted.current = true
    // A failed poll shows an error; the next successful poll clears only that error.
    const pollError = { current: '' }
    const poll = () => {
      return refresh().then(() => { if (mounted.current) setError(current => current && current === pollError.current ? '' : current) }, cause => {
        if (!mounted.current) return
        pollError.current = describeError(cause, locale)
        setError(pollError.current)
      })
    }
    // Hidden panels and background windows do not need a live library.
    const live = startLiveRefresh({ refresh: poll, signal: changeSignal, isVisible: () => document.visibilityState !== 'hidden' })
    const visible = () => { if (document.visibilityState === 'visible') live.wake() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', live.wake)
    return () => {
      mounted.current = false
      live.dispose()
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('focus', live.wake)
      for (const item of drafts.current.values()) persistDraft(item)
    }
  }, [refresh, api, changeSignal])

  useEffect(() => {
    if (!draft?.dirty || statuses[draft.noteId]?.phase === 'conflict' || statuses[draft.noteId]?.phase === 'error') return
    const timer = setTimeout(() => { void saveDraft(draft.noteId) }, 750)
    return () => clearTimeout(timer)
  }, [draft, saveDraft, statuses])

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen, compactEditor])

  useEffect(() => {
    if (snapshot && !folderFilter.startsWith('__') && !snapshot.folders.some(folder => folder.id === folderFilter)) {
      setFolderFilter('__all__')
    }
  }, [snapshot, folderFilter])

  // Focus the title of a note this panel just created, once its editor is on screen.
  useEffect(() => {
    if (!focusTitle.current || !draft) return
    focusTitle.current = false
    requestAnimationFrame(() => titleInput.current?.focus({ preventScroll: true }))
  }, [draft?.noteId, compactEditor])

  useEffect(() => { if (draft?.noteId) storage.set('hermes-jot:last-note:v1', draft.noteId) }, [draft?.noteId])

  const patchDraft = (patch: Partial<Pick<NoteDraft, 'title' | 'content' | 'folderId' | 'pinned'>>) => {
    const current = draftRef.current
    if (!current) return
    const next = editHumanDraft(current, patch, freshNotes.current)
    installDraft(next)
    if (statusesRef.current[current.noteId]?.phase !== 'conflict') setStatus(current.noteId, { phase: 'dirty' })
  }

  /** Leaving a note this panel created without writing anything removes it permanently. */
  const releaseFreshNote = useCallback((id: string) => {
    const note = snapshotRef.current?.notes.find(item => item.id === id)
    const local = drafts.current.get(id)
    if (!takeUntouchedFreshNote(id, freshNotes.current, {
      note, draft: local, saving: inFlight.current.has(id), keptDrafts: sharedDraftStorage.all(id).length > 0,
    }) || !note) return
    const purge = apiRef.current.purgeNote
    if (!purge) return
    void purge(id, note.revision).then(() => { drafts.current.delete(id); return refresh() }).catch(() => { /* an edited or moved note stays */ })
  }, [refresh])

  const selectNote = useCallback((note: Note, handoff?: NoteOpenRequest) => {
    selectionGeneration.current++
    const pending = currentOpenRequest.current
    if (!handoff && pending?.noteId) onNoteRequestHandled?.(pending.revision)
    const previous = draftRef.current
    if (previous?.dirty && previous.noteId !== note.id && statusesRef.current[previous.noteId]?.phase !== 'conflict') void saveDraft(previous.noteId)
    if (previous && previous.noteId !== note.id) releaseFreshNote(previous.noteId)
    const stored = handoff ? readHandoffDraft(note, handoff.draftId, sharedDraftStorage) : readDraft(note, drafts.current.get(note.id))
    const result = reconcileDraft(stored, note)
    installDraft(result.draft)
    setStatus(note.id, { phase: result.remoteChanged ? 'conflict' : result.draft.dirty ? 'dirty' : 'saved' })
    setCompactEditor(true)
    setSearchOpen(false)
    setError('')
  }, [installDraft, saveDraft, setStatus, onNoteRequestHandled, releaseFreshNote])

  useEffect(() => {
    const note = noteRequests.current.consume(openNoteRequest, snapshot?.notes ?? null,
      { fresh: freshRequest.current === openNoteRequest?.revision })
    if (note) {
      setView(note.deletedAt ? 'trash' : 'all')
      setFolderFilter('__all__')
      setQuery('')
      selectNote(note, openNoteRequest)
      if (openNoteRequest) onNoteRequestHandled?.(openNoteRequest.revision)
    } else if (snapshot && openNoteRequest?.noteId && noteRequests.current.isPending(openNoteRequest)
      && requestedRefresh.current !== openNoteRequest.revision) {
      const request = openNoteRequest
      requestedRefresh.current = request.revision
      void apiRef.current.getNote(request.noteId!).then(received => {
        if (!mounted.current || currentOpenRequest.current?.revision !== request.revision
          || currentOpenRequest.current.noteId !== request.noteId) return
        freshRequest.current = request.revision
        setSnapshot(previous => {
          if (!previous) return previous
          const known = previous.notes.find(item => item.id === received.id)
          const next = { ...previous, notes: known
            ? previous.notes.map(item => item.id === received.id && item.revision <= received.revision ? received : item)
            : [...previous.notes, received] }
          snapshotRef.current = next
          return next
        })
      }).catch(cause => {
        if (mounted.current && currentOpenRequest.current?.revision === request.revision) {
          requestedRefresh.current = 0
          setError(describeError(cause, locale))
        }
      })
    }
  }, [openNoteRequest, onNoteRequestHandled, snapshot, selectNote])

  // The full page reopens the note you were last reading, unless navigation asked for another.
  useEffect(() => {
    if (mode !== 'wide' || restoredLast.current || !snapshot) return
    restoredLast.current = true
    if (draftRef.current || openNoteRequest?.noteId) return
    const id = storage.get('hermes-jot:last-note:v1')
    const note = id ? snapshot.notes.find(item => item.id === id && item.deletedAt === null) : undefined
    if (note) selectNote(note)
  }, [mode, snapshot, openNoteRequest, selectNote])

  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(describeError(cause, locale)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const newNote = () => void perform(async () => {
    const current = draftRef.current
    if (current?.dirty && statusesRef.current[current.noteId]?.phase !== 'conflict') void saveDraft(current.noteId)
    const note = await api.createNote({ folderId: folderFilter.startsWith('__') ? null : folderFilter })
    await refresh()
    // A new note is the most recent one, so Recent and All both show it; only Trash cannot.
    if (view === 'trash') setView('recent')
    setQuery('')
    selectNote(note)
    freshNotes.current.add(note.id)
    focusTitle.current = true
  })

  const openSearch = () => {
    if (draftRef.current?.dirty && statusesRef.current[draftRef.current.noteId]?.phase !== 'conflict') void saveDraft(draftRef.current.noteId)
    setCompactEditor(false)
    setSearchOpen(true)
    searchInput.current?.focus()
  }

  const goToList = () => {
    if (draftRef.current?.dirty && statusesRef.current[draftRef.current.noteId]?.phase !== 'conflict') void saveDraft(draftRef.current.noteId)
    if (draftRef.current) releaseFreshNote(draftRef.current.noteId)
    setCompactEditor(false)
  }

  const loadLatest = () => void perform(async () => {
    const requested = draftRef.current
    if (!requested) return
    selectionGeneration.current++
    const received = await api.getNote(requested.noteId)
    const known = snapshotRef.current?.notes.find(item => item.id === requested.noteId)
    const note = known && known.revision > received.revision ? known : received
    const result = receiveLatestDraft(requested, draftRef.current, note, sharedDraftStorage)
    const cached = drafts.current.get(requested.noteId)
    if (sameDraftGeneration(cached, requested)) {
      drafts.current.set(requested.noteId, draftFromNote(note))
      setStatus(requested.noteId, { phase: 'saved' })
    }
    if (result.replaced && result.draft) installDraft(result.draft)
    else if (draftRef.current?.noteId === requested.noteId && draftRef.current.dirty) {
      setStatus(requested.noteId, { phase: draftRef.current.baseRevision === note.revision && !note.deletedAt ? 'dirty' : 'conflict' })
    }
    if (mounted.current) setSnapshot(previous => {
      if (!previous) return previous
      const updated = { ...previous, notes: previous.notes.map(existing => existing.id === note.id && existing.revision <= note.revision ? note : existing) }
      snapshotRef.current = updated
      return updated
    })
    await refresh()
  })

  const saveAsNew = () => void perform(async () => {
    const current = draftRef.current
    if (!current) return
    const note = await api.createNote({ title: current.title, content: current.content, folderId: current.folderId })
    // The original draft remains recoverable; copying is not permission to discard it.
    await refresh()
    setView('all')
    selectNote(note)
  })

  const restoreNote = (id: string, revision: number) => void perform(async () => {
    const restored = await api.restoreNote(id, revision)
    await refresh()
    if (draftRef.current?.noteId === restored.id || !draftRef.current) {
      setView(current => current === 'trash' ? 'recent' : current)
      selectNote(restored)
    }
    showToast(copy('已恢复笔记', 'Note restored'))
  })

  /** Trash is reversible, so deleting asks nothing and offers Undo instead. */
  const removeNote = () => void perform(async () => {
    const current = draftRef.current
    if (!current) return
    if (current.dirty && !await saveDraft(current.noteId)) return
    const latest = drafts.current.get(current.noteId) ?? current
    // Typing during the pending save belongs to the draft, not to this delete.
    if (latest.dirty) return
    if (sharedDraftStorage.all(current.noteId).length) throw new Error(copy('这条笔记还有保留的草稿，请先打开并处理。', 'Resolve this note’s kept drafts before deleting.'))
    freshNotes.current.delete(current.noteId)
    const deleted = await api.deleteNote(current.noteId, latest.baseRevision)
    if (sameDraftGeneration(draftRef.current, latest)) {
      setCompactEditor(false)
      draftRef.current = null
      setDraft(null)
    }
    await refresh()
    showToast(copy('已移到回收站', 'Moved to Trash'), {
      label: copy('撤销', 'Undo'), run: () => restoreNote(deleted.id, deleted.revision),
    })
  })

  const purgeSelected = () => void perform(async () => {
    const current = draftRef.current
    const note = current ? snapshotRef.current?.notes.find(item => item.id === current.noteId) : undefined
    if (!note?.deletedAt || !api.purgeNote) return
    if (sharedDraftStorage.all(note.id).length) throw new Error(copy('这条笔记还有保留的草稿，请先打开并处理。', 'Resolve this note’s kept drafts first.'))
    await api.purgeNote(note.id, note.revision)
    setPurgeConfirm(null)
    draftRef.current = null
    setDraft(null)
    setCompactEditor(false)
    await refresh()
    showToast(copy('已永久删除', 'Deleted permanently'))
  })

  const emptyTrash = () => void perform(async () => {
    if (!api.emptyTrash) return
    const kept = (snapshotRef.current?.notes ?? []).filter(note => note.deletedAt && sharedDraftStorage.all(note.id).length)
    if (kept.length) throw new Error(copy('回收站里有笔记还保留着草稿，请先打开并处理。', 'Some notes in Trash still have kept drafts; open and resolve them first.'))
    const result = await api.emptyTrash()
    setPurgeConfirm(null)
    if (draftRef.current && result.purged.includes(draftRef.current.noteId)) { draftRef.current = null; setDraft(null); setCompactEditor(false) }
    await refresh()
    showToast(copy(`已永久删除 ${result.purged.length} 条笔记`, `Deleted ${result.purged.length} notes permanently`))
  })

  const openCapture = (text = readSelectedText?.() ?? window.getSelection()?.toString() ?? '') => {
    pendingCapture.current = null
    setCaptureText(text)
    // Beside a conversation the page address identifies it; the full workbench's own address does not.
    setCaptureSource(mode === 'compact' && /^https?:/.test(location.protocol) ? location.href : '')
    setCaptureError('')
    setCaptureOpen(true)
  }

  const capture = async (submission: CaptureSubmission) => {
    if (busy) return
    setBusy(true); setCaptureError('')
    try {
      if (submission.targetNoteId === null) {
        const content = appendExcerpt(emptyDocument(), submission.text, submission.source)
        const note = await api.createNote({ title: submission.title ?? submission.text.trim().split('\n')[0].slice(0, 120), content })
        await refresh(); if (view === 'trash') setView('recent'); setQuery(''); selectNote(note)
      } else {
        const current = draftRef.current
        if (current?.noteId === submission.targetNoteId) {
          if (statusesRef.current[current.noteId]?.phase === 'conflict') throw new Error(copy('这篇笔记有版本冲突，请先处理保留的草稿。', 'Resolve the kept draft conflict before appending.'))
          const key = JSON.stringify(submission)
          if (pendingCapture.current && (pendingCapture.current.key !== key || pendingCapture.current.noteId !== current.noteId)) {
            throw new Error(copy('上一段摘录仍保留在草稿中，请先保存该草稿，再添加新的摘录。', 'Save the previously kept excerpt before adding another.'))
          }
          if (!pendingCapture.current) {
            patchDraft({ content: appendExcerpt(current.content, submission.text, submission.source) })
            pendingCapture.current = { key, noteId: current.noteId }
          }
          // An older autosave can still be in flight when the excerpt is added.
          // Its acknowledgement does not include this new content.
          let saved = await saveDraft(current.noteId)
          if (saved && drafts.current.get(current.noteId)?.dirty) saved = await saveDraft(current.noteId)
          if (!saved || drafts.current.get(current.noteId)?.dirty) throw new Error(copy('摘录已保留在笔记草稿中，尚未保存成功；重试不会重复追加。', 'The excerpt is kept in the note draft; retrying will not append it again.'))
        } else {
          const latest = await api.getNote(submission.targetNoteId)
          if (latest.deletedAt) throw new Error(copy('目标笔记已移到回收站。', 'The target note is in Trash.'))
          if (drafts.current.get(latest.id)?.dirty || sharedDraftStorage.all(latest.id).length) throw new Error(copy('目标笔记有未保存草稿，请先打开并处理，再追加摘录。', 'Open and resolve the target note draft before appending.'))
          await api.updateNote(latest.id, { revision: latest.revision, content: appendExcerpt(latest.content, submission.text, submission.source) })
          await refresh()
        }
        showToast(copy('已追加到笔记', 'Added to the note'))
      }
      pendingCapture.current = null
      setCaptureOpen(false)
    } catch (cause) { setCaptureError(describeError(cause, locale)) }
    finally { if (mounted.current) setBusy(false) }
  }

  /** A note picked in "/jot": it may be newer than this panel's last poll, or already in Trash. */
  const openNoteById = (id: string | undefined) => {
    if (!id) return
    const show = (note: Note) => {
      setView(note.deletedAt ? 'trash' : current => current === 'trash' ? 'recent' : current)
      setQuery('')
      selectNote(note)
    }
    const known = snapshotRef.current?.notes.find(note => note.id === id)
    if (known) show(known)
    else void perform(async () => { show(await api.getNote(id)) })
  }

  // Host commands are delivered once; the panel that receives them acknowledges.
  const handledCommand = useRef(0)
  useEffect(() => {
    handledCommand.current = consumeJotCommand(commandRequest, {
      ready: Boolean(snapshot), busy, lastHandled: handledCommand.current,
      blocked: captureOpen || moveOpen || helpOpen || exportOpen || revertConfirm || Boolean(purgeConfirm) || Boolean(attachmentPreview),
    }, {
      claim: onCommandClaim,
      acknowledge: onCommandHandled,
      run: request => {
        if (request.action === 'new') newNote()
        else if (request.action === 'open-note') openNoteById(request.noteId)
        else openCapture(request.text ?? '')
      },
    })
  }, [commandRequest, snapshot, busy, captureOpen, moveOpen, helpOpen, exportOpen, revertConfirm, purgeConfirm, attachmentPreview])

  const duplicateNote = () => void perform(async () => {
    const current = draftRef.current
    if (!current) return
    const note = await api.createNote(duplicateNoteInput(current, locale))
    await refresh(); if (view === 'trash') setView('recent'); setQuery(''); selectNote(note)
  })

  const exportCurrent = (format: ExportFormat) => void perform(async () => {
    const current = draftRef.current
    if (!current) return
    const result = await api.exportNote({ title: current.title, content: current.content }, format)
    await downloadNote(result)
    if (!result.save) showToast(copy(`已导出 ${result.filename}`, `Exported ${result.filename}`))
  })

  const toggleSelection = (note: Note) => setSelectedIds(previous => {
    const next = new Set(previous)
    if (next.has(note.id)) next.delete(note.id); else next.add(note.id)
    return next
  })

  const moveSelected = () => void perform(async () => {
    const ids = selectMode ? [...selectedIds] : draftRef.current ? [draftRef.current.noteId] : []
    let completed = 0
    try {
      for (const id of ids) {
        const current = draftRef.current
        if (current?.noteId !== id && (drafts.current.get(id)?.dirty || sharedDraftStorage.all(id).length)) throw new Error(copy('目标笔记有未保存草稿，请先打开并处理。', 'Resolve the target note draft before moving.'))
        if (current?.noteId === id && current.dirty) {
          if (statusesRef.current[id]?.phase === 'conflict' || !await saveDraft(id)) throw new Error(copy('草稿已保留，请先处理版本冲突。', 'Resolve the kept draft first.'))
          if (draftRef.current?.dirty) throw new Error(copy('笔记仍在编辑，请保存后再移动。', 'Finish editing before moving.'))
        }
        if (sharedDraftStorage.all(id).length) throw new Error(copy('这条笔记还有保留的草稿，请先打开并处理。', 'Resolve this note’s kept drafts before moving.'))
        const before = await api.getNote(id)
        if (before.deletedAt) continue
        if (before.folderId === (moveFolder || null)) { completed++; continue }
        const saved = await api.updateNote(id, { revision: before.revision, folderId: moveFolder || null })
        const active = draftRef.current
        if (active?.noteId === id && active.baseRevision === before.revision) {
          installDraft({ ...active, baseRevision: saved.revision,
            folderId: active.folderId === before.folderId ? saved.folderId : active.folderId })
        }
        completed++
      }
      setMoveOpen(false); setSelectedIds(new Set()); await refresh()
      showToast(copy(`已移动 ${completed} 条笔记`, `Moved ${completed} notes`))
    } catch (cause) {
      await refresh()
      throw new Error(`${copy(`已移动 ${completed} 条。`, `Moved ${completed}.`)} ${describeError(cause, locale)}`)
    }
  })

  /** Several notes come back from Trash at once; each keeps the revision its own deletion produced. */
  const restoreMany = (targets: readonly { id: string; revision: number }[]) => void perform(async () => {
    let restored = 0
    try {
      for (const target of targets) { await api.restoreNote(target.id, target.revision); restored++ }
      await refresh()
      showToast(copy(`已恢复 ${restored} 条笔记`, `Restored ${restored} notes`))
    } catch (cause) {
      await refresh()
      throw new Error(`${copy(`已恢复 ${restored} 条。`, `Restored ${restored}.`)} ${describeError(cause, locale)}`)
    }
  })

  /** Like a single note, a batch moves to Trash without a question and offers Undo. */
  const deleteSelected = () => void perform(async () => {
    const deleted: { id: string; revision: number }[] = []
    const undo = () => ({ label: copy('撤销', 'Undo'), run: () => restoreMany(deleted) })
    try {
      for (const id of [...selectedIds]) {
        const current = draftRef.current
        if (current?.noteId !== id && (drafts.current.get(id)?.dirty || sharedDraftStorage.all(id).length)) throw new Error(copy('目标笔记有未保存草稿，请先打开并处理。', 'Resolve the target note draft before deleting.'))
        if (current?.noteId === id && current.dirty) {
          if (statusesRef.current[id]?.phase === 'conflict' || !await saveDraft(id) || draftRef.current?.dirty) {
            throw new Error(copy('请先处理正在编辑的草稿。', 'Resolve the active draft before deleting.'))
          }
        }
        if (sharedDraftStorage.all(id).length) throw new Error(copy('这条笔记还有保留的草稿，请先打开并处理。', 'Resolve this note’s kept drafts before deleting.'))
        const before = await api.getNote(id)
        if (before.deletedAt) continue
        const removed = await api.deleteNote(id, before.revision)
        deleted.push({ id: removed.id, revision: removed.revision })
      }
      setSelectedIds(new Set()); setSelectMode(false)
      await refresh()
      showToast(copy(`已将 ${deleted.length} 条笔记移到回收站`, `Moved ${deleted.length} notes to Trash`), deleted.length ? undo() : undefined)
    } catch (cause) {
      await refresh()
      // Notes already moved stay recoverable from the same toast.
      if (deleted.length) showToast(copy(`已将 ${deleted.length} 条笔记移到回收站`, `Moved ${deleted.length} notes to Trash`), undo())
      throw new Error(`${copy(`已处理 ${deleted.length} 条。`, `Processed ${deleted.length}.`)} ${describeError(cause, locale)}`)
    }
  })

  const uploadFiles = async (files: File[]) => {
    if (uploadBusy || files.length === 0) return
    if (files.length > 20) { setError(copy('一次最多添加 20 个文件。', 'Add at most 20 files at once.')); return }
    setUploadBusy(true); setError('')
    try {
      let target = draftRef.current
      if (!target) {
        const note = await api.createNote({ title: '' })
        await refresh(); selectNote(note); target = drafts.current.get(note.id) ?? draftFromNote(note)
      }
      if (snapshotRef.current?.notes.find(note => note.id === target!.noteId)?.deletedAt) throw new Error(copy('恢复笔记后才能添加附件。', 'Restore the note before adding files.'))
      const targetId = target.noteId
      freshNotes.current.delete(targetId)
      const intended = { draft: target, generation: selectionGeneration.current }
      uploadTarget.current = intended
      for (const file of files) {
        const attachment = await api.uploadAttachment(file)
        const active = draftRef.current
        if (active?.noteId === targetId && selectionGeneration.current === intended.generation && editorActions.current) {
          const inserted = await (attachment.kind === 'image' ? editorActions.current.insertImage(attachment.id, attachment.name)
            : editorActions.current.insertAttachment(attachment.id, attachment.name))
          if (inserted) continue
        }
        let original = intended.draft.draftId ? sharedDraftStorage.all(targetId).find(item => item.draftId === intended.draft.draftId) ?? intended.draft : intended.draft
        const hasUploadedFile = (node: RichNode): boolean => node.attrs?.attachmentId === attachment.id || (node.content ?? []).some(hasUploadedFile)
        if (hasUploadedFile(original.content)) continue
        let latest: Note
        try { latest = await api.getNote(targetId) }
        catch (cause) {
          // Uploads may finish after the host switches profiles. Preserve the file reference
          // in the originating profile's draft; never send a follow-up to the new profile.
          const node: RichNode = attachment.kind === 'image' ? { type: 'image', attrs: { attachmentId: attachment.id, alt: attachment.name } }
            : { type: 'attachment', attrs: { attachmentId: attachment.id, caption: attachment.name } }
          const saved = persistDraft(editDraft(original, { content: { ...original.content, content: [...(original.content.content ?? []), node] } }))
          drafts.current.set(targetId, saved)
          throw cause
        }
        if (!original.dirty) original = draftFromNote(latest)
        else if (draftFingerprint(original) === draftFingerprint(draftFromNote(latest))) original = { ...original, baseRevision: latest.revision }
        if (hasUploadedFile(original.content)) continue
        const node: RichNode = attachment.kind === 'image' ? { type: 'image', attrs: { attachmentId: attachment.id, alt: attachment.name } }
          : { type: 'attachment', attrs: { attachmentId: attachment.id, caption: attachment.name } }
        const next = editDraft(original, { content: { ...original.content, content: [...(original.content.content ?? []), node] } })
        const stored = persistDraft(next)
        intended.draft = stored
        if (draftRef.current?.noteId === targetId && selectionGeneration.current === intended.generation) installDraft(stored)
        else {
          if (draftRef.current?.noteId !== targetId) drafts.current.set(targetId, stored)
          showToast(copy('附件已保留在原笔记的恢复草稿中。', 'Files were kept in a recovery draft of the original note.'))
        }
        setStatus(targetId, { phase: 'dirty' })
      }
    } catch (cause) { setError(describeError(cause, locale)) }
    finally { uploadTarget.current = null; if (mounted.current) setUploadBusy(false) }
  }

  const previewAttachment = (id: string) => void perform(async () => {
    attachmentRequest.current?.abort()
    const controller = new AbortController()
    attachmentRequest.current = controller
    // The Host owns navigation after this handoff, including a wide panel's
    // intentional unmount when returning to the Conversation.
    const opened = onAttachmentPreview ? await onAttachmentPreview(id, { signal: controller.signal }) : false
    if (opened !== false || !mounted.current || controller.signal.aborted) return
    const attachment = await api.getAttachment(id)
    if (mounted.current && !controller.signal.aborted) setAttachmentPreview(attachment)
  })

  /** Restore the version from before the latest run of AI edits; the note must be showing that AI version. */
  const revertAgent = () => void perform(async () => {
    const current = draftRef.current
    if (!current || current.dirty || uploadBusy || !api.revertAgentEdit) return
    const saved = await api.revertAgentEdit(current.noteId, current.baseRevision)
    selectionGeneration.current++
    // A pending upload or another asynchronous editor operation may have
    // created a draft while the revert was running. Keep that writing just as
    // a normal remote refresh does, and surface the new revision as a conflict.
    const cached = drafts.current.get(saved.id)
    const result = cached ? reconcileDraft(cached, saved) : { draft: draftFromNote(saved), remoteChanged: false }
    const next = result.draft
    drafts.current.set(saved.id, next)
    if (draftRef.current?.noteId === saved.id) installDraft(next)
    setStatus(saved.id, { phase: result.remoteChanged ? 'conflict' : next.dirty ? 'dirty' : 'saved' })
    setRevertConfirm(false)
    await refresh()
    showToast(copy('已撤销 AI 的修改', 'AI edits undone'))
  })

  /** Unsaved writing is saved first so the archive matches what is on screen. */
  const exportLibrary = async (format: LibraryExportFormat) => {
    if (busy || !api.exportLibrary) return
    setBusy(true); setExportError('')
    storage.set('hermes-jot:export-format:v1', format)
    try {
      const folderId = folderFilter === '__all__' ? undefined : folderFilter === '__unfiled__' ? null : folderFilter
      const result = await exportSavedLibrary({
        draft: draftRef.current,
        readDraft: id => drafts.current.get(id),
        conflicted: id => statusesRef.current[id]?.phase === 'conflict',
        save: saveDraft,
        export: () => api.exportLibrary!({ format, locale, ...folderId === undefined ? {} : { folderId } }),
        unsavedMessage: copy('草稿尚未保存，请先处理保留的草稿，再导出笔记。', 'The draft is not saved. Resolve the kept draft before exporting notes.'),
      })
      await downloadNote(result)
      setExportOpen(false)
      if (!result.save) showToast(result.attachments
        ? copy(`已导出 ${result.notes} 篇笔记和 ${result.attachments} 个附件`, `Exported ${result.notes} notes and ${result.attachments} files`)
        : copy(`已导出 ${result.notes} 篇笔记`, `Exported ${result.notes} notes`))
    } catch (cause) { setExportError(describeError(cause, locale)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const toggleAgent = () => void perform(async () => {
    const enabled = !snapshot?.agentEnabled
    await api.setAgentEnabled(enabled); await refresh()
    showToast(enabled ? copy('已允许 AI 读取和修改笔记，可随时关闭。', 'AI can now read and edit notes. Turn it off at any time.')
      : copy('已关闭 AI 协作。', 'AI collaboration is off.'))
  })

  /** The agent cannot see which note is open beside the conversation; this hands it a reference. */
  const askAgent = () => void perform(async () => {
    const current = draftRef.current
    if (!current || !onAskAgent) return
    if (!snapshotRef.current?.agentEnabled) {
      showToast(copy('开启 AI 协作后，Hermes 才能读取笔记。', 'Hermes can’t read notes until AI collaboration is on.'),
        { label: copy('开启', 'Turn on'), run: () => { if (!snapshotRef.current?.agentEnabled) toggleAgent() } })
      return
    }
    // The agent reads the saved note, so what it sees must match the screen.
    if (current.dirty && !await saveDraft(current.noteId)) return
    const latest = drafts.current.get(current.noteId) ?? current
    const outcome = await onAskAgent({ id: latest.noteId, title: latest.title })
    if (outcome === 'failed') throw new Error(askAgentMessage(outcome, locale))
    if (mounted.current) showToast(askAgentMessage(outcome, locale))
  })

  const [importBusy, setImportBusy] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  /** Files upload one at a time; notes already imported stay even if a later file fails. */
  const importFiles = async (files: File[]) => {
    if (importBusy || !files.length || !api.importNotes) return
    const problem = files.map(file => importFileProblem(file, locale)).find(Boolean)
    if (problem) { setError(problem); return }
    const folderId = folderFilter.startsWith('__') ? null : folderFilter
    const results: ImportResult[] = []
    setImportBusy(true); setError('')
    let failure = ''
    try {
      for (const file of files) results.push(await api.importNotes(file, { folderId }))
    } catch (cause) { failure = describeError(cause, locale) }
    await refresh().catch(() => {})
    if (!mounted.current) return
    setImportBusy(false)
    const summary = summarizeImport(mergeImportResults(results), locale)
    if (failure) setError(results.length ? `${summary.toast}${copy('。', '. ')}${failure}${summary.details ? `\n${summary.details}` : ''}` : failure)
    else {
      if (summary.details) setError(summary.details)
      showToast(summary.toast)
    }
  }

  const selectedNote = snapshot?.notes.find(note => note.id === draft?.noteId)
  const recoveries = draft ? recoveryDrafts(draft.noteId) : []
  const selectedStatus = draft ? statuses[draft.noteId] : undefined
  const selectedDeleted = selectedNote?.deletedAt !== null && selectedNote?.deletedAt !== undefined
  useEffect(() => { if (selectedDeleted) releaseEditorFocus() }, [selectedDeleted, releaseEditorFocus])
  const actualFolder = snapshot?.folders.find(folder => folder.id === folderFilter)
  const hasFolders = Boolean(snapshot?.folders.length)
  const effectiveSort: NoteSortMode = view === 'recent' && !query.trim() ? 'modified' : sortMode
  const visibleNotes = useMemo(() => {
    const notes = (snapshot?.notes ?? []).filter(note => {
      if ((note.deletedAt !== null) !== (view === 'trash')) return false
      if (folderFilter === '__unfiled__' && note.folderId !== null) return false
      if (!folderFilter.startsWith('__') && note.folderId !== folderFilter) return false
      return noteMatchesQuery(note, query)
    })
    const sorted = sortNotes(notes, effectiveSort, query)
    if (view !== 'recent' || query.trim()) return sorted
    return [...sorted.filter(note => note.pinned), ...sorted.filter(note => !note.pinned).slice(0, 5)]
  }, [snapshot, view, folderFilter, query, effectiveSort])
  // Recent already searches every note, so an empty search names the scopes that do hide matches.
  const elsewhere = useMemo(() => visibleNotes.length || !query.trim() ? null
    : searchElsewhere(snapshot?.notes ?? [], query, { trash: view === 'trash', folderFiltered: folderFilter !== '__all__' }),
  [visibleNotes, snapshot, query, view, folderFilter])
  const trashCount = useMemo(() => (snapshot?.notes ?? []).filter(note => note.deletedAt !== null).length, [snapshot])
  const agentEditedIds = useMemo(() => new Set((snapshot?.notes ?? [])
    .filter(note => snapshot?.agentEdits?.[note.id]?.revision === note.revision).map(note => note.id)), [snapshot])
  const agentEdited = Boolean(draft && !draft.dirty && agentEditedIds.has(draft.noteId))
  const agentUndoable = agentEdited && !selectedDeleted && !uploadBusy && Boolean(api.revertAgentEdit) && snapshot?.agentEdits?.[draft!.noteId]?.undo === true
  const exportable = (snapshot?.notes ?? []).filter(note => note.deletedAt === null && (folderFilter === '__all__'
    || (folderFilter === '__unfiled__' ? note.folderId === null : note.folderId === folderFilter))).length
  const exportScope = folderFilter === '__all__' ? copy(`全部 ${exportable} 篇笔记`, `all ${exportable} notes`)
    : folderFilter === '__unfiled__' ? copy(`未分类的 ${exportable} 篇笔记`, `${exportable} unfiled notes`)
      : copy(`「${actualFolder?.name ?? ''}」里的 ${exportable} 篇笔记`, `${exportable} notes in “${actualFolder?.name ?? ''}”`)

  useEffect(() => { setSelectedIds(new Set()); setSelectMode(false); setContextPosition(null) }, [view, folderFilter, query])

  const folderMenuItems: ActionMenuEntry[] = [
    { label: copy('新建文件夹…', 'New folder…'), icon: 'new-folder', disabled: busy,
      onSelect: () => { setFolderForm('create'); setFolderName(''); setFolderDeleteConfirm(false) } },
    ...(actualFolder ? [
      { label: copy('重命名文件夹…', 'Rename folder…'), icon: 'rename' as const, disabled: busy,
        onSelect: () => { setFolderForm('rename'); setFolderName(actualFolder.name); setFolderDeleteConfirm(false) } },
      { separator: true } as const,
      { label: copy('删除文件夹…', 'Delete folder…'), icon: 'trash' as const, danger: true, disabled: busy,
        onSelect: () => { setFolderForm(null); setFolderDeleteConfirm(true) } },
    ] : []),
  ]
  const sortable = !(view === 'recent' && !query.trim())
  const listMenuItems: ActionMenuEntry[] = [
    ...(sortable ? [
      { heading: copy('排序', 'Sort by') },
      ...(['modified', 'created', 'title'] as NoteSortMode[]).map(item => ({
        label: item === 'modified' ? copy('修改时间', 'Last modified') : item === 'created' ? copy('创建时间', 'Date created') : copy('标题', 'Title'),
        checked: effectiveSort === item, onSelect: () => setSortMode(item),
      })),
      { separator: true } as const,
    ] : []),
    ...(view !== 'trash' ? [{ label: selectMode ? copy('结束多选', 'Finish selection') : copy('选择笔记', 'Select notes'), icon: 'checklist' as const,
      onSelect: () => { setSelectMode(value => !value); setSelectedIds(new Set()) } }] : []),
    ...(!hasFolders ? [{ label: copy('新建文件夹…', 'New folder…'), icon: 'new-folder' as const, disabled: busy,
      onSelect: () => { setFolderForm('create'); setFolderName(''); setFolderDeleteConfirm(false) } }] : []),
    ...(view !== 'trash' && api.exportLibrary ? [{ label: folderFilter === '__all__' ? copy('导出全部笔记…', 'Export all notes…') : copy('导出这些笔记…', 'Export these notes…'),
      icon: 'export' as const, disabled: busy || exportable === 0, onSelect: () => { setExportError(''); setExportOpen(true) } }] : []),
    ...(view !== 'trash' && api.importNotes ? [{ label: copy('导入笔记…', 'Import notes…'), icon: 'import' as const,
      disabled: importBusy, onSelect: () => importInput.current?.click() }] : []),
    { separator: true } as const,
    { label: copy('键盘快捷键', 'Keyboard shortcuts'), onSelect: () => setHelpOpen(true) },
    ...(onLocaleChange ? [
      { separator: true } as const,
      { heading: copy('界面语言', 'Interface language') },
      { label: 'English', checked: en, onSelect: () => onLocaleChange('en') },
      { label: '简体中文', checked: !en, onSelect: () => onLocaleChange('zh') },
    ] : []),
    ...(view === 'trash' && api.emptyTrash ? [{ label: copy('清空回收站…', 'Empty Trash…'), icon: 'trash' as const, danger: true,
      disabled: busy || trashCount === 0, onSelect: () => setPurgeConfirm('trash') }] : []),
  ]

  const exportItems: ActionMenuEntry[] = [
    { heading: copy('导出为', 'Export as') },
    ...(['md', 'docx', 'pdf', 'txt'] as ExportFormat[]).map(format => ({
      label: format === 'docx' ? 'Word（DOCX）' : format === 'md' ? 'Markdown' : format === 'pdf' ? 'PDF' : copy('纯文本（TXT）', 'Plain text (TXT)'),
      icon: 'export' as const, onSelect: () => exportCurrent(format), disabled: busy || uploadBusy,
    })),
  ]
  const menuItems: ActionMenuEntry[] = !draft ? [] : selectedDeleted ? [
    { label: copy('恢复笔记', 'Restore note'), icon: 'restore', disabled: busy || !selectedNote,
      onSelect: () => { if (selectedNote) restoreNote(selectedNote.id, selectedNote.revision) } },
    { label: copy('复制为新笔记', 'Duplicate as new note'), icon: 'duplicate', onSelect: duplicateNote, disabled: busy },
    { separator: true },
    ...exportItems,
    ...(api.purgeNote ? [{ separator: true } as const,
      { label: copy('永久删除…', 'Delete permanently…'), icon: 'trash' as const, danger: true, disabled: busy, onSelect: () => setPurgeConfirm('note') }] : []),
  ] : [
    ...(agentUndoable ? [{ label: copy('撤销 AI 的修改…', 'Undo AI edits…'), icon: 'restore' as const, disabled: busy, onSelect: () => setRevertConfirm(true) },
      { separator: true } as const] : []),
    ...(onAskAgent ? [{ label: copy('让 Hermes 看这条笔记', 'Ask Hermes about this note'), icon: 'ask' as const, disabled: busy, onSelect: askAgent },
      { separator: true } as const] : []),
    { label: draft.pinned ? copy('取消置顶', 'Unpin') : copy('置顶', 'Pin'), icon: 'pin', onSelect: () => patchDraft({ pinned: !draftRef.current?.pinned }), disabled: busy },
    ...(hasFolders ? [{ label: copy('移动到文件夹…', 'Move to folder…'), icon: 'folder' as const, onSelect: () => { setMoveFolder(draftRef.current?.folderId ?? ''); setMoveOpen(true) }, disabled: busy }] : []),
    { label: copy('复制笔记', 'Duplicate note'), icon: 'duplicate', onSelect: duplicateNote, disabled: busy },
    { separator: true },
    ...exportItems,
    { separator: true },
    { label: copy('移到回收站', 'Move to Trash'), icon: 'trash', onSelect: removeNote, disabled: busy, danger: true },
  ]

  const savePhase: SavePhase = selectedStatus?.phase ?? (draft?.dirty ? 'dirty' : 'saved')
  const saveLabel = savePhase === 'saving' ? copy('保存中…', 'Saving…')
    : savePhase === 'error' ? copy('保存失败 · 重试', 'Save failed · Retry')
      : savePhase === 'conflict' ? copy('草稿已保留', 'Draft kept')
        : draft?.dirty ? copy('未保存', 'Unsaved') : copy('已保存', 'Saved')
  const saveActionable = Boolean(draft && !selectedDeleted && draft.dirty && (savePhase === 'dirty' || savePhase === 'error'))
  const listLabel = (count: number) => en ? `${count} ${count === 1 ? 'note' : 'notes'}` : `${count} 条`

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const start = event.clientX
    const initial = listWidth
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    let latest = initial
    const move = (moved: PointerEvent) => {
      latest = Math.round(Math.max(LIST_WIDTH.min, Math.min(LIST_WIDTH.max, initial + moved.clientX - start)))
      setListWidth(latest)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      storage.set('hermes-jot:list-width:v1', String(latest))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const nudgeWidth = (delta: number) => setListWidth(current => {
    const next = Math.max(LIST_WIDTH.min, Math.min(LIST_WIDTH.max, current + delta))
    storage.set('hermes-jot:list-width:v1', String(next))
    return next
  })

  const listPanel = (
    <aside className="jot-list-panel" aria-label={copy('笔记列表', 'Notes')} style={mode === 'wide' ? { width: listWidth } : undefined}>
      <div className="jot-list-controls">
        {(mode === 'wide' || searchOpen) && (
          <div className="jot-search">
            <Icon name="search" />
            <input ref={searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }}
              placeholder={copy('搜索笔记', 'Search notes')} aria-label={copy('搜索笔记', 'Search notes')}
              title={copy('搜索笔记（/）', 'Search notes (/)')} />
            {query && <button type="button" className="jot-search-clear" aria-label={copy('清除搜索', 'Clear search')} title={copy('清除搜索', 'Clear search')}
              onClick={() => { setQuery(''); searchInput.current?.focus() }}><JotActionIcon name="close" size={14} /></button>}
          </div>
        )}
        {hasFolders && <div className="jot-folder-line">
          <select className="jot-select" aria-label={copy('筛选文件夹', 'Filter folders')} value={folderFilter}
            onChange={event => { setFolderFilter(event.target.value); setFolderForm(null); setFolderDeleteConfirm(false) }}>
            <option value="__all__">{copy('全部文件夹', 'All folders')}</option>
            <option value="__unfiled__">{copy('未分类', 'Unfiled')}</option>
            {snapshot?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
          <ActionMenu triggerLabel={copy('文件夹操作', 'Folder actions')} triggerIcon="folder" items={folderMenuItems} />
        </div>}
        {folderForm && <form className="jot-folder-form" onSubmit={event => {
          event.preventDefault()
          if (!folderName.trim()) return
          void perform(async () => {
            if (folderForm === 'rename' && actualFolder) await api.updateFolder(actualFolder.id, folderName.trim())
            else {
              const created = await api.createFolder(folderName.trim())
              await refresh()
              setFolderFilter(created.id)
            }
            if (folderForm === 'rename' && actualFolder) await refresh()
            setFolderForm(null)
          })
        }}>
          <input autoFocus value={folderName} onChange={event => setFolderName(event.target.value)} maxLength={80}
            placeholder={folderForm === 'rename' ? copy('新的文件夹名称', 'New folder name') : copy('文件夹名称', 'Folder name')} aria-label={copy('文件夹名称', 'Folder name')}
            onKeyDown={event => { if (event.key === 'Escape') setFolderForm(null) }} />
          <button className="jot-btn jot-primary" type="submit" disabled={busy || !folderName.trim()}>{folderForm === 'rename' ? copy('保存', 'Save') : copy('创建', 'Create')}</button>
          <button className="jot-text-btn" type="button" onClick={() => setFolderForm(null)}>{copy('取消', 'Cancel')}</button>
        </form>}
        {folderDeleteConfirm && actualFolder && <div className="jot-inline-confirm" role="group" aria-label={copy('删除文件夹', 'Delete folder')}>
          <p>{copy(`删除「${actualFolder.name}」？里面的笔记会保留在「未分类」。`, `Delete “${actualFolder.name}”? Its notes stay, as Unfiled.`)}</p>
          <div className="jot-notice-actions">
            <button className="jot-text-btn" type="button" onClick={() => setFolderDeleteConfirm(false)}>{copy('取消', 'Cancel')}</button>
            <button className="jot-btn jot-danger-fill" type="button" disabled={busy} onClick={() => void perform(async () => {
              await api.deleteFolder(actualFolder.id); setFolderFilter('__all__'); setFolderDeleteConfirm(false); await refresh()
            })}>{copy('删除文件夹', 'Delete folder')}</button>
          </div>
        </div>}
        <div className="jot-browse-line">
          <div className="jot-view-line">
            {(['recent', 'all', 'trash'] as const).map(item => <button type="button" key={item} aria-pressed={view === item}
              onClick={() => { setView(item); setQuery('') }}>
              {item === 'recent' ? copy('最近', 'Recent') : item === 'all' ? copy('全部', 'All') : copy('回收站', 'Trash')}
            </button>)}
          </div>
          {snapshot && <span className="jot-list-total" title={query.trim() ? copy(`${visibleNotes.length} 条搜索结果`, `${visibleNotes.length} results`) : listLabel(visibleNotes.length)}>{listLabel(visibleNotes.length)}</span>}
          <ActionMenu triggerLabel={copy('排序与选项', 'Sort and options')} triggerIcon="sort" items={listMenuItems} />
        </div>
      </div>
      {selectMode && <div className="jot-selection-bar">
        <span>{copy(`已选择 ${selectedIds.size} 条`, `${selectedIds.size} selected`)}</span>
        <button className="jot-text-btn" type="button" onClick={() => setSelectedIds(new Set(visibleNotes.map(note => note.id)))}>{copy('全选', 'Select all')}</button>
        {hasFolders && <button className="jot-text-btn" type="button" disabled={busy || !selectedIds.size} onClick={() => { setMoveFolder(''); setMoveOpen(true) }}>{copy('移动', 'Move')}</button>}
        <button className="jot-text-btn jot-danger" type="button" disabled={busy || !selectedIds.size} onClick={deleteSelected}>{copy('移到回收站', 'Trash')}</button>
        <button className="jot-text-btn" type="button" onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }}>{copy('完成', 'Done')}</button>
      </div>}
      {query.trim() && visibleNotes.length > 0 && <div className="jot-list-label jot-search-label">{copy('搜索结果 · 标题命中优先', 'Results · title matches first')}</div>}
      {visibleNotes.length > 0 ? <NoteList key={`${folderFilter}:${effectiveSort}`} notes={visibleNotes} selectedId={draft?.noteId} onSelect={selectNote}
        selectMode={selectMode} selectedNoteIds={selectedIds} onToggleSelection={toggleSelection}
        hideFolderName={folderFilter !== '__all__'} agentEditedIds={agentEditedIds}
        onContextMenu={(note, event) => { event.preventDefault(); if (!selectMode) { selectNote(note); setContextPosition({ x: event.clientX, y: event.clientY }) } }}
        dateBasis={effectiveSort === 'title' ? 'none' : effectiveSort} query={query} folders={snapshot?.folders} locale={locale} view={view} /> : <div className="jot-note-list">
        {snapshot && <div className="jot-empty">
          <div className="jot-empty-title">{query.trim() ? copy('没有找到笔记', 'No notes found') : view === 'trash' ? copy('回收站是空的', 'Trash is empty') : copy('留一点想法在这里', 'Leave a thought here')}</div>
          {elsewhere ? elsewhere.otherFolders > 0 ? <>
            <p>{copy(`当前文件夹里没有，其他文件夹有 ${elsewhere.otherFolders} 条。`, `Nothing in this folder; ${elsewhere.otherFolders} in other folders.`)}</p>
            <button className="jot-btn" type="button" onClick={() => setFolderFilter('__all__')}>{copy('在全部文件夹中搜索', 'Search all folders')}</button>
          </> : elsewhere.otherView > 0 ? <>
            <p>{view === 'trash' ? copy(`笔记里有 ${elsewhere.otherView} 条匹配。`, `${elsewhere.otherView} matching notes outside Trash.`)
              : copy(`回收站里有 ${elsewhere.otherView} 条匹配。`, `${elsewhere.otherView} matching notes in Trash.`)}</p>
            <button className="jot-btn" type="button" onClick={() => { setFolderFilter('__all__'); setView(view === 'trash' ? 'all' : 'trash') }}>
              {view === 'trash' ? copy('在笔记中查看', 'Show in notes') : copy('在回收站中查看', 'Show in Trash')}</button>
          </> : <p>{copy('换个关键词试试。', 'Try another word.')}</p>
            : <p>{view === 'trash' ? copy('移到回收站的笔记会留在这里，可以恢复。', 'Notes you move to Trash wait here and can be restored.') : copy('一句提醒，一张清单，或者还没想完的事。', 'A reminder, a list, or something still taking shape.')}</p>}
          {!query.trim() && view !== 'trash' && <button className="jot-btn jot-primary" type="button" onClick={newNote} disabled={busy}>{copy('新建笔记', 'New note')}</button>}
        </div>}
      </div>}
      <div className="jot-agent-line">
        <span className="jot-agent-label" title={copy('开启后，AI 可以通过随记工具搜索、读取和修改笔记；不会自动读取。', 'When on, AI can search, read and edit notes through Jot tools when asked; nothing is read automatically.')}>
          <JotActionIcon name="sparkle" size={14} />{copy('允许 AI 协作', 'Allow AI collaboration')}</span>
        <button type="button" className="jot-switch" role="switch" aria-checked={snapshot?.agentEnabled ?? false} disabled={busy || !snapshot}
          aria-label={copy('允许 AI 协作', 'Allow AI collaboration')} onClick={toggleAgent} />
      </div>
    </aside>
  )

  const editorPanel = (
    <section className="jot-editor-panel" aria-label={copy('笔记', 'Note')}>
      {draft ? <>
        <div className="jot-editor-toolbar jot-context-toolbar">
          {hasFolders && <select className="jot-select" value={draft.folderId ?? ''} disabled={selectedDeleted} aria-label={copy('笔记文件夹', 'Note folder')}
            onChange={event => patchDraft({ folderId: event.target.value || null })}>
            <option value="">{copy('未分类', 'Unfiled')}</option>
            {snapshot?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>}
          {agentEdited && (agentUndoable
            ? <button type="button" className="jot-agent-chip" onClick={() => setRevertConfirm(true)} disabled={busy}
              title={copy('这一版由 AI 通过随记工具保存。点按可以撤销 AI 的修改；你编辑后标记会消失。', 'This version was saved by AI through Jot tools. Select to undo the AI edits; the mark clears when you edit.')}>
              <JotActionIcon name="sparkle" size={12} />{copy('AI 修改', 'AI edited')}</button>
            : <span className="jot-agent-chip" title={copy('这一版由 AI 通过随记工具保存；你编辑后标记会消失。', 'This version was saved by AI through Jot tools; it clears when you edit.')}>
              <JotActionIcon name="sparkle" size={12} />{copy('AI 修改', 'AI edited')}</span>)}
          {!agentEdited && !selectedDeleted && snapshot?.agentEnabled && <span className="jot-agent-indicator" role="img"
            aria-label={copy('AI 协作已开启', 'AI collaboration is on')}
            title={copy('AI 协作已开启：你提出要求时，AI 可以读取和修改笔记。可在列表底部关闭。', 'AI collaboration is on: when you ask, AI can read and edit notes. Turn it off below the note list.')}>
            <JotActionIcon name="sparkle" size={14} /></span>}
          <span className="jot-save-slot" role="status" aria-live="polite">
            {saveActionable
              ? <button type="button" className={`jot-save-label is-action${savePhase === 'error' ? ' is-error' : ''}`} title={copy('立即保存（⌘/Ctrl+S）', 'Save now (⌘/Ctrl+S)')}
                onClick={() => void saveDraft(draft.noteId)}>{saveLabel}</button>
              : <span className={`jot-save-label${savePhase === 'error' ? ' is-error' : ''}`} title={saveLabel}>{saveLabel}</span>}
          </span>
          <div className="jot-document-actions">
            {!selectedDeleted && onAskAgent && <button className="jot-icon-btn" type="button" aria-label={copy('让 Hermes 看这条笔记', 'Ask Hermes about this note')}
              title={copy('让 Hermes 看这条笔记', 'Ask Hermes about this note')} disabled={busy} onClick={askAgent}><Icon name="ask" /></button>}
            {!selectedDeleted && <button className="jot-icon-btn" type="button" aria-label={copy('添加图片或附件', 'Add image or attachment')} title={copy('添加图片或附件', 'Add image or attachment')}
              disabled={uploadBusy} onClick={() => fileInput.current?.click()}><Icon name="attachment" /></button>}
            <ActionMenu triggerLabel={copy('更多笔记操作', 'More note actions')} items={menuItems} />
            {selectedDeleted && <button className="jot-btn jot-primary" type="button" disabled={busy || !selectedNote}
              onClick={() => { if (selectedNote) restoreNote(selectedNote.id, selectedNote.revision) }}><Icon name="restore" />{copy('恢复', 'Restore')}</button>}
          </div>
        </div>
        {selectedStatus?.phase === 'conflict' && <div className="jot-notice" role="status">
          <p>{copy('这条笔记有新版本，你的草稿已保留。', 'This note has a newer version. Your draft is still here.')}</p>
          <div className="jot-notice-actions">
            <button className="jot-text-btn" type="button" disabled={busy} onClick={loadLatest}>{copy('载入最新版本', 'Load latest version')}</button>
            <button className="jot-text-btn" type="button" disabled={busy} onClick={saveAsNew}>{copy('将草稿另存为新笔记', 'Save draft as a new note')}</button>
          </div>
        </div>}
        {(recoveries.length > 1 || recoveries.some(item => item.draftId !== draft.draftId)) && <div className="jot-notice">
          <label>{copy('保留的草稿', 'Kept drafts')}
            <select className="jot-select" aria-label={copy('切换保留的草稿', 'Choose a kept draft')} value={draft.draftId ?? ''}
              onChange={event => {
                const selected = recoveries.find(item => item.draftId === event.target.value)
                if (!selected) return
                selectionGeneration.current++
                installDraft(selected)
                setStatus(selected.noteId, { phase: selectedNote && selected.baseRevision === selectedNote.revision && !selectedNote.deletedAt ? 'dirty' : 'conflict' })
              }}>
              {!draft.draftId && <option value="">{copy('当前版本', 'Current version')}</option>}
              {recoveries.map((item, index) => <option key={item.draftId} value={item.draftId}>{`${copy('草稿', 'Draft')} ${index + 1} · ${item.title || copy('无标题', 'Untitled')}`}</option>)}
            </select>
          </label>
        </div>}
        {selectedStatus?.phase === 'error' && <div className="jot-notice is-error" role="alert">
          <p>{copy('暂时没能保存，内容仍保留在这里。', 'Could not save right now. Your changes are still here.')}{selectedStatus.message ? ` ${selectedStatus.message}` : ''}</p>
          <button className="jot-text-btn" type="button" onClick={() => void saveDraft(draft.noteId)}>{copy('重试保存', 'Try saving again')}</button>
        </div>}
        {selectedDeleted && <div className="jot-notice">{copy('这条笔记在回收站中，恢复后可以继续编辑。', 'This note is in Trash. Restore it to edit again.')}</div>}
        <div className="jot-editor-body">
          <div className="jot-document">
            <input ref={titleInput} className="jot-title-input" value={draft.title} readOnly={selectedDeleted} maxLength={240}
              placeholder={copy('无标题', 'Untitled')} aria-label={copy('笔记标题', 'Note title')} onChange={event => patchDraft({ title: event.target.value })}
              onKeyDown={event => {
                // Enter moves from the title into the body, like most note apps.
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault(); editorActions.current?.focus()
                }
              }} />
            <RichEditor acknowledgedRevision={editorRevisions[draft.noteId] ?? 0} loadEditor={api.loadEditor} onSave={() => void saveDraft(draft.noteId)} onPreviewAttachment={previewAttachment}
              onSelectionChange={onEditorSelection}
              onFiles={files => { if (!selectedDeleted) void uploadFiles(files) }}
              onExternalLink={url => void perform(async () => { await api.openExternal?.(url) })}
              resolveAttachmentUrl={api.resolveAttachmentUrl} key={draft.noteId} value={draft.content} locale={locale} readOnly={selectedDeleted}
              onRequestAttachment={selectedDeleted || uploadBusy ? undefined : () => fileInput.current?.click()}
              onReady={actions => { releaseEditorFocus(); editorActions.current = actions }}
              onChange={(content, revision) => {
                if (revision !== undefined) setEditorRevisions(previous => ({ ...previous, [draft.noteId]: revision }))
                patchDraft({ content })
              }} />
          </div>
        </div>
      </> : <div className="jot-empty jot-editor-empty">
        <JotIcon size={36} />
        <div className="jot-empty-title">{copy('随时记，慢慢想', 'A place to keep your thoughts')}</div>
        <p>{copy('选一条笔记继续，或者记下新的想法。', 'Open a note, or start with a new thought.')}</p>
        <button className="jot-btn jot-primary" type="button" onClick={newNote} disabled={busy}><Icon name="new-note" />{copy('新建笔记', 'New note')}</button>
      </div>}
    </section>
  )

  const showList = mode === 'compact' ? !compactEditor : !listCollapsed
  return <div className={`jot-app jot-${mode}${chromeInset ? ' jot-host-chrome' : ''}`} lang={en ? 'en' : 'zh-CN'}
    onFocusCapture={event => {
      releaseEditorFocus()
      if (!selectedDeleted && editorActions.current && (event.target as HTMLElement).closest('.ProseMirror')) {
        try { editorFocusLease.current = onEditorFocus?.(editorActions.current) ?? null }
        catch { setError(copy('快捷键暂时不可用，请使用格式按钮。', 'Shortcuts are unavailable; use the formatting buttons.')) }
      }
    }} onBlurCapture={releaseEditorFocus}
    onKeyDownCapture={event => {
      if ((event.target as HTMLElement).closest('[role="dialog"],[role="menu"]')) return
      // "?" lists every key Jot handles, from anywhere outside text fields.
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !editableTarget(event.target)) {
        event.preventDefault(); event.stopPropagation(); setHelpOpen(true)
        return
      }
      // "/" searches the library from anywhere in Jot except text fields.
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !editableTarget(event.target)) {
        event.preventDefault(); event.stopPropagation()
        if (mode === 'compact') openSearch()
        else { setListCollapsed(false); requestAnimationFrame(() => searchInput.current?.focus()) }
        return
      }
      const action = appShortcut(event.nativeEvent)
      if (!action || !draft) return
      if (action === 'save' && !selectedDeleted) { event.preventDefault(); event.stopPropagation(); void saveDraft(draft.noteId) }
      else if (action === 'find') {
        const target = event.currentTarget.querySelector('.jot-embedded-editor')
        if (target && editorActions.current?.handleShortcut('find', target)) { event.preventDefault(); event.stopPropagation() }
      }
    }} onPasteCapture={event => {
      if ((event.target as HTMLElement).closest('[role="dialog"]') || !(event.target as HTMLElement).closest('.ProseMirror') || selectedDeleted) return
      const files = [...event.clipboardData.files]
      if (files.length) { event.preventDefault(); event.stopPropagation(); void uploadFiles(files) }
    }} onDragOver={event => {
      if (!(event.target as HTMLElement).closest('[role="dialog"]') && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) }
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={event => {
      if ((event.target as HTMLElement).closest('[role="dialog"]') || !event.dataTransfer.files.length) return
      event.preventDefault(); event.stopPropagation(); setDragging(false)
      const id = (event.target as Element).closest('[data-note-id]')?.getAttribute('data-note-id')
      const target = id ? snapshotRef.current?.notes.find(note => note.id === id) : null
      if (target) selectNote(target)
      else if (mode === 'compact' && !compactEditor) {
        setError(copy('请先打开目标笔记，再拖入文件。', 'Open the target note before dropping files.')); return
      }
      void uploadFiles([...event.dataTransfer.files])
    }} onClickCapture={event => {
      const element = (event.target as Element).closest('[data-jot-attachment-id]')
      const id = element?.getAttribute('data-jot-attachment-id')
      if (id && /^[a-f0-9]{32}$/.test(id)) { event.preventDefault(); event.stopPropagation(); previewAttachment(id) }
    }}>
    <style>{jotStyles}</style>
    <input ref={fileInput} type="file" multiple hidden aria-label={copy('选择附件', 'Choose attachments')}
      onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void uploadFiles(files) }} />
    {api.importNotes && <input ref={importInput} type="file" multiple hidden accept={IMPORT_ACCEPT} aria-label={copy('选择要导入的笔记', 'Choose notes to import')}
      onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void importFiles(files) }} />}
    {mode === 'wide' && <header className="jot-workbench-header" data-window-drag={chromeInset ? '' : undefined} aria-label={copy('随记工具栏', 'Jot toolbar')}>
      <JotIcon size={20} />
      <span className="jot-brand">{copy('随记', 'Jot')}</span>
      <button className="jot-btn jot-new-note-btn" type="button" onClick={newNote} disabled={busy} title={copy('新建笔记', 'New note')}>
        <Icon name="new-note" />{copy('新建', 'New')}</button>
      <button className="jot-icon-btn" type="button" onMouseDown={event => event.preventDefault()} onClick={() => openCapture()} aria-label={copy('摘录到随记', 'Capture text')} title={copy('摘录到随记', 'Capture text')}><Icon name="capture" /></button>
      <div className="jot-toolbar-end">
        <button className="jot-icon-btn" type="button" onClick={() => setListCollapsed(value => !value)}
          aria-label={listCollapsed ? copy('显示笔记列表', 'Show note list') : copy('隐藏笔记列表', 'Hide note list')}
          title={listCollapsed ? copy('显示笔记列表', 'Show note list') : copy('隐藏笔记列表，专注写作', 'Hide note list to focus on writing')}><Icon name="sidebar" /></button>
      </div>
    </header>}
    {mode === 'compact' && <header className="jot-topbar" aria-label={copy('笔记工具栏', 'Notes toolbar')}>
      {compactEditor && draft ? <button className="jot-back" type="button" onClick={goToList}><Icon name="back" />{copy('笔记', 'Notes')}</button>
        : <span className="jot-toolbar-label">{copy('笔记', 'Notes')}</span>}
      <div className="jot-toolbar-end">
        <button className="jot-icon-btn" type="button" onMouseDown={event => event.preventDefault()} onClick={() => openCapture()} aria-label={copy('摘录到随记', 'Capture text')} title={copy('摘录选中的文字', 'Capture selected text')}><Icon name="capture" /></button>
        <button className="jot-icon-btn" type="button" onClick={newNote} disabled={busy} aria-label={copy('新建笔记', 'New note')} title={copy('新建笔记', 'New note')}><Icon name="new-note" /></button>
        <button className="jot-icon-btn" type="button" aria-pressed={!compactEditor && searchOpen} onClick={() => {
          if (searchOpen && !compactEditor) { setSearchOpen(false); setQuery('') } else openSearch()
        }} aria-label={copy('搜索', 'Search')} title={copy('搜索（/）', 'Search (/)')}><Icon name="search" /></button>
        {onExpand && <button className="jot-icon-btn" type="button" onClick={() => {
          const current = compactEditor ? draftRef.current : null
          if (current) installDraft(current)
          const source = current ? draftRef.current : null
          onExpand(source?.noteId, source?.draftId, source?.baseRevision)
        }} aria-label={copy('打开完整笔记页', 'Open full notes')} title={copy('打开完整笔记页', 'Open full notes')}><Icon name="expand" /></button>}
      </div>
    </header>}
    {error && <div className="jot-global-error" role="alert"><span>{error}</span><button className="jot-text-btn" type="button" onClick={() => { setError(''); void refresh().catch(cause => setError(describeError(cause, locale))) }}>{copy('重试', 'Retry')}</button></div>}
    {uploadBusy && <div className="jot-upload-line" role="status">{copy('正在添加附件…', 'Adding files…')}</div>}
    {importBusy && <div className="jot-upload-line" role="status">{copy('正在导入笔记…', 'Importing notes…')}</div>}
    {dragging && <div className="jot-drop-hint">{copy('松开以添加到笔记', 'Drop files into the note')}</div>}
    {!snapshot ? <div className="jot-loading" role="status">{copy('正在打开随记…', 'Opening Jot…')}</div>
      : <main className="jot-layout">{mode === 'wide' ? <>
        {showList && listPanel}
        {showList && <div className="jot-resize-handle" role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label={copy('调整笔记列表宽度', 'Resize note list')} aria-valuemin={LIST_WIDTH.min} aria-valuemax={LIST_WIDTH.max} aria-valuenow={listWidth}
          onPointerDown={startResize} onDoubleClick={() => { setListWidth(LIST_WIDTH.initial); storage.set('hermes-jot:list-width:v1', null) }}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeWidth(-16) }
            else if (event.key === 'ArrowRight') { event.preventDefault(); nudgeWidth(16) }
          }} />}
        {editorPanel}</> : showList ? listPanel : editorPanel}</main>}
    {toast && <div className="jot-toast" role="status" aria-live="polite" key={toast.id}>
      <span>{toast.text}</span>
      {toast.action && <button className="jot-text-btn" type="button" onClick={() => { const run = toast.action!.run; setToast(null); run() }}>{toast.action.label}</button>}
      <button className="jot-toast-close" type="button" aria-label={copy('关闭提示', 'Dismiss')} onClick={() => setToast(null)}><JotActionIcon name="close" size={14} /></button>
    </div>}
    {contextPosition && draft && <ActionMenu triggerLabel={copy('笔记菜单', 'Note menu')} items={menuItems} position={contextPosition} onClose={() => setContextPosition(null)} />}
    {captureOpen && <Modal size="small" title={copy('摘录到随记', 'Capture text')} closeLabel={copy('关闭', 'Close')} onClose={() => { if (!busy) setCaptureOpen(false) }}>
      <CaptureDialog notes={snapshot?.notes ?? []} capturedText={captureText} source={captureSource} locale={locale} busy={busy} error={captureError}
        currentNoteId={draft && !selectedDeleted ? draft.noteId : null} onSubmit={capture} onClose={() => setCaptureOpen(false)} />
    </Modal>}
    {moveOpen && <Modal size="small" title={copy(selectMode ? `移动所选 ${selectedIds.size} 条笔记` : '移动笔记', selectMode ? `Move ${selectedIds.size} notes` : 'Move note')} closeLabel={copy('关闭', 'Close')} onClose={() => { if (!busy) setMoveOpen(false) }}>
      <label className="jot-dialog-field">{copy('目标文件夹', 'Destination folder')}<select className="jot-select" value={moveFolder} onChange={event => setMoveFolder(event.target.value)} aria-label={copy('目标文件夹', 'Destination folder')}>
        <option value="">{copy('未分类', 'Unfiled')}</option>{snapshot?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select></label>
      <div className="jot-dialog-actions">
        <button type="button" className="jot-btn" disabled={busy} onClick={() => setMoveOpen(false)}>{copy('取消', 'Cancel')}</button>
        <button type="button" className="jot-btn jot-primary" disabled={busy} onClick={moveSelected}>{copy('移动', 'Move')}</button>
      </div>
    </Modal>}
    {purgeConfirm && <Modal size="small" title={purgeConfirm === 'trash' ? copy('清空回收站', 'Empty Trash') : copy('永久删除', 'Delete permanently')}
      closeLabel={copy('关闭', 'Close')} onClose={() => { if (!busy) setPurgeConfirm(null) }}>
      <p className="jot-dialog-text">{purgeConfirm === 'trash'
        ? copy(`永久删除回收站里的 ${trashCount} 条笔记？此操作无法撤销；只被这些笔记使用的图片和附件也会一并删除。`, `Permanently delete ${trashCount} notes in Trash? This cannot be undone. Images and files used only by these notes are deleted too.`)
        : copy('永久删除这条笔记？此操作无法撤销；只被它使用的图片和附件也会一并删除。', 'Permanently delete this note? This cannot be undone. Images and files used only by this note are deleted too.')}</p>
      <div className="jot-dialog-actions">
        <button type="button" className="jot-btn" disabled={busy} onClick={() => setPurgeConfirm(null)}>{copy('取消', 'Cancel')}</button>
        <button type="button" className="jot-btn jot-danger-fill" disabled={busy} onClick={purgeConfirm === 'trash' ? emptyTrash : purgeSelected}>
          {purgeConfirm === 'trash' ? copy('清空回收站', 'Empty Trash') : copy('永久删除', 'Delete permanently')}</button>
      </div>
    </Modal>}
    {exportOpen && <Modal size="small" title={copy('导出笔记', 'Export notes')} closeLabel={copy('关闭', 'Close')} onClose={() => { if (!busy) setExportOpen(false) }}>
      <ExportDialog locale={locale} scope={exportScope} count={exportable} busy={busy} error={exportError}
        initialFormat={(['docx', 'pdf', 'md'] as const).find(format => format === storage.get('hermes-jot:export-format:v1')) ?? 'docx'}
        onSubmit={format => void exportLibrary(format)} onClose={() => setExportOpen(false)} />
    </Modal>}
    {revertConfirm && draft && <Modal size="small" title={copy('撤销 AI 的修改', 'Undo AI edits')} closeLabel={copy('关闭', 'Close')} onClose={() => { if (!busy) setRevertConfirm(false) }}>
      <p className="jot-dialog-text">{copy('这篇笔记会回到 AI 修改之前的样子；AI 连续做的几次修改会一起撤销。AI 写入的版本不会另外保留。',
        'This note returns to how it was before AI edited it. Consecutive AI edits are undone together, and the AI version is not kept.')}</p>
      <div className="jot-dialog-actions">
        <button type="button" className="jot-btn" disabled={busy} onClick={() => setRevertConfirm(false)}>{copy('取消', 'Cancel')}</button>
        <button type="button" className="jot-btn jot-primary" disabled={busy || !agentUndoable} onClick={revertAgent}>{copy('撤销修改', 'Undo edits')}</button>
      </div>
    </Modal>}
    {helpOpen && <Modal title={copy('键盘快捷键', 'Keyboard shortcuts')} closeLabel={copy('关闭', 'Close')} onClose={() => setHelpOpen(false)}>
      <ShortcutHelp locale={locale} />
    </Modal>}
    {attachmentPreview && <AttachmentPreview hostPreview={attachmentPreviewContent?.(attachmentPreview)} onDownload={api.downloadAttachment ? () => api.downloadAttachment!(attachmentPreview) : undefined} attachment={attachmentPreview} onClose={() => setAttachmentPreview(null)} locale={locale}
      getCapabilities={api.getAttachmentCapabilities} onOpenNative={api.openAttachment ? signal => api.openAttachment!(attachmentPreview.id, { signal }) : undefined} />}
  </div>
}

export default JotApp
