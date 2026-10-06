import { draftFromNote, sharedDraftStorage, type DraftStorage, type NoteDraft } from './drafts.js'
import type { Note } from './types.js'

/** Navigation revision is independent of the note's persistence revision. */
export interface NoteOpenRequest { noteId: string | null; revision: number; draftId?: string; noteRevision?: number }

/** One controller per plugin activation; pending requests survive Wide's first mount. */
export function createNoteHandoff(openWide: () => void = () => {}) {
  let snapshot: NoteOpenRequest = { noteId: null, revision: 0 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: (noteId?: string, draftId?: string, noteRevision?: number) => {
      snapshot = { noteId: noteId ?? null, revision: snapshot.revision + 1,
        ...(draftId ? { draftId } : {}), ...(noteId && noteRevision ? { noteRevision } : {}) }
      for (const listener of listeners) listener()
      // Publish before the native layout can mount the full page.
      openWide()
    },
    acknowledge: (revision: number) => {
      if (snapshot.revision !== revision || snapshot.noteId === null) return
      snapshot = { noteId: null, revision }
      for (const listener of listeners) listener()
    },
  }
}

/** Consume only after data arrives, and never reselect on subsequent server polls. */
export class NoteOpenConsumer {
  private handled = 0
  constructor(private readonly storage: DraftStorage = sharedDraftStorage) {}
  isPending(request: NoteOpenRequest): boolean {
    return request.noteId !== null && request.revision > this.handled
  }
  consume(request: NoteOpenRequest | undefined, notes: readonly Note[] | null, options: { fresh?: boolean } = {}): Note | undefined {
    if (!request || request.revision <= this.handled) return undefined
    if (request.noteId === null) { this.handled = request.revision; return undefined }
    const note = notes?.find(item => item.id === request.noteId)
    if (!note) return undefined
    const source = request.draftId ? this.storage.all(note.id).find(item => item.draftId === request.draftId) : undefined
    // A save may acknowledge after navigation was published and remove this
    // branch. Read the server after observing that absence before using a cache.
    if (request.draftId && !source && !options.fresh) return undefined
    // Wide may still hold an older poll snapshot than Compact's last save.
    // Wait for that revision before reconciling, rather than creating a false conflict.
    if (note.revision < Math.max(request.noteRevision ?? 0, source?.baseRevision ?? 0)) return undefined
    this.handled = request.revision
    return note
  }
}

/** An explicit branch from Compact wins over Wide's older cached branch. */
export function readHandoffDraft(note: Note, draftId?: string, storage: DraftStorage = sharedDraftStorage): NoteDraft {
  if (draftId) {
    const source = storage.all(note.id).find(item => item.draftId === draftId)
    // An acknowledged save can remove the requested branch while Wide loads.
    // That is not permission to select a different, unrelated recovery variant.
    return source ?? draftFromNote(note)
  }
  return storage.read(note)
}
