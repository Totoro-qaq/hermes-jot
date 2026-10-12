import type { RichDoc } from '../client/types.js'
import { sameEditorDocument } from '../rich-equal.js'
import { EditorSync } from './editor-sync.js'

/** 访客和宿主一起发。对不上就丢掉编辑，并记一条调试日志。 */
export const EDITOR_FRAME_PROTOCOL = 1

/** 同一 iframe 换笔记时递增。在途消息必须带上当时的笔记、挂载和代次。 */
export interface EditorFrameStamp { documentId: string; generation: number; mount: number }

export function initialEditorFrame(documentId = '', mount = 0): EditorFrameStamp {
  return { documentId, generation: 0, mount }
}

/** 每一次编辑器挂载拿一个更大的编号。iframe 拆掉重开后从 0 计代次，也不会和上一轮撞车。 */
export function claimEditorMount(previous: number): number {
  if (!Number.isSafeInteger(previous) || previous < 0) return 1
  return previous + 1
}

/** 笔记没变就沿用同一个对象，避免无意义地作废在途编辑。挂载编号保持不变。 */
export function advanceEditorFrame(current: EditorFrameStamp, documentId: string): EditorFrameStamp {
  if (current.documentId === documentId) return current
  return { documentId, generation: current.generation + 1, mount: current.mount }
}

export type GuestEditorAction =
  | { type: 'change'; content: RichDoc; revision: number; documentId: string; generation: number; mount: number }
  | { type: 'selection'; text: string }
  | { type: 'flushed'; documentId: string; generation: number; mount: number }
  | { type: 'drop'; reason: 'protocol' | 'stamp' | 'shape' }
  | { type: 'unhandled' }

/** 一篇笔记已经发出去的最新挂载、代次和它自己的修订号。旧挂载或旧代次不能再盖回来。 */
export interface EditorGenerationRevision { mount: number; generation: number; revision: number }

function mountNumber(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : 0
}

/**
 * 修订号按笔记、挂载和代次一起记。
 * 新挂载的代次可以从 0 再计，仍然收下。同一挂载里，新代次一旦发过编辑，更旧代次的回声一律丢掉。
 * `floorMount` 是宿主已经见过的最新挂载。更旧挂载的回声在第一条新编辑到来之前也要丢掉。
 */
export function acceptEditorRevision(
  known: EditorGenerationRevision | undefined,
  incoming: { mount?: number; generation: number; revision: number },
  floorMount = 0,
): { accept: boolean; next: EditorGenerationRevision } {
  const mount = mountNumber(incoming.mount)
  const floor = mountNumber(floorMount)
  const empty = known ?? { mount: floor, generation: 0, revision: 0 }
  if (!Number.isSafeInteger(incoming.generation) || !Number.isSafeInteger(incoming.revision) || incoming.generation < 0 || incoming.revision < 0 || mount < floor) {
    return { accept: false, next: empty }
  }
  if (!known || mount > known.mount) return { accept: true, next: { mount, generation: incoming.generation, revision: incoming.revision } }
  if (incoming.generation < known.generation || (incoming.generation === known.generation && incoming.revision < known.revision)) {
    return { accept: false, next: known }
  }
  return { accept: true, next: { mount: known.mount, generation: incoming.generation, revision: incoming.revision } }
}

function stampMatches(current: EditorFrameStamp, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const record = data as { documentId?: unknown; generation?: unknown; mount?: unknown }
  const mount = typeof record.mount === 'number' ? record.mount : 0
  return record.documentId === current.documentId
    && record.generation === current.generation
    && mount === (current.mount ?? 0)
    && Number.isSafeInteger(current.generation)
}

function protocolMismatch(data: unknown): boolean {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'protocol')) return false
  return (data as { protocol?: unknown }).protocol !== EDITOR_FRAME_PROTOCOL
}

/** 快速连切时要记住的代次。再旧的在途编辑不再收下。 */
const RECENT_EDITOR_STAMPS = 32

