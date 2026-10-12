import type { RichDoc } from '../client/types.js'

/** 同一 iframe 换笔记时递增。在途消息必须带上当时的笔记和代次。 */
export interface EditorFrameStamp { documentId: string; generation: number }

export function initialEditorFrame(documentId = ''): EditorFrameStamp {
  return { documentId, generation: 0 }
}

/** 笔记没变就沿用同一个对象，避免无意义地作废在途编辑。 */
export function advanceEditorFrame(current: EditorFrameStamp, documentId: string): EditorFrameStamp {
  if (current.documentId === documentId) return current
  return { documentId, generation: current.generation + 1 }
}

export type GuestEditorAction =
  | { type: 'change'; content: RichDoc; revision: number }
  | { type: 'selection'; text: string }
  | { type: 'drop' }
  | { type: 'unhandled' }

function stampMatches(current: EditorFrameStamp, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const record = data as { documentId?: unknown; generation?: unknown }
  return record.documentId === current.documentId
    && record.generation === current.generation
    && Number.isSafeInteger(current.generation)
}

/**
 * 换笔记后，上一篇还在飞的 change / selection 不能写进当前草稿。
 * 其它消息仍由宿主自己处理。
 */
export function guestEditorAction(current: EditorFrameStamp, kind: string, data: unknown): GuestEditorAction {
  if (kind !== 'change' && kind !== 'selection') return { type: 'unhandled' }
  if (!stampMatches(current, data)) return { type: 'drop' }
  const record = data as { text?: unknown; content?: unknown; revision?: unknown }
  if (kind === 'selection') return typeof record.text === 'string' ? { type: 'selection', text: record.text } : { type: 'drop' }
  if (!record.content || typeof record.content !== 'object' || (record.content as { type?: unknown }).type !== 'doc' || !Number.isSafeInteger(record.revision)) {
    return { type: 'drop' }
  }
  return { type: 'change', content: record.content as RichDoc, revision: record.revision as number }
}
