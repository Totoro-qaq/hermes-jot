import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JotApiError } from './api.js'
import { saveHumanDraft } from './save-draft.js'
import { draftFromNote, draftFingerprint, emptyDocument, receiveLatestDraft, reconcileDraft, sameDraftGeneration, sharedDraftStorage as defaultDraftStorage } from './drafts.js'
import type { NoteDraft } from './drafts.js'
import type { JotPersistence } from '../hermes/persistence.js'
import type { ReactNode } from 'react'
import { editHumanDraft, takeUntouchedFreshNote } from './draft-lifecycle.js'
import { acceptRemoteAppend, planRemoteAppend, remoteBase, type RemoteBase } from './remote-append.js'
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
import { intlLocale, isRtlLocale, translator } from './i18n.js'

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

const REMOTE_APPEND_TIMEOUT_MS = 10_000
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

export function JotApp({ readSelectedText, onEditorSelection, persistence, attachmentPreviewContent, mode, onExpand, openNoteRequest, onNoteRequestHandled, api, locale = 'en', chromeInset = false, onEditorFocus, onAttachmentPreview, attachmentDialogRequest, onAttachmentDialogHandled, commandRequest, onCommandClaim, onCommandHandled, changeSignal, onAskAgent }: JotAppProps) {
  const storage = persistence?.preferences ?? defaultPreferences
  const sharedDraftStorage = persistence?.drafts ?? defaultDraftStorage
  const { readDraft, persistDraft, editDraft, savedDraft, recoveryDrafts } = useMemo(() => ({
    readDraft: sharedDraftStorage.read.bind(sharedDraftStorage),
    persistDraft: sharedDraftStorage.persist.bind(sharedDraftStorage),
    editDraft: sharedDraftStorage.edit.bind(sharedDraftStorage),
    savedDraft: sharedDraftStorage.saved.bind(sharedDraftStorage),
    recoveryDrafts: sharedDraftStorage.all.bind(sharedDraftStorage),
  }), [sharedDraftStorage])
  const t = useMemo(() => translator(locale), [locale])
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
  /** The saved version each open draft started from, so an agent's append can be told apart from an edit. */
  const remoteBases = useRef(new Map<string, RemoteBase>())
  /** At most one remote append per note waits on the editor; it settles to whether the editor took it. */
  const remoteMerges = useRef(new Map<string, Promise<boolean>>())
  /** Merges the editor never confirmed; it may hold their blocks already, so they are not sent again. */
  const unconfirmedMerges = useRef(new Map<string, { baseRevision: number; revision: number }>())
  const editorNote = useRef<string | null>(null)
  const mergeRemote = useRef<(remote: Note, agentRevision: number | undefined, saving?: boolean) => boolean>(() => false)
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

  const rememberBase = useCallback((note: Note) => {
    const bases = remoteBases.current
    for (const id of bases.keys()) if (id !== note.id && id !== draftRef.current?.noteId && !drafts.current.get(id)?.dirty) bases.delete(id)
    bases.set(note.id, remoteBase(note))
    for (const [id, merge] of unconfirmedMerges.current) if (drafts.current.get(id)?.baseRevision !== merge.baseRevision) unconfirmedMerges.current.delete(id)
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
    if (result.remoteChanged && !inFlight.current.has(current.noteId) && !mergeRemote.current(remote, next.agentEdits?.[remote.id]?.revision)) setStatus(current.noteId, { phase: 'conflict' })
    if (result.draft !== current && !inFlight.current.has(current.noteId)) { rememberBase(remote); installDraft(result.draft) }
  }, [installDraft, rememberBase, setStatus])

  const saveDraft = useCallback((id: string): Promise<boolean> => {
    const existing = inFlight.current.get(id)
    if (existing) return existing
    // The editor is taking an agent's append; save on top of it once it has.
    const merging = remoteMerges.current.get(id)
    if (merging) return merging.then(merged => merged ? saveDraft(id) : false)
    const submitted = drafts.current.get(id)
    if (!submitted?.dirty) return Promise.resolve(true)
    setStatus(id, { phase: 'saving' })
    const source = apiRef.current
    const operation = (async () => {
      try {
        const saved = await saveHumanDraft(source, submitted)
        rememberBase(saved)
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
        if (conflict && mounted.current) {
          // An agent append that raced this save goes into the editor; the next autosave carries both.
          const state = await source.getState().catch(() => null)
          const latest = state?.notes.find(note => note.id === id)
          if (latest && mounted.current && source === apiRef.current && mergeRemote.current(latest, state!.agentEdits?.[id]?.revision, false)) {
            setStatus(id, { phase: 'dirty' })
            return false
          }
        }
        setStatus(id, { phase: conflict ? 'conflict' : 'error', message: describeError(cause, locale) })
        return false
      } finally {
        inFlight.current.delete(id)
        if (mounted.current) void refresh().catch(() => {})
      }
    })()
    inFlight.current.set(id, operation)
    return operation
  }, [installDraft, rememberBase, refresh, setStatus, locale])

  /** A dirty open draft meets a newer saved version: merge an agent's append, otherwise keep the draft as a conflict. */
  const followRemote = (remote: Note) => {
    const current = draftRef.current
    if (!current || current.noteId !== remote.id || remote.revision < current.baseRevision || inFlight.current.has(remote.id)) return
    if (reconcileDraft(current, remote).remoteChanged && !mergeRemote.current(remote, snapshotRef.current?.agentEdits?.[remote.id]?.revision)) setStatus(remote.id, { phase: 'conflict' })
  }

  // True when the editor is taking (or already taking) the remote change, so no conflict is shown.
  mergeRemote.current = (remote, agentRevision, saving = inFlight.current.has(remote.id)) => {
    const started = draftRef.current
    const actions = editorActions.current
    const plan = planRemoteAppend({ draft: started, base: remoteBases.current.get(remote.id), remote, saving, agentRevision,
      unconfirmed: unconfirmedMerges.current.get(remote.id), pending: remoteMerges.current.has(remote.id), editorReady: Boolean(actions?.appendBlocks) && editorNote.current === remote.id })
    if (plan.action === 'pending') return true
    if (plan.action !== 'merge' || !started || !actions?.appendBlocks) return false
    const generation = selectionGeneration.current
    const merge = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const appended = await Promise.race([
        Promise.resolve().then(() => actions.appendBlocks!(plan.blocks)).catch(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), REMOTE_APPEND_TIMEOUT_MS) }),
      ]).finally(() => clearTimeout(timer))
      remoteMerges.current.delete(remote.id)
      if (!mounted.current) return false
      // The editor's change message arrives before its acknowledgement, so the draft already
      // holds the appended blocks. Only that confirmation may move the draft onto the remote
      // revision; otherwise the next save would silently remove the agent's text.
      const next = appended === true && selectionGeneration.current === generation ? acceptRemoteAppend(draftRef.current, started, remote) : null
      if (!next) {
        // The blocks may be in the editor (a late or refused acknowledgement); never append them twice.
        unconfirmedMerges.current.set(remote.id, { baseRevision: started.baseRevision, revision: remote.revision })
        const kept = drafts.current.get(remote.id)
        if (kept?.dirty && kept.baseRevision < remote.revision && !inFlight.current.has(remote.id)) setStatus(remote.id, { phase: 'conflict' })
        return false
      }
      rememberBase(remote)
      installDraft(next)
      setStatus(remote.id, { phase: 'dirty' })
      setSnapshot(previous => {
        if (!previous) return previous
        const updated = { ...previous, notes: previous.notes.map(note => note.id === remote.id && note.revision < remote.revision ? remote : note) }
        snapshotRef.current = updated
        return updated
      })
      // The note may have moved again while the editor applied this append.
      const latest = snapshotRef.current?.notes.find(note => note.id === remote.id)
      if (latest && latest.revision > remote.revision) followRemote(latest)
      return true
    })()
    remoteMerges.current.set(remote.id, merge)
    return true
  }

  useEffect(() => {
    mounted.current = true
    // A failed poll shows an error; the next successful poll clears only that error.
    // Rethrowing tells the live refresh to retry soon instead of waiting for the slow fallback.
    const pollError = { current: '' }
    const poll = () => {
      return refresh().then(() => { if (mounted.current) setError(current => current && current === pollError.current ? '' : current) }, cause => {
        if (!mounted.current) return
        pollError.current = describeError(cause, locale)
        setError(pollError.current)
        throw cause
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
    if (result.draft.baseRevision === note.revision) rememberBase(note)
    installDraft(result.draft)
    setStatus(note.id, { phase: result.remoteChanged ? 'conflict' : result.draft.dirty ? 'dirty' : 'saved' })
    setCompactEditor(true)
    setSearchOpen(false)
    setError('')
  }, [installDraft, rememberBase, saveDraft, setStatus, onNoteRequestHandled, releaseFreshNote])

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
      rememberBase(note)
      drafts.current.set(requested.noteId, draftFromNote(note))
      setStatus(requested.noteId, { phase: 'saved' })
    }
    if (result.replaced && result.draft) { rememberBase(note); installDraft(result.draft) }
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
    showToast(t('Note restored'))
  })

  /** Trash is reversible, so deleting asks nothing and offers Undo instead. */
  const removeNote = () => void perform(async () => {
    const current = draftRef.current
    if (!current) return
    if (current.dirty && !await saveDraft(current.noteId)) return
    const latest = drafts.current.get(current.noteId) ?? current
    // Typing during the pending save belongs to the draft, not to this delete.
    if (latest.dirty) return
    if (sharedDraftStorage.all(current.noteId).length) throw new Error(t('Resolve this note’s kept drafts before deleting.'))
    freshNotes.current.delete(current.noteId)
    const deleted = await api.deleteNote(current.noteId, latest.baseRevision)
    if (sameDraftGeneration(draftRef.current, latest)) {
      setCompactEditor(false)
      draftRef.current = null
      setDraft(null)
    }
    await refresh()
    showToast(t('Moved to Trash'), {
      label: t('Undo'), run: () => restoreNote(deleted.id, deleted.revision),
    })
  })

  const purgeSelected = () => void perform(async () => {
    const current = draftRef.current
    const note = current ? snapshotRef.current?.notes.find(item => item.id === current.noteId) : undefined
    if (!note?.deletedAt || !api.purgeNote) return
    if (sharedDraftStorage.all(note.id).length) throw new Error(t('Resolve this note’s kept drafts first.'))
    await api.purgeNote(note.id, note.revision)
    setPurgeConfirm(null)
    draftRef.current = null
    setDraft(null)
    setCompactEditor(false)
    await refresh()
    showToast(t('Deleted permanently'))
  })

  const emptyTrash = () => void perform(async () => {
    if (!api.emptyTrash) return
    const kept = (snapshotRef.current?.notes ?? []).filter(note => note.deletedAt && sharedDraftStorage.all(note.id).length)
    if (kept.length) throw new Error(t('Some notes in Trash still have kept drafts; open and resolve them first.'))
    const result = await api.emptyTrash()
    setPurgeConfirm(null)
    if (draftRef.current && result.purged.includes(draftRef.current.noteId)) { draftRef.current = null; setDraft(null); setCompactEditor(false) }
    await refresh()
    showToast(t('Deleted {count} notes permanently', { count: result.purged.length }))
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
          if (statusesRef.current[current.noteId]?.phase === 'conflict') throw new Error(t('Resolve the kept draft conflict before appending.'))
          const key = JSON.stringify(submission)
          if (pendingCapture.current && (pendingCapture.current.key !== key || pendingCapture.current.noteId !== current.noteId)) {
            throw new Error(t('Save the previously kept excerpt before adding another.'))
          }
          if (!pendingCapture.current) {
            patchDraft({ content: appendExcerpt(current.content, submission.text, submission.source) })
            pendingCapture.current = { key, noteId: current.noteId }
          }
          // An older autosave can still be in flight when the excerpt is added.
          // Its acknowledgement does not include this new content.
          let saved = await saveDraft(current.noteId)
          if (saved && drafts.current.get(current.noteId)?.dirty) saved = await saveDraft(current.noteId)
          if (!saved || drafts.current.get(current.noteId)?.dirty) throw new Error(t('The excerpt is kept in the note draft; retrying will not append it again.'))
        } else {
          const latest = await api.getNote(submission.targetNoteId)
          if (latest.deletedAt) throw new Error(t('The target note is in Trash.'))
          if (drafts.current.get(latest.id)?.dirty || sharedDraftStorage.all(latest.id).length) throw new Error(t('Open and resolve the target note draft before appending.'))
          await api.updateNote(latest.id, { revision: latest.revision, content: appendExcerpt(latest.content, submission.text, submission.source) })
          await refresh()
        }
        showToast(t('Added to the note'))
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
    if (!result.save) showToast(t('Exported {filename}', { filename: result.filename }))
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
        if (current?.noteId !== id && (drafts.current.get(id)?.dirty || sharedDraftStorage.all(id).length)) throw new Error(t('Resolve the target note draft before moving.'))
        if (current?.noteId === id && current.dirty) {
          if (statusesRef.current[id]?.phase === 'conflict' || !await saveDraft(id)) throw new Error(t('Resolve the kept draft first.'))
          if (draftRef.current?.dirty) throw new Error(t('Finish editing before moving.'))
        }
        if (sharedDraftStorage.all(id).length) throw new Error(t('Resolve this note’s kept drafts before moving.'))
        const before = await api.getNote(id)
        if (before.deletedAt) continue
        if (before.folderId === (moveFolder || null)) { completed++; continue }
        const saved = await api.updateNote(id, { revision: before.revision, folderId: moveFolder || null })
        const active = draftRef.current
        if (active?.noteId === id && active.baseRevision === before.revision) {
          rememberBase(saved)
          installDraft({ ...active, baseRevision: saved.revision,
            folderId: active.folderId === before.folderId ? saved.folderId : active.folderId })
        }
        completed++
      }
      setMoveOpen(false); setSelectedIds(new Set()); await refresh()
      showToast(t('Moved {count} notes', { count: completed }))
    } catch (cause) {
      await refresh()
      throw new Error(`${t('Moved {count}.', { count: completed })} ${describeError(cause, locale)}`)
    }
  })

  /** Several notes come back from Trash at once; each keeps the revision its own deletion produced. */
  const restoreMany = (targets: readonly { id: string; revision: number }[]) => void perform(async () => {
    let restored = 0
    try {
      for (const target of targets) { await api.restoreNote(target.id, target.revision); restored++ }
      await refresh()
      showToast(t('Restored {count} notes', { count: restored }))
    } catch (cause) {
      await refresh()
      throw new Error(`${t('Restored {count}.', { count: restored })} ${describeError(cause, locale)}`)
    }
  })

  /** Like a single note, a batch moves to Trash without a question and offers Undo. */
  const deleteSelected = () => void perform(async () => {
    const deleted: { id: string; revision: number }[] = []
    const undo = () => ({ label: t('Undo'), run: () => restoreMany(deleted) })
    try {
      for (const id of [...selectedIds]) {
        const current = draftRef.current
        if (current?.noteId !== id && (drafts.current.get(id)?.dirty || sharedDraftStorage.all(id).length)) throw new Error(t('Resolve the target note draft before deleting.'))
        if (current?.noteId === id && current.dirty) {
          if (statusesRef.current[id]?.phase === 'conflict' || !await saveDraft(id) || draftRef.current?.dirty) {
            throw new Error(t('Resolve the active draft before deleting.'))
          }
        }
        if (sharedDraftStorage.all(id).length) throw new Error(t('Resolve this note’s kept drafts before deleting.'))
        const before = await api.getNote(id)
        if (before.deletedAt) continue
        const removed = await api.deleteNote(id, before.revision)
        deleted.push({ id: removed.id, revision: removed.revision })
      }
      setSelectedIds(new Set()); setSelectMode(false)
      await refresh()
      showToast(t('Moved {count} notes to Trash', { count: deleted.length }), deleted.length ? undo() : undefined)
    } catch (cause) {
      await refresh()
      // Notes already moved stay recoverable from the same toast.
      if (deleted.length) showToast(t('Moved {count} notes to Trash', { count: deleted.length }), undo())
      throw new Error(`${t('Processed {count}.', { count: deleted.length })} ${describeError(cause, locale)}`)
    }
  })

  const uploadFiles = async (files: File[]) => {
    if (uploadBusy || files.length === 0) return
    if (files.length > 20) { setError(t('Add at most 20 files at once.')); return }
    setUploadBusy(true); setError('')
    try {
      let target = draftRef.current
      if (!target) {
        const note = await api.createNote({ title: '' })
        await refresh(); selectNote(note); target = drafts.current.get(note.id) ?? draftFromNote(note)
      }
      if (snapshotRef.current?.notes.find(note => note.id === target!.noteId)?.deletedAt) throw new Error(t('Restore the note before adding files.'))
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
          showToast(t('Files were kept in a recovery draft of the original note.'))
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
    if (next.baseRevision === saved.revision) rememberBase(saved)
    drafts.current.set(saved.id, next)
    if (draftRef.current?.noteId === saved.id) installDraft(next)
    setStatus(saved.id, { phase: result.remoteChanged ? 'conflict' : next.dirty ? 'dirty' : 'saved' })
    setRevertConfirm(false)
    await refresh()
    showToast(t('AI edits undone'))
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
        unsavedMessage: t('The draft is not saved. Resolve the kept draft before exporting notes.'),
      })
      await downloadNote(result)
      setExportOpen(false)
      if (!result.save) showToast(result.attachments
        ? t('Exported {count} notes and {files}', { count: result.notes, files: t('{count} files', { count: result.attachments }) })
        : t('Exported {count} notes', { count: result.notes }))
    } catch (cause) { setExportError(describeError(cause, locale)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const toggleAgent = () => void perform(async () => {
    const enabled = !snapshot?.agentEnabled
    await api.setAgentEnabled(enabled); await refresh()
    showToast(enabled ? t('AI can now read and edit notes. Turn it off at any time.')
      : t('AI collaboration is off.'))
  })

  /** The agent cannot see which note is open beside the conversation; this hands it a reference. */
  const askAgent = () => void perform(async () => {
    const current = draftRef.current
    if (!current || !onAskAgent) return
    if (!snapshotRef.current?.agentEnabled) {
      showToast(t('Hermes can’t read notes until AI collaboration is on.'),
        { label: t('Turn on'), run: () => { if (!snapshotRef.current?.agentEnabled) toggleAgent() } })
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
    if (failure) setError(results.length ? `${t('{summary}. {error}', { summary: summary.toast, error: failure })}${summary.details ? `\n${summary.details}` : ''}` : failure)
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
  const exportScope = folderFilter === '__all__' ? t('all {count} notes', { count: exportable })
    : folderFilter === '__unfiled__' ? t('{count} unfiled notes', { count: exportable })
      : t('{count} notes in “{name}”', { count: exportable, name: actualFolder?.name ?? '' })

  useEffect(() => { setSelectedIds(new Set()); setSelectMode(false); setContextPosition(null) }, [view, folderFilter, query])

  const folderMenuItems: ActionMenuEntry[] = [
    { label: t('New folder…'), icon: 'new-folder', disabled: busy,
      onSelect: () => { setFolderForm('create'); setFolderName(''); setFolderDeleteConfirm(false) } },
    ...(actualFolder ? [
      { label: t('Rename folder…'), icon: 'rename' as const, disabled: busy,
        onSelect: () => { setFolderForm('rename'); setFolderName(actualFolder.name); setFolderDeleteConfirm(false) } },
      { separator: true } as const,
      { label: t('Delete folder…'), icon: 'trash' as const, danger: true, disabled: busy,
        onSelect: () => { setFolderForm(null); setFolderDeleteConfirm(true) } },
    ] : []),
  ]
  const sortable = !(view === 'recent' && !query.trim())
  const listMenuItems: ActionMenuEntry[] = [
    ...(sortable ? [
      { heading: t('Sort by') },
      ...(['modified', 'created', 'title'] as NoteSortMode[]).map(item => ({
        label: item === 'modified' ? t('Last modified') : item === 'created' ? t('Date created') : t('Title'),
        checked: effectiveSort === item, onSelect: () => setSortMode(item),
      })),
      { separator: true } as const,
    ] : []),
    ...(view !== 'trash' ? [{ label: selectMode ? t('Finish selection') : t('Select notes'), icon: 'checklist' as const,
      onSelect: () => { setSelectMode(value => !value); setSelectedIds(new Set()) } }] : []),
    ...(!hasFolders ? [{ label: t('New folder…'), icon: 'new-folder' as const, disabled: busy,
      onSelect: () => { setFolderForm('create'); setFolderName(''); setFolderDeleteConfirm(false) } }] : []),
    ...(view !== 'trash' && api.exportLibrary ? [{ label: folderFilter === '__all__' ? t('Export all notes…') : t('Export these notes…'),
      icon: 'export' as const, disabled: busy || exportable === 0, onSelect: () => { setExportError(''); setExportOpen(true) } }] : []),
    ...(view !== 'trash' && api.importNotes ? [{ label: t('Import notes…'), icon: 'import' as const,
      disabled: importBusy, onSelect: () => importInput.current?.click() }] : []),
    { separator: true } as const,
    { label: t('Keyboard shortcuts'), onSelect: () => setHelpOpen(true) },
    ...(view === 'trash' && api.emptyTrash ? [{ label: t('Empty Trash…'), icon: 'trash' as const, danger: true,
      disabled: busy || trashCount === 0, onSelect: () => setPurgeConfirm('trash') }] : []),
  ]

  const exportItems: ActionMenuEntry[] = [
    { heading: t('Export as') },
    ...(['md', 'docx', 'pdf', 'txt'] as ExportFormat[]).map(format => ({
      label: format === 'docx' ? t('Word (DOCX)') : format === 'md' ? 'Markdown' : format === 'pdf' ? 'PDF' : t('Plain text (TXT)'),
      icon: 'export' as const, onSelect: () => exportCurrent(format), disabled: busy || uploadBusy,
    })),
  ]
  const menuItems: ActionMenuEntry[] = !draft ? [] : selectedDeleted ? [
    { label: t('Restore note'), icon: 'restore', disabled: busy || !selectedNote,
      onSelect: () => { if (selectedNote) restoreNote(selectedNote.id, selectedNote.revision) } },
    { label: t('Duplicate as new note'), icon: 'duplicate', onSelect: duplicateNote, disabled: busy },
    { separator: true },
    ...exportItems,
    ...(api.purgeNote ? [{ separator: true } as const,
      { label: t('Delete permanently…'), icon: 'trash' as const, danger: true, disabled: busy, onSelect: () => setPurgeConfirm('note') }] : []),
  ] : [
    ...(agentUndoable ? [{ label: t('Undo AI edits…'), icon: 'restore' as const, disabled: busy, onSelect: () => setRevertConfirm(true) },
      { separator: true } as const] : []),
    ...(onAskAgent ? [{ label: t('Ask Hermes about this note'), icon: 'ask' as const, disabled: busy, onSelect: askAgent },
      { separator: true } as const] : []),
    { label: draft.pinned ? t('Unpin') : t('Pin'), icon: 'pin', onSelect: () => patchDraft({ pinned: !draftRef.current?.pinned }), disabled: busy },
    ...(hasFolders ? [{ label: t('Move to folder…'), icon: 'folder' as const, onSelect: () => { setMoveFolder(draftRef.current?.folderId ?? ''); setMoveOpen(true) }, disabled: busy }] : []),
    { label: t('Duplicate note'), icon: 'duplicate', onSelect: duplicateNote, disabled: busy },
    { separator: true },
    ...exportItems,
    { separator: true },
    { label: t('Move to Trash'), icon: 'trash', onSelect: removeNote, disabled: busy, danger: true },
  ]

  const savePhase: SavePhase = selectedStatus?.phase ?? (draft?.dirty ? 'dirty' : 'saved')
  const saveLabel = savePhase === 'saving' ? t('Saving…')
    : savePhase === 'error' ? t('Save failed · Retry')
      : savePhase === 'conflict' ? t('Draft kept')
        : draft?.dirty ? t('Unsaved') : t('Saved')
  const saveActionable = Boolean(draft && !selectedDeleted && draft.dirty && (savePhase === 'dirty' || savePhase === 'error'))
  const listLabel = (count: number) => t('{count} notes', { count })

  // In a right-to-left layout the list sits on the right, so widening it moves the handle left.
  const inlineDirection = isRtlLocale(locale) ? -1 : 1
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const start = event.clientX
    const initial = listWidth
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    let latest = initial
    const move = (moved: PointerEvent) => {
      latest = Math.round(Math.max(LIST_WIDTH.min, Math.min(LIST_WIDTH.max, initial + (moved.clientX - start) * inlineDirection)))
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
    <div className="jot-list-panel" role="complementary" aria-label={t('Note list')} style={mode === 'wide' ? { width: listWidth } : undefined}>
      <div className="jot-list-controls">
        {(mode === 'wide' || searchOpen) && (
          <div className="jot-search">
            <Icon name="search" />
            <input ref={searchInput} type="search" value={query} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery('') } }}
              placeholder={t('Search notes')} aria-label={t('Search notes')}
              title={t('Search notes (/)')} />
            {query && <button type="button" className="jot-search-clear" aria-label={t('Clear search')} title={t('Clear search')}
              onClick={() => { setQuery(''); searchInput.current?.focus() }}><JotActionIcon name="close" size={14} /></button>}
          </div>
        )}
        {hasFolders && <div className="jot-folder-line">
          <select className="jot-select" aria-label={t('Filter folders')} value={folderFilter}
            onChange={event => { setFolderFilter(event.target.value); setFolderForm(null); setFolderDeleteConfirm(false) }}>
            <option value="__all__">{t('All folders')}</option>
            <option value="__unfiled__">{t('Unfiled')}</option>
            {snapshot?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
          <ActionMenu triggerLabel={t('Folder actions')} triggerIcon="folder" items={folderMenuItems} />
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
            placeholder={folderForm === 'rename' ? t('New folder name') : t('Folder name')} aria-label={t('Folder name')}
            onKeyDown={event => { if (event.key === 'Escape') setFolderForm(null) }} />
          <button className="jot-btn jot-primary" type="submit" disabled={busy || !folderName.trim()}>{folderForm === 'rename' ? t('Save') : t('Create')}</button>
          <button className="jot-text-btn" type="button" onClick={() => setFolderForm(null)}>{t('Cancel')}</button>
        </form>}
        {folderDeleteConfirm && actualFolder && <div className="jot-inline-confirm" role="group" aria-label={t('Delete folder')}>
          <p>{t('Delete “{name}”? Its notes stay, as Unfiled.', { name: actualFolder.name })}</p>
          <div className="jot-notice-actions">
            <button className="jot-text-btn" type="button" onClick={() => setFolderDeleteConfirm(false)}>{t('Cancel')}</button>
            <button className="jot-btn jot-danger-fill" type="button" disabled={busy} onClick={() => void perform(async () => {
              await api.deleteFolder(actualFolder.id); setFolderFilter('__all__'); setFolderDeleteConfirm(false); await refresh()
            })}>{t('Delete folder')}</button>
          </div>
        </div>}
        <div className="jot-browse-line">
          <div className="jot-view-line">
            {(['recent', 'all', 'trash'] as const).map(item => <button type="button" key={item} aria-pressed={view === item}
              onClick={() => { setView(item); setQuery('') }}>
              {item === 'recent' ? t('Recent') : item === 'all' ? t('All') : t('Trash')}
            </button>)}
          </div>
          {snapshot && <span className="jot-list-total" title={query.trim() ? t('{count} results', { count: visibleNotes.length }) : listLabel(visibleNotes.length)}>{listLabel(visibleNotes.length)}</span>}
          <ActionMenu triggerLabel={t('Sort and options')} triggerIcon="sort" items={listMenuItems} />
        </div>
      </div>
      {selectMode && <div className="jot-selection-bar">
        <span>{t('{count} selected', { count: selectedIds.size })}</span>
        <button className="jot-text-btn" type="button" onClick={() => setSelectedIds(new Set(visibleNotes.map(note => note.id)))}>{t('Select all')}</button>
        {hasFolders && <button className="jot-text-btn" type="button" disabled={busy || !selectedIds.size} onClick={() => { setMoveFolder(''); setMoveOpen(true) }}>{t('Move')}</button>}
        <button className="jot-text-btn jot-danger" type="button" disabled={busy || !selectedIds.size} onClick={deleteSelected}>{t('Move to Trash')}</button>
        <button className="jot-text-btn" type="button" onClick={() => { setSelectMode(false); setSelectedIds(new Set()) }}>{t('Done')}</button>
      </div>}
      {query.trim() && visibleNotes.length > 0 && <div className="jot-list-label jot-search-label">{t('Results · title matches first')}</div>}
      {visibleNotes.length > 0 ? <NoteList key={`${folderFilter}:${effectiveSort}`} notes={visibleNotes} selectedId={draft?.noteId} onSelect={selectNote}
        selectMode={selectMode} selectedNoteIds={selectedIds} onToggleSelection={toggleSelection}
        hideFolderName={folderFilter !== '__all__'} agentEditedIds={agentEditedIds}
        onContextMenu={(note, event) => { event.preventDefault(); if (!selectMode) { selectNote(note); setContextPosition({ x: event.clientX, y: event.clientY }) } }}
        dateBasis={effectiveSort === 'title' ? 'none' : effectiveSort} query={query} folders={snapshot?.folders} locale={locale} view={view} /> : <div className="jot-note-list">
        {snapshot && <div className="jot-empty">
          <div className="jot-empty-title">{query.trim() ? t('No notes found') : view === 'trash' ? t('Trash is empty') : t('Leave a thought here')}</div>
          {elsewhere ? elsewhere.otherFolders > 0 ? <>
            <p>{t('Nothing in this folder; {count} in other folders.', { count: elsewhere.otherFolders })}</p>
            <button className="jot-btn" type="button" onClick={() => setFolderFilter('__all__')}>{t('Search all folders')}</button>
          </> : elsewhere.otherView > 0 ? <>
            <p>{view === 'trash' ? t('{count} matching notes outside Trash.', { count: elsewhere.otherView })
              : t('{count} matching notes in Trash.', { count: elsewhere.otherView })}</p>
            <button className="jot-btn" type="button" onClick={() => { setFolderFilter('__all__'); setView(view === 'trash' ? 'all' : 'trash') }}>
              {view === 'trash' ? t('Show in notes') : t('Show in Trash')}</button>
          </> : <p>{t('Try another word.')}</p>
            : <p>{view === 'trash' ? t('Notes you move to Trash wait here and can be restored.') : t('A reminder, a list, or something still taking shape.')}</p>}
          {!query.trim() && view !== 'trash' && <button className="jot-btn jot-primary" type="button" onClick={newNote} disabled={busy}>{t('New note')}</button>}
        </div>}
      </div>}
      <div className="jot-agent-line">
        <span className="jot-agent-label" title={t('When on, AI can search, read and edit notes through Jot tools when asked; nothing is read automatically.')}>
          <JotActionIcon name="sparkle" size={14} />{t('Allow AI collaboration')}</span>
        <button type="button" className="jot-switch" role="switch" aria-checked={snapshot?.agentEnabled ?? false} disabled={busy || !snapshot}
          aria-label={t('Allow AI collaboration')} onClick={toggleAgent} />
      </div>
    </div>
  )

  const editorPanel = (
    <section className="jot-editor-panel" aria-label={t('Note')}>
      {draft ? <>
        <div className="jot-editor-toolbar jot-context-toolbar">
          {hasFolders && <select className="jot-select" value={draft.folderId ?? ''} disabled={selectedDeleted} aria-label={t('Note folder')}
            onChange={event => patchDraft({ folderId: event.target.value || null })}>
            <option value="">{t('Unfiled')}</option>
            {snapshot?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>}
          {agentEdited && (agentUndoable
            ? <button type="button" className="jot-agent-chip" onClick={() => setRevertConfirm(true)} disabled={busy}
              title={t('This version was saved by AI through Jot tools. Select to undo the AI edits; the mark clears when you edit.')}>
              <JotActionIcon name="sparkle" size={12} />{t('AI edited')}</button>
            : <span className="jot-agent-chip" title={t('This version was saved by AI through Jot tools; it clears when you edit.')}>
              <JotActionIcon name="sparkle" size={12} />{t('AI edited')}</span>)}
          {!agentEdited && !selectedDeleted && snapshot?.agentEnabled && <span className="jot-agent-indicator" role="img"
            aria-label={t('AI collaboration is on')}
            title={t('AI collaboration is on: when you ask, AI can read and edit notes. Turn it off below the note list.')}>
            <JotActionIcon name="sparkle" size={14} /></span>}
          <span className="jot-save-slot" role="status" aria-live="polite">
            {saveActionable
              ? <button type="button" className={`jot-save-label is-action${savePhase === 'error' ? ' is-error' : ''}`} title={t('Save now (⌘/Ctrl+S)')}
                onClick={() => void saveDraft(draft.noteId)}>{saveLabel}</button>
              : <span className={`jot-save-label${savePhase === 'error' ? ' is-error' : ''}`} title={saveLabel}>{saveLabel}</span>}
          </span>
          <div className="jot-document-actions">
            {!selectedDeleted && onAskAgent && <button className="jot-icon-btn" type="button" aria-label={t('Ask Hermes about this note')}
              title={t('Ask Hermes about this note')} disabled={busy} onClick={askAgent}><Icon name="ask" /></button>}
            {!selectedDeleted && <button className="jot-icon-btn" type="button" aria-label={t('Add image or attachment')} title={t('Add image or attachment')}
              disabled={uploadBusy} onClick={() => fileInput.current?.click()}><Icon name="attachment" /></button>}
            <ActionMenu triggerLabel={t('More note actions')} items={menuItems} />
            {selectedDeleted && <button className="jot-btn jot-primary" type="button" disabled={busy || !selectedNote}
              onClick={() => { if (selectedNote) restoreNote(selectedNote.id, selectedNote.revision) }}><Icon name="restore" />{t('Restore')}</button>}
          </div>
        </div>
        {selectedStatus?.phase === 'conflict' && <div className="jot-notice" role="status">
          <p>{t('This note has a newer version. Your draft is still here.')}</p>
          <div className="jot-notice-actions">
            <button className="jot-text-btn" type="button" disabled={busy} onClick={loadLatest}>{t('Load latest version')}</button>
            <button className="jot-text-btn" type="button" disabled={busy} onClick={saveAsNew}>{t('Save draft as a new note')}</button>
          </div>
        </div>}
        {(recoveries.length > 1 || recoveries.some(item => item.draftId !== draft.draftId)) && <div className="jot-notice">
          <label>{t('Kept drafts')}
            <select className="jot-select" aria-label={t('Choose a kept draft')} value={draft.draftId ?? ''}
              onChange={event => {
                const selected = recoveries.find(item => item.draftId === event.target.value)
                if (!selected) return
                selectionGeneration.current++
                installDraft(selected)
                setStatus(selected.noteId, { phase: selectedNote && selected.baseRevision === selectedNote.revision && !selectedNote.deletedAt ? 'dirty' : 'conflict' })
              }}>
              {!draft.draftId && <option value="">{t('Current version')}</option>}
              {recoveries.map((item, index) => <option key={item.draftId} value={item.draftId}>{t('Draft {number} · {title}', { number: index + 1, title: item.title || t('Untitled') })}</option>)}
            </select>
          </label>
        </div>}
        {selectedStatus?.phase === 'error' && <div className="jot-notice is-error" role="alert">
          <p>{t('Could not save right now. Your changes are still here.')}{selectedStatus.message ? ` ${selectedStatus.message}` : ''}</p>
          <button className="jot-text-btn" type="button" onClick={() => void saveDraft(draft.noteId)}>{t('Try saving again')}</button>
        </div>}
        {selectedDeleted && <div className="jot-notice">{t('This note is in Trash. Restore it to edit again.')}</div>}
        <div className="jot-editor-body">
          <div className="jot-document">
            <input ref={titleInput} className="jot-title-input" value={draft.title} readOnly={selectedDeleted} maxLength={240}
              placeholder={t('Untitled')} aria-label={t('Note title')} onChange={event => patchDraft({ title: event.target.value })}
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
              onReady={actions => {
                releaseEditorFocus(); editorActions.current = actions; editorNote.current = actions ? draft.noteId : null
                // An append that arrived while the editor was loading can merge now.
                const remote = actions ? snapshotRef.current?.notes.find(note => note.id === draft.noteId) : undefined
                if (remote) followRemote(remote)
              }}
              onChange={(content, revision) => {
                if (revision !== undefined) setEditorRevisions(previous => ({ ...previous, [draft.noteId]: revision }))
                patchDraft({ content })
              }} />
          </div>
        </div>
      </> : <div className="jot-empty jot-editor-empty">
        <JotIcon size={36} />
        <div className="jot-empty-title">{t('A place to keep your thoughts')}</div>
        <p>{t('Open a note, or start with a new thought.')}</p>
        <button className="jot-btn jot-primary" type="button" onClick={newNote} disabled={busy}><Icon name="new-note" />{t('New note')}</button>
      </div>}
    </section>
  )

  const showList = mode === 'compact' ? !compactEditor : !listCollapsed
  return <div className={`jot-app jot-${mode}${chromeInset ? ' jot-host-chrome' : ''}`} lang={intlLocale(locale)} dir={isRtlLocale(locale) ? 'rtl' : 'ltr'}
    onFocusCapture={event => {
      releaseEditorFocus()
      if (!selectedDeleted && editorActions.current && (event.target as HTMLElement).closest('.ProseMirror')) {
        try { editorFocusLease.current = onEditorFocus?.(editorActions.current) ?? null }
        catch { setError(t('Shortcuts are unavailable; use the formatting buttons.')) }
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
        setError(t('Open the target note before dropping files.')); return
      }
      void uploadFiles([...event.dataTransfer.files])
    }} onClickCapture={event => {
      const element = (event.target as Element).closest('[data-jot-attachment-id]')
      const id = element?.getAttribute('data-jot-attachment-id')
      if (id && /^[a-f0-9]{32}$/.test(id)) { event.preventDefault(); event.stopPropagation(); previewAttachment(id) }
    }}>
    <style>{jotStyles}</style>
    <input ref={fileInput} type="file" multiple hidden aria-label={t('Choose attachments')}
      onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void uploadFiles(files) }} />
    {api.importNotes && <input ref={importInput} type="file" multiple hidden accept={IMPORT_ACCEPT} aria-label={t('Choose notes to import')}
      onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void importFiles(files) }} />}
    {mode === 'wide' && <header className="jot-workbench-header" data-window-drag={chromeInset ? '' : undefined} aria-label={t('Jot toolbar')}>
      <JotIcon size={20} />
      <span className="jot-brand">{t('Jot')}</span>
      <button className="jot-btn jot-new-note-btn" type="button" onClick={newNote} disabled={busy} title={t('New note')}>
        <Icon name="new-note" />{t('New')}</button>
      <button className="jot-icon-btn" type="button" onMouseDown={event => event.preventDefault()} onClick={() => openCapture()} aria-label={t('Capture text')} title={t('Capture text')}><Icon name="capture" /></button>
      <div className="jot-toolbar-end">
        <button className="jot-icon-btn" type="button" onClick={() => setListCollapsed(value => !value)}
          aria-label={listCollapsed ? t('Show note list') : t('Hide note list')}
          title={listCollapsed ? t('Show note list') : t('Hide note list to focus on writing')}><Icon name="sidebar" /></button>
      </div>
    </header>}
    {mode === 'compact' && <header className="jot-topbar" aria-label={t('Notes toolbar')}>
      {compactEditor && draft ? <button className="jot-back" type="button" onClick={goToList}><Icon name="back" />{t('Notes')}</button>
        : <span className="jot-toolbar-label">{t('Notes')}</span>}
      <div className="jot-toolbar-end">
        <button className="jot-icon-btn" type="button" onMouseDown={event => event.preventDefault()} onClick={() => openCapture()} aria-label={t('Capture text')} title={t('Capture selected text')}><Icon name="capture" /></button>
        <button className="jot-icon-btn" type="button" onClick={newNote} disabled={busy} aria-label={t('New note')} title={t('New note')}><Icon name="new-note" /></button>
        <button className="jot-icon-btn" type="button" aria-pressed={!compactEditor && searchOpen} onClick={() => {
          if (searchOpen && !compactEditor) { setSearchOpen(false); setQuery('') } else openSearch()
        }} aria-label={t('Search')} title={t('Search (/)')}><Icon name="search" /></button>
        {onExpand && <button className="jot-icon-btn" type="button" onClick={() => {
          const current = compactEditor ? draftRef.current : null
          if (current) installDraft(current)
          const source = current ? draftRef.current : null
          onExpand(source?.noteId, source?.draftId, source?.baseRevision)
        }} aria-label={t('Open full notes')} title={t('Open full notes')}><Icon name="expand" /></button>}
      </div>
    </header>}
    {error && <div className="jot-global-error" role="alert"><span>{error}</span><button className="jot-text-btn" type="button" onClick={() => { setError(''); void refresh().catch(cause => setError(describeError(cause, locale))) }}>{t('Retry')}</button></div>}
    {uploadBusy && <div className="jot-upload-line" role="status">{t('Adding files…')}</div>}
    {importBusy && <div className="jot-upload-line" role="status">{t('Importing notes…')}</div>}
    {dragging && <div className="jot-drop-hint">{t('Drop files into the note')}</div>}
    {!snapshot ? <div className="jot-loading" role="status">{t('Opening Jot…')}</div>
      : <main className="jot-layout">{mode === 'wide' ? <>
        {showList && listPanel}
        {showList && <div className="jot-resize-handle" role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label={t('Resize note list')} aria-valuemin={LIST_WIDTH.min} aria-valuemax={LIST_WIDTH.max} aria-valuenow={listWidth}
          onPointerDown={startResize} onDoubleClick={() => { setListWidth(LIST_WIDTH.initial); storage.set('hermes-jot:list-width:v1', null) }}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeWidth(-16 * inlineDirection) }
            else if (event.key === 'ArrowRight') { event.preventDefault(); nudgeWidth(16 * inlineDirection) }
          }} />}
        {editorPanel}</> : showList ? listPanel : editorPanel}</main>}
    {toast && <div className="jot-toast" role="status" aria-live="polite" key={toast.id}>
      <span>{toast.text}</span>
      {toast.action && <button className="jot-text-btn" type="button" onClick={() => { const run = toast.action!.run; setToast(null); run() }}>{toast.action.label}</button>}
      <button className="jot-toast-close" type="button" aria-label={t('Dismiss')} onClick={() => setToast(null)}><JotActionIcon name="close" size={14} /></button>
    </div>}
    {contextPosition && draft && <ActionMenu triggerLabel={t('Note menu')} items={menuItems} position={contextPosition} onClose={() => setContextPosition(null)} />}
    {captureOpen && <Modal size="small" title={t('Capture text')} closeLabel={t('Close')} onClose={() => { if (!busy) setCaptureOpen(false) }}>
      <CaptureDialog notes={snapshot?.notes ?? []} capturedText={captureText} source={captureSource} locale={locale} busy={busy} error={captureError}
        currentNoteId={draft && !selectedDeleted ? draft.noteId : null} onSubmit={capture} onClose={() => setCaptureOpen(false)} />
    </Modal>}
    {moveOpen && <Modal size="small" title={selectMode ? t('Move {count} notes', { count: selectedIds.size }) : t('Move note')} closeLabel={t('Close')} onClose={() => { if (!busy) setMoveOpen(false) }}>
      <label className="jot-dialog-field">{t('Destination folder')}<select className="jot-select" value={moveFolder} onChange={event => setMoveFolder(event.target.value)} aria-label={t('Destination folder')}>
        <option value="">{t('Unfiled')}</option>{snapshot?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select></label>
      <div className="jot-dialog-actions">
        <button type="button" className="jot-btn" disabled={busy} onClick={() => setMoveOpen(false)}>{t('Cancel')}</button>
        <button type="button" className="jot-btn jot-primary" disabled={busy} onClick={moveSelected}>{t('Move')}</button>
      </div>
    </Modal>}
    {purgeConfirm && <Modal size="small" title={purgeConfirm === 'trash' ? t('Empty Trash') : t('Delete permanently')}
      closeLabel={t('Close')} onClose={() => { if (!busy) setPurgeConfirm(null) }}>
      <p className="jot-dialog-text">{purgeConfirm === 'trash'
        ? t('Permanently delete {count} notes in Trash? This cannot be undone. Images and files used only by these notes are deleted too.', { count: trashCount })
        : t('Permanently delete this note? This cannot be undone. Images and files used only by this note are deleted too.')}</p>
      <div className="jot-dialog-actions">
        <button type="button" className="jot-btn" disabled={busy} onClick={() => setPurgeConfirm(null)}>{t('Cancel')}</button>
        <button type="button" className="jot-btn jot-danger-fill" disabled={busy} onClick={purgeConfirm === 'trash' ? emptyTrash : purgeSelected}>
          {purgeConfirm === 'trash' ? t('Empty Trash') : t('Delete permanently')}</button>
      </div>
    </Modal>}
    {exportOpen && <Modal size="small" title={t('Export notes')} closeLabel={t('Close')} onClose={() => { if (!busy) setExportOpen(false) }}>
      <ExportDialog locale={locale} scope={exportScope} count={exportable} busy={busy} error={exportError}
        initialFormat={(['docx', 'pdf', 'md'] as const).find(format => format === storage.get('hermes-jot:export-format:v1')) ?? 'docx'}
        onSubmit={format => void exportLibrary(format)} onClose={() => setExportOpen(false)} />
    </Modal>}
    {revertConfirm && draft && <Modal size="small" title={t('Undo AI edits')} closeLabel={t('Close')} onClose={() => { if (!busy) setRevertConfirm(false) }}>
      <p className="jot-dialog-text">{t('This note returns to how it was before AI edited it. Consecutive AI edits are undone together, and the AI version is not kept.')}</p>
      <div className="jot-dialog-actions">
        <button type="button" className="jot-btn" disabled={busy} onClick={() => setRevertConfirm(false)}>{t('Cancel')}</button>
        <button type="button" className="jot-btn jot-primary" disabled={busy || !agentUndoable} onClick={revertAgent}>{t('Undo edits')}</button>
      </div>
    </Modal>}
    {helpOpen && <Modal title={t('Keyboard shortcuts')} closeLabel={t('Close')} onClose={() => setHelpOpen(false)}>
      <ShortcutHelp locale={locale} />
    </Modal>}
    {attachmentPreview && <AttachmentPreview hostPreview={attachmentPreviewContent?.(attachmentPreview)} onDownload={api.downloadAttachment ? () => api.downloadAttachment!(attachmentPreview) : undefined} attachment={attachmentPreview} onClose={() => setAttachmentPreview(null)} locale={locale}
      getCapabilities={api.getAttachmentCapabilities} onOpenNative={api.openAttachment ? signal => api.openAttachment!(attachmentPreview.id, { signal }) : undefined} />}
  </div>
}

export default JotApp
