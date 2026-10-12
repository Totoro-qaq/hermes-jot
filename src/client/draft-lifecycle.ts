import { draftFromNote, editDraft, type NoteDraft } from './drafts.js'
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

/**
 * 晚到的 flush 只结算离开那一刻的代次。
 * 笔记已经重新打开时不删，哪怕代次碰巧一样。
 */
export function freshFlushSettlement(
  openNoteId: string | null,
  pendingGeneration: number | undefined,
  flush: { noteId: string; generation: number },
): 'ignore' | 'settle' {
  return flush.noteId !== openNoteId && pendingGeneration === flush.generation ? 'settle' : 'ignore'
}

/**
 * 晚到的正文到达时草稿可能已经被清掉。
 * 还在等这篇的 flush 时，用库里的笔记把草稿重新建出来。
 */
export function parkedDraftForLateEdit(parked: NoteDraft | undefined, note: Note | undefined, waiting: boolean): NoteDraft | undefined {
  if (parked) return parked
  if (waiting && note && !note.deletedAt) return draftFromNote(note)
  return undefined
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
