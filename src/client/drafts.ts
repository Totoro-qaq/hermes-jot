import type { Note, RichDoc } from './types.js'

export interface NoteDraft {
  noteId: string
  title: string
  content: RichDoc
  folderId: string | null
  pinned: boolean
  baseRevision: number
  dirty: boolean
  /** Distinct recovery variants prevent one mounted panel from erasing another. */
  draftId?: string
  editVersion?: number
}

const PREFIX = 'hermes-jot:draft:v1:'
interface StoredDraft extends NoteDraft { draftId: string; editVersion: number; updatedAt: number }
interface DraftBucket { version: 2; drafts: StoredDraft[] }
export interface DraftStorageBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
type EditableFields = Partial<Pick<NoteDraft, 'title' | 'content' | 'folderId' | 'pinned'>>
let idSequence = 0
const makeDraftId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID() : `draft-${Date.now()}-${++idSequence}`

export const emptyDocument = (): RichDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] })
export const draftFromNote = (note: Note): NoteDraft => ({
  noteId: note.id, title: note.title, content: note.content, folderId: note.folderId,
  pinned: note.pinned, baseRevision: note.revision, dirty: false,
})
export const draftFingerprint = (draft: NoteDraft): string => JSON.stringify([
  draft.title, draft.content, draft.folderId, draft.pinned,
])
export function sameDraftGeneration(left: NoteDraft | null | undefined, right: NoteDraft): boolean {
  return Boolean(left && left.noteId === right.noteId && left.draftId === right.draftId
    && left.editVersion === right.editVersion && left.baseRevision === right.baseRevision
    && draftFingerprint(left) === draftFingerprint(right))
}

/** Remote refreshes may advance a clean draft, but never replace unsaved work. */
export function reconcileDraft(draft: NoteDraft, note: Note): { draft: NoteDraft; remoteChanged: boolean } {
  if (!draft.dirty) return { draft: draftFromNote(note), remoteChanged: false }
  return { draft, remoteChanged: draft.baseRevision !== note.revision || note.deletedAt !== null }
}

/** A response to an older save advances the revision without swallowing newer keystrokes. */
export function acceptSavedDraft(current: NoteDraft, submitted: NoteDraft, note: Note): NoteDraft {
  // A different recovery branch is not typing that followed this submission.
  if (current.draftId !== submitted.draftId) return current
  return draftFingerprint(current) === draftFingerprint(submitted)
    ? draftFromNote(note)
    : { ...current, baseRevision: note.revision, dirty: true }
}

function validDraft(value: unknown, noteId: string): value is NoteDraft {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<NoteDraft>
  return item.noteId === noteId && typeof item.title === 'string' && item.content?.type === 'doc'
    && typeof item.baseRevision === 'number' && item.dirty === true
    && (item.folderId === null || typeof item.folderId === 'string') && typeof item.pinned === 'boolean'
}

/** Shared recovery storage. Only an acknowledged matching save can remove a draft. */
export class DraftStorage {
  private readonly memory = new Map<string, DraftBucket>()
  private readonly volatile = new Set<string>()
  constructor(private readonly backend?: DraftStorageBackend) {}

  private storage(): DraftStorageBackend | undefined {
    if (this.backend) return this.backend
    try { return typeof localStorage === 'undefined' ? undefined : localStorage }
    catch { return undefined }
  }

