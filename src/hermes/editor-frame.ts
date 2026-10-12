import type { RichDoc } from '../client/types.js'
import { sameEditorDocument } from '../rich-equal.js'
import { EditorSync } from './editor-sync.js'

/** 访客和宿主一起发。对不上就丢掉编辑，并记一条调试日志。 */
export const EDITOR_FRAME_PROTOCOL = 1

/** 宿主把一篇笔记交给编辑器时的标记。在途消息必须带上当时的笔记和代次。 */
export interface EditorFrameStamp { documentId: string; generation: number }

let lastGeneration = 0

/**
 * 换笔记或 iframe 重开时领一个新代次。代次在整个页面里只增不减，
 * 重开的编辑器从 1 数修订号，也不会被上一轮记下的更大修订号挡住。
 */
export function nextEditorFrame(documentId: string): EditorFrameStamp {
  return { documentId, generation: ++lastGeneration }
}

/** 一篇笔记已经收下的最新代次和修订号。 */
export interface EditorRevision { generation: number; revision: number }

/** 旧代次的回声，或同一代次里更小的修订号，都不能盖掉已经收下的编辑。 */
export function acceptEditorRevision(known: EditorRevision | undefined, incoming: EditorRevision): boolean {
  if (!known || incoming.generation > known.generation) return true
  return incoming.generation === known.generation && incoming.revision >= known.revision
}

/** 回给访客的确认修订号。只有同一代次的才算数，旧代次的数字不能拿来比。 */
export function acknowledgedRevision(known: EditorRevision | undefined, stamp: EditorFrameStamp): number {
  return known?.generation === stamp.generation ? known.revision : 0
}

/** 快速连切时要记住的代次。再旧的在途编辑不再收下。 */
const RECENT_EDITOR_STAMPS = 32

/** 离开一篇笔记时把它的代次留在名单里。 */
export function rememberEditorStamp(recent: readonly EditorFrameStamp[], stamp: EditorFrameStamp): EditorFrameStamp[] {
  if (recent.some(item => item.generation === stamp.generation)) return [...recent]
  return [...recent, stamp].slice(-RECENT_EDITOR_STAMPS)
}

export type GuestEditorAction =
  | { type: 'change'; content: RichDoc; revision: number; documentId: string; generation: number }
  | { type: 'selection'; text: string }
  | { type: 'flushed'; documentId: string; generation: number }
  | { type: 'drop'; reason: 'protocol' | 'stamp' | 'shape' }
  | { type: 'unhandled' }

/**
 * 换笔记后，旧选区不能写进当前草稿。
 * 最近几篇的 change 和 flushed 仍按它自己的笔记和代次收下，连着切到第三篇或切回去也不会丢掉最后一次按键。
 * 其它消息仍由宿主自己处理。
 */
export function guestEditorAction(current: EditorFrameStamp | null, kind: string, data: unknown, recent: readonly EditorFrameStamp[] = []): GuestEditorAction {
  if (kind !== 'change' && kind !== 'selection' && kind !== 'flushed') return { type: 'unhandled' }
  if (!data || typeof data !== 'object') return { type: 'drop', reason: 'shape' }
  const record = data as { protocol?: unknown; text?: unknown; content?: unknown; revision?: unknown; documentId?: unknown; generation?: unknown }
  if (Object.hasOwn(record, 'protocol') && record.protocol !== EDITOR_FRAME_PROTOCOL) return { type: 'drop', reason: 'protocol' }
  const matches = (stamp: EditorFrameStamp | null) => stamp !== null && record.documentId === stamp.documentId && record.generation === stamp.generation
  const isCurrent = matches(current)
  if (!isCurrent && !recent.some(matches)) return { type: 'drop', reason: 'stamp' }
  const documentId = record.documentId as string
  const generation = record.generation as number
  if (kind === 'selection') {
    if (!isCurrent) return { type: 'drop', reason: 'stamp' }
    return typeof record.text === 'string' ? { type: 'selection', text: record.text } : { type: 'drop', reason: 'shape' }
  }
  if (kind === 'flushed') return { type: 'flushed', documentId, generation }
  const content = record.content as { type?: unknown } | null | undefined
  if (!content || typeof content !== 'object' || content.type !== 'doc' || !Number.isSafeInteger(record.revision)) return { type: 'drop', reason: 'shape' }
  return { type: 'change', content: content as RichDoc, revision: record.revision as number, documentId, generation }
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
  documentId: string
  generation: number
  content: RichDoc
  revision: number
}

export interface MountedEditorSession {
  readonly documentId: string
  readonly generation: number
  change(content: RichDoc): MountedEditorChange
  /** 正文和上次记下的一样就返回 null，切换时不把没改过的笔记再存一遍。 */
  pendingChange(content: RichDoc): MountedEditorChange | null
  selection(text: string): { protocol: number; documentId: string; generation: number; text: string }
  hostUpdate(value: RichDoc, acknowledged: number): RichDoc
}

export function mountEditorSession({ documentId, generation }: EditorFrameStamp, value: RichDoc): MountedEditorSession {
  const sync = new EditorSync()
  const stamp = { protocol: EDITOR_FRAME_PROTOCOL, documentId, generation }
  let known = value
  const change = (content: RichDoc): MountedEditorChange => {
    known = content
    return { ...stamp, ...sync.edited(content) }
  }
  return {
    documentId,
    generation,
    change,
    pendingChange: content => sameEditorDocument(content, known) ? null : change(content),
    selection: text => ({ ...stamp, text }),
    hostUpdate(next, acknowledged) {
      known = sync.prepareHostUpdate(next, acknowledged)()
      return known
    },
  }
}
