import { appendBlocks, type RichNode as SavedNode } from '../model.js'
import type { NoteDraft } from './drafts.js'
import type { Note, RichDoc, RichNode } from './types.js'

/** The saved server version a local draft started from. */
export interface RemoteBase { revision: number; title: string; content: RichDoc; folderId: string | null; pinned: boolean }

export const remoteBase = (note: Note): RemoteBase => ({
  revision: note.revision, title: note.title, content: note.content, folderId: note.folderId, pinned: note.pinned,
})

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

/** Structural equality of saved JSON; key order and undefined-valued keys do not matter. */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const keys = (value: object) => Object.entries(value).filter(([, item]) => item !== undefined).map(([key]) => key)
  const leftKeys = keys(left)
  return leftKeys.length === keys(right).length && leftKeys.every(key => Object.hasOwn(right, key)
    && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

/**
 * The blocks an `appendBlocks` call added to `base` to produce `remote`:
 * null when the change was anything else, [] when the content is unchanged.
 */
export function appendedBlocks(base: RichDoc, remote: RichDoc): RichNode[] | null {
  const before = base.content ?? []
  const after = remote.content ?? []
  if (sameJson(before, after)) return []
  const candidates: RichNode[][] = []
  const blank = before.length === 1 && emptyParagraph(before[0])
  // An editor-kept empty paragraph after a final list or table is not content; appendBlocks keeps it last.
  const trailing = before.length > 1 && emptyParagraph(before.at(-1)) && before.at(-2)!.type !== 'paragraph' && emptyParagraph(after.at(-1))
  const head = trailing ? before.slice(0, -1) : before
  const tail = trailing ? after.slice(0, -1) : after
  if (blank) candidates.push(after)
  else if (head.length && tail.length >= head.length && head.slice(0, -1).every((node, index) => sameJson(node, tail[index]))) {
    const last = head.at(-1)!
    const joined = tail[head.length - 1]!
    const rest = tail.slice(head.length)
    if (sameJson(last, joined)) candidates.push(rest)
    const items = last.content ?? []
    if (LIST_TYPES.has(last.type) && joined.type === last.type && (joined.content?.length ?? 0) > items.length) {
      candidates.push([{ type: last.type, content: joined.content!.slice(items.length) }, ...rest])
    }
  }
  // Replaying the server's own append rule is the proof; anything it cannot reproduce is not an append.
  return candidates.find(blocks => blocks.length > 0 && sameJson(appendBlocks(before as SavedNode[], blocks as SavedNode[]), after)) ?? null
}
const emptyParagraph = (node: RichNode | undefined): boolean => node?.type === 'paragraph' && !node.content?.length

export type RemoteAppendPlan =
  | { action: 'merge'; blocks: RichNode[] }
  /** A merge for this note is already waiting on the editor; it is evaluated again when it settles. */
  | { action: 'pending' }
  /** Not an append the editor can take: keep the draft and surface the conflict as before. */
  | { action: 'conflict' }

/** Whether a newer saved version can be merged into the open, unsaved draft by appending blocks. */
export function planRemoteAppend(input: {
  draft: NoteDraft | null | undefined
  base: RemoteBase | undefined
  remote: Note
  /** The editor showing this note confirmed it can apply edits. */
  editorReady: boolean
  /** A save of this draft is in flight; its own result must never be merged back in. */
  saving: boolean
  pending: boolean
  /** The revision the library attributes to the agent's latest edit of this note, if any. */
  agentRevision?: number
  /** A merge sent to the editor that was never confirmed; the editor may already hold its blocks. */
  unconfirmed?: { baseRevision: number; revision: number }
}): RemoteAppendPlan {
  const { draft, base, remote } = input
  if (!draft || draft.noteId !== remote.id || !draft.dirty) return { action: 'conflict' }
  if (input.pending) return { action: 'pending' }
  if (input.saving || remote.deletedAt !== null || remote.revision <= draft.baseRevision) return { action: 'conflict' }
  // Only a single agent revision on top of the base is known to be the agent's writing; an
  // append-only change from another Jot pane or a lost save response is the user's own text.
  if (input.agentRevision !== remote.revision || remote.revision !== draft.baseRevision + 1) return { action: 'conflict' }
  const { unconfirmed } = input
  if (unconfirmed && unconfirmed.baseRevision === draft.baseRevision && remote.revision >= unconfirmed.revision) return { action: 'conflict' }
  if (!base || base.revision !== draft.baseRevision || base.title !== remote.title
    || base.folderId !== remote.folderId || base.pinned !== remote.pinned) return { action: 'conflict' }
  const blocks = appendedBlocks(base.content, remote.content)
  if (!blocks?.length || !input.editorReady) return { action: 'conflict' }
  // The draft already holds the remote version, for example when another pane saved this
  // same draft; appending again would duplicate that writing.
  if (appendedBlocks(remote.content, draft.content) !== null) return { action: 'conflict' }
  return { action: 'merge', blocks }
}

/**
 * After the editor confirmed the append, the open draft now contains the remote
 * blocks and may be saved on top of the remote revision. Anything that moved the
 * draft meanwhile (another note, a reload, a save) returns null.
 */
export function acceptRemoteAppend(current: NoteDraft | null | undefined, started: NoteDraft, remote: Note): NoteDraft | null {
  if (!current || current.noteId !== remote.id || current.noteId !== started.noteId || !current.dirty
    || current.baseRevision !== started.baseRevision || remote.revision <= current.baseRevision) return null
  // A new edit version keeps shared recovery storage from treating this as a sibling draft.
  return { ...current, baseRevision: remote.revision, editVersion: (current.editVersion ?? 0) + 1 }
}
