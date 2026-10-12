import type { RichDoc } from '../client/types.js'
import { EditorSync } from './editor-sync.js'

/** 访客和宿主一起发。对不上就丢掉编辑，并记一条调试日志。 */
export const EDITOR_FRAME_PROTOCOL = 1

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
  | { type: 'change'; content: RichDoc; revision: number; documentId: string }
  | { type: 'selection'; text: string }
  | { type: 'drop'; reason: 'protocol' | 'stamp' | 'shape' }
  | { type: 'unhandled' }

function stampMatches(current: EditorFrameStamp, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const record = data as { documentId?: unknown; generation?: unknown }
  return record.documentId === current.documentId
    && record.generation === current.generation
    && Number.isSafeInteger(current.generation)
}

function protocolMismatch(data: unknown): boolean {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'protocol')) return false
  return (data as { protocol?: unknown }).protocol !== EDITOR_FRAME_PROTOCOL
}

/**
 * 换笔记后，上一篇还在飞的选区不能写进当前草稿。
 * 刚刚离开的那一篇的 change 仍然收下，交给宿主写回那篇笔记，而不是丢掉最后一次按键。
 * 其它消息仍由宿主自己处理。
 */
export function guestEditorAction(current: EditorFrameStamp, kind: string, data: unknown, previous?: EditorFrameStamp | null): GuestEditorAction {
  if (kind !== 'change' && kind !== 'selection') return { type: 'unhandled' }
  if (!data || typeof data !== 'object') return { type: 'drop', reason: 'shape' }
  if (protocolMismatch(data)) return { type: 'drop', reason: 'protocol' }
  const matchesCurrent = stampMatches(current, data)
  const matchesPrevious = Boolean(previous && stampMatches(previous, data))
  if (!matchesCurrent && !matchesPrevious) return { type: 'drop', reason: 'stamp' }
  const record = data as { text?: unknown; content?: unknown; revision?: unknown; documentId?: unknown }
  if (kind === 'selection') {
    if (!matchesCurrent || typeof record.text !== 'string') return { type: 'drop', reason: matchesCurrent ? 'shape' : 'stamp' }
    return { type: 'selection', text: record.text }
  }
  if (typeof record.documentId !== 'string' || !record.content || typeof record.content !== 'object' || (record.content as { type?: unknown }).type !== 'doc' || !Number.isSafeInteger(record.revision)) {
    return { type: 'drop', reason: 'shape' }
  }
  return { type: 'change', content: record.content as RichDoc, revision: record.revision as number, documentId: record.documentId }
}

/** 协议或代次对不上、因而丢掉一次编辑时记下来。正常切换不会刷屏。 */
export function reportDroppedEdit(reason: 'protocol' | 'stamp' | 'shape', data: unknown): void {
  const record = data && typeof data === 'object' ? data as { documentId?: unknown; generation?: unknown; protocol?: unknown } : {}
  console.debug('jot editor dropped a change', { reason, documentId: record.documentId, generation: record.generation, protocol: record.protocol })
}

/**
 * 一篇笔记的编辑器实例在挂载时记下笔记和代次。
 * 之后就算外层的 frame 已经换成下一篇，这次编辑和它的宿主回声仍属于这篇。
 */
export interface MountedEditorChange {
  protocol: number
  content: RichDoc
  revision: number
  documentId: string
  generation: number
}

export interface MountedEditorSession {
  readonly documentId: string
  readonly generation: number
  change(content: RichDoc): MountedEditorChange
  /** 正文和上次记下的一样就返回 null，切换时不把没改过的笔记再存一遍。 */
  pendingChange(content: RichDoc): MountedEditorChange | null
  selection(text: string): { protocol: number; text: string; documentId: string; generation: number }
  hostUpdate(value: RichDoc, acknowledged: number): RichDoc
}

export function mountEditorSession(stamp: EditorFrameStamp, value: RichDoc, _acknowledged: number): MountedEditorSession {
  const documentId = stamp.documentId
  const generation = stamp.generation
  const sync = new EditorSync()
  sync.beginDocument(documentId)
  let known = JSON.stringify(value)
  const change = (content: RichDoc): MountedEditorChange => {
    known = JSON.stringify(content)
    return { protocol: EDITOR_FRAME_PROTOCOL, ...sync.edited(content), documentId, generation }
  }
  return {
    documentId,
    generation,
    change,
    pendingChange(content) {
      if (JSON.stringify(content) === known) return null
      return change(content)
    },
    selection(text) {
      return { protocol: EDITOR_FRAME_PROTOCOL, text, documentId, generation }
    },
    hostUpdate(next, acknowledgedRevision) {
      const resolved = sync.prepareHostUpdate(next, acknowledgedRevision)()
      known = JSON.stringify(resolved)
      return resolved
    },
  }
}