  all(noteId: string): StoredDraft[] {
    let bucket = this.memory.get(noteId)
    try {
      const raw = this.storage()?.getItem(`${PREFIX}${noteId}`)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 2 && 'drafts' in parsed && Array.isArray(parsed.drafts)) {
          bucket = { version: 2, drafts: parsed.drafts.filter(value => validDraft(value, noteId)
            && typeof value.draftId === 'string' && typeof value.editVersion === 'number' && 'updatedAt' in value && typeof value.updatedAt === 'number') as StoredDraft[] }
        } else if (validDraft(parsed, noteId)) {
          // Preserve recovery data written by the initial client version.
          bucket = { version: 2, drafts: [{ ...parsed, draftId: parsed.draftId ?? `legacy-${noteId}`, editVersion: parsed.editVersion ?? 1, updatedAt: 0 }] }
        }
      } else if (this.storage() && !this.volatile.has(noteId)) bucket = { version: 2, drafts: [] }
    } catch { /* The in-memory bucket remains available if browser storage fails. */ }
    if (bucket) this.memory.set(noteId, bucket)
    return [...(bucket?.drafts ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private write(noteId: string, items: StoredDraft[]): void {
    const bucket: DraftBucket = { version: 2, drafts: items }
    this.memory.set(noteId, bucket)
    try {
      if (items.length) this.storage()?.setItem(`${PREFIX}${noteId}`, JSON.stringify(bucket))
      else this.storage()?.removeItem(`${PREFIX}${noteId}`)
      this.volatile.delete(noteId)
    } catch { this.volatile.add(noteId) }
  }

  read(note: Note, preferred?: NoteDraft): NoteDraft {
    const items = this.all(note.id)
    if (preferred?.dirty) {
      const same = items.find(item => item.draftId === preferred.draftId)
      if (same && same.editVersion === preferred.editVersion && draftFingerprint(same) === draftFingerprint(preferred)) return same
      // A live dirty editor is itself a recovery source; a stale clean cache is not.
      return this.persist(preferred)
    }
    return items[0] ?? draftFromNote(note)
  }

  edit(current: NoteDraft, patch: EditableFields): NoteDraft {
    const existing = this.all(current.noteId).find(item => item.draftId === current.draftId)
    const diverged = existing && (draftFingerprint(existing) !== draftFingerprint(current) || existing.baseRevision !== current.baseRevision)
    return {
      ...current, ...patch, dirty: true,
      draftId: diverged || !current.draftId ? makeDraftId() : current.draftId,
      editVersion: diverged ? 1 : Math.max(current.editVersion ?? 0, existing?.editVersion ?? 0) + 1,
    }
  }

  persist(draft: NoteDraft): NoteDraft {
    // A clean poll/refresh cannot make any statement about another panel's work.
    if (!draft.dirty) return draft
    const items = this.all(draft.noteId)
    const existing = items.find(item => item.draftId === draft.draftId)
    if (existing && existing.editVersion >= (draft.editVersion ?? 0) && existing.baseRevision === draft.baseRevision
      && draftFingerprint(existing) === draftFingerprint(draft)) return existing
    const collision = existing && (existing.editVersion >= (draft.editVersion ?? 0))
      && (draftFingerprint(existing) !== draftFingerprint(draft) || existing.baseRevision !== draft.baseRevision)
    const next: StoredDraft = {
      ...draft, draftId: !draft.draftId || collision ? makeDraftId() : draft.draftId,
      editVersion: collision ? 1 : draft.editVersion ?? 1,
      updatedAt: Math.max(Date.now(), ...items.map(item => item.updatedAt + 1)),
    }
    this.write(draft.noteId, [...items.filter(item => item.draftId !== next.draftId), next])
    return next
  }

  /** Exact identity/version/content match; later edits and sibling variants survive. */
  discard(draft: NoteDraft): void {
    if (!draft.draftId) return
    const items = this.all(draft.noteId)
    this.write(draft.noteId, items.filter(item => !(item.draftId === draft.draftId
      && item.editVersion === draft.editVersion && item.baseRevision === draft.baseRevision
      && draftFingerprint(item) === draftFingerprint(draft))))
  }

  saved(current: NoteDraft, submitted: NoteDraft, note: Note): NoteDraft {
    this.discard(submitted)
    if (current.draftId !== submitted.draftId) return this.persist(current)
    const next = acceptSavedDraft(current, submitted, note)
    if (!next.dirty) this.discard(current)
    else {
      // Advancing the revision is also a new draft generation. An older pending
      // response must never match and remove it afterward.
      next.editVersion = (current.editVersion ?? 0) + 1
    }
    return this.persist(next)
  }
}

/** Async load-latest completion may act only on the generation that was clicked. */
export function receiveLatestDraft(
  requested: NoteDraft, current: NoteDraft | null, latest: Note, storage: DraftStorage,
): { draft: NoteDraft | null; replaced: boolean } {
  if (latest.id !== requested.noteId) return { draft: current, replaced: false }
  storage.discard(requested)
  if (!sameDraftGeneration(current, requested)) return { draft: current, replaced: false }
  return { draft: draftFromNote(latest), replaced: true }
}

export const sharedDraftStorage = new DraftStorage()
export const readDraft = (note: Note, preferred?: NoteDraft): NoteDraft => sharedDraftStorage.read(note, preferred)
export const persistDraft = (draft: NoteDraft): NoteDraft => sharedDraftStorage.persist(draft)
export const editDraft = (draft: NoteDraft, patch: EditableFields): NoteDraft => sharedDraftStorage.edit(draft, patch)
export const savedDraft = (current: NoteDraft, submitted: NoteDraft, note: Note): NoteDraft => sharedDraftStorage.saved(current, submitted, note)
export const discardDraft = (draft: NoteDraft): void => sharedDraftStorage.discard(draft)
export const recoveryDrafts = (noteId: string): NoteDraft[] => sharedDraftStorage.all(noteId)
