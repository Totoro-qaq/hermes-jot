import { editDraft, type NoteDraft } from './drafts.js'
import { sameEditorDocument } from '../rich-equal.js'
import type { Note, RichDoc } from './types.js'

const documentIsBlank = (doc: RichDoc) => doc.content?.length === 1
  && doc.content[0]!.type === 'paragraph' && !doc.content[0]!.content?.length

type DraftPatch = Partial<Pick<NoteDraft, 'title' | 'content' | 'folderId' | 'pinned'>>

/**
 * 切换之后才到的正文写回那篇草稿。
 * 这篇正在冲突时也留下文字，但不因此自动保存盖过冲突。
 */
export function parkedEditorChange(parked: NoteDraft | undefined, content: RichDoc, conflicted: boolean): 'unchanged' | 'save' | 'keep-conflict' {
  if (!parked || sameEditorDocument(parked.content, content)) return 'unchanged'
  return conflicted ? 'keep-conflict' : 'save'
}

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