/** 离开一篇笔记时把它的代次留在名单里。同一代次不重复记。 */
export function rememberEditorStamp(recent: readonly EditorFrameStamp[], stamp: EditorFrameStamp): EditorFrameStamp[] {
  if (recent.some(item => item.documentId === stamp.documentId && item.generation === stamp.generation && (item.mount ?? 0) === (stamp.mount ?? 0))) return [...recent]
  const next = [...recent, stamp]
  return next.length > RECENT_EDITOR_STAMPS ? next.slice(next.length - RECENT_EDITOR_STAMPS) : next
}

/**
 * 换笔记后，旧选区不能写进当前草稿。
 * 最近几篇的 change 仍按它自己的笔记和代次收下，连着切到第三篇或切回去也不会丢掉最后一次按键。
 * 其它消息仍由宿主自己处理。
 */
export function guestEditorAction(current: EditorFrameStamp, kind: string, data: unknown, recent?: readonly EditorFrameStamp[] | null): GuestEditorAction {
  if (kind !== 'change' && kind !== 'selection' && kind !== 'flushed') return { type: 'unhandled' }
  if (!data || typeof data !== 'object') return { type: 'drop', reason: 'shape' }
  if (protocolMismatch(data)) return { type: 'drop', reason: 'protocol' }
  const matchesCurrent = stampMatches(current, data)
  const matchesRecent = Boolean(recent?.some(stamp => stampMatches(stamp, data)))
  if (!matchesCurrent && !matchesRecent) return { type: 'drop', reason: 'stamp' }
  const record = data as { text?: unknown; content?: unknown; revision?: unknown; documentId?: unknown; generation?: unknown; mount?: unknown }
  if (kind === 'selection') {
    if (!matchesCurrent || typeof record.text !== 'string') return { type: 'drop', reason: matchesCurrent ? 'shape' : 'stamp' }
    return { type: 'selection', text: record.text }
  }
  if (typeof record.documentId !== 'string' || typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation)) return { type: 'drop', reason: 'shape' }
  const mount = typeof record.mount === 'number' && Number.isSafeInteger(record.mount) ? record.mount : 0
  if (kind === 'flushed') return { type: 'flushed', documentId: record.documentId, generation: record.generation, mount }
  if (!record.content || typeof record.content !== 'object' || (record.content as { type?: unknown }).type !== 'doc' || !Number.isSafeInteger(record.revision)) {
    return { type: 'drop', reason: 'shape' }
  }
  return { type: 'change', content: record.content as RichDoc, revision: record.revision as number, documentId: record.documentId, generation: record.generation, mount }
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
  mount: number
}

export interface MountedEditorSession {
  readonly documentId: string
  readonly generation: number
  readonly mount: number
  change(content: RichDoc): MountedEditorChange
  /** 正文和上次记下的一样就返回 null，切换时不把没改过的笔记再存一遍。 */
  pendingChange(content: RichDoc): MountedEditorChange | null
  selection(text: string): { protocol: number; text: string; documentId: string; generation: number; mount: number }
  hostUpdate(value: RichDoc, acknowledged: number, acknowledgedGeneration?: number): RichDoc
}

export function mountEditorSession(stamp: EditorFrameStamp, value: RichDoc, _acknowledged: number): MountedEditorSession {
  const documentId = stamp.documentId
  const generation = stamp.generation
  const mount = stamp.mount ?? 0
  const sync = new EditorSync()
  sync.beginDocument(documentId, generation)
  let known: RichDoc = value
  const change = (content: RichDoc): MountedEditorChange => {
    known = content
    return { protocol: EDITOR_FRAME_PROTOCOL, ...sync.edited(content), documentId, generation, mount }
  }
  return {
    documentId,
    generation,
    mount,
    change,
    pendingChange(content) {
      if (sameEditorDocument(content, known)) return null
      return change(content)
    },
    selection(text) {
      return { protocol: EDITOR_FRAME_PROTOCOL, text, documentId, generation, mount }
    },
    hostUpdate(next, acknowledgedRevision, acknowledgedGeneration = generation) {
      const resolved = sync.prepareHostUpdate(next, acknowledgedRevision, acknowledgedGeneration)()
      known = resolved
      return resolved
    },
  }
}
