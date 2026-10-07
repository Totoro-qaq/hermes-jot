import { validateRichDoc } from '../model.js'
import { JotApiError } from './api.js'
import type { NoteDraft } from './drafts.js'
import type { JotApi, Note } from './types.js'

/** Two visible panes may save the same handed-off draft at once. */
export async function saveHumanDraft(api: Pick<JotApi, 'updateNote' | 'getNote'>, draft: NoteDraft): Promise<Note> {
  try {
    return await api.updateNote(draft.noteId, { revision: draft.baseRevision, title: draft.title,
      content: draft.content, folderId: draft.folderId, pinned: draft.pinned })
  } catch (error) {
    if (!(error instanceof JotApiError) || error.code !== 'REVISION_CONFLICT') throw error
    const latest = await api.getNote(draft.noteId)
    // Acknowledge an identical committed value; never retry or merge over a
    // different edit. Canonicalization only reconciles schema defaults/order.
    if (latest.id === draft.noteId && latest.revision > draft.baseRevision && !latest.deletedAt
      && latest.title === draft.title && latest.folderId === draft.folderId && latest.pinned === draft.pinned
      && JSON.stringify(validateRichDoc(latest.content)) === JSON.stringify(validateRichDoc(draft.content))) return latest
    throw error
  }
}
