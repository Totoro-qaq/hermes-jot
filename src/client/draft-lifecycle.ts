import { editDraft, type NoteDraft } from './drafts.js'
import type { Note, RichDoc } from './types.js'

const documentIsBlank = (doc: RichDoc) => doc.content?.length === 1
  && doc.content[0]!.type === 'paragraph' && !doc.content[0]!.content?.length

type DraftPatch = Partial<Pick<NoteDraft, 'title' | 'content' | 'folderId' | 'pinned'>>

/** Any intentional edit, including metadata, ends automatic empty-note cleanup. */
export function editHumanDraft(current: NoteDraft, patch: DraftPatch, fresh: Set<string>): NoteDraft {
  const next = editDraft(current, patch)
  fresh.delete(current.noteId)
  return next
}

/** Consume cleanup eligibility once; saved or recoverable user changes always win. */
export function takeUntouchedFreshNote(id: string, fresh: Set<string>, state: {
  note?: Note; draft?: NoteDraft; saving: boolean; keptDrafts: boolean
}): boolean {
  if (!fresh.delete(id)) return false
  const { note, draft, saving, keptDrafts } = state
  return Boolean(note && !note.deletedAt && !note.pinned && !note.title.trim() && documentIsBlank(note.content)
    && !saving && !keptDrafts && (!draft || !draft.dirty && !draft.title.trim() && documentIsBlank(draft.content)))
}
