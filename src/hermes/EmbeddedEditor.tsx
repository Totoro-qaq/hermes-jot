import { useEffect, useMemo, useRef, useState } from 'react'
import * as sdk from '@hermes/plugin-sdk'
import { openableLinkHref } from '../link-href.js'
import { translator } from '../client/i18n.js'
import type { RichEditorActions, RichEditorProps } from '../client/RichEditor.js'
import { EDITOR_FRAME_PROTOCOL, advanceEditorFrame, guestEditorAction, initialEditorFrame, rememberEditorStamp, reportDroppedEdit, type EditorFrameStamp, type EditorGenerationRevision } from './editor-frame.js'
import { editorLoadOffersRetry, initialEditorLoad, reduceEditorLoad, type EditorLoadState } from './editor-load.js'
import { HOST_THEME_PROPERTIES } from './theme.js'

const { SandboxedFrame, useTheme } = sdk

export interface EmbeddedEditorProps extends RichEditorProps {
  /** 换笔记时只换文档，不重载 iframe。 */
  documentId?: string
  /** 当前这篇笔记已经发出去的代次和修订号。代次对不上时按 0 回传，避免旧代次的数字盖掉新编辑。 */
  editorRevision?: EditorGenerationRevision
  /** 离开这篇笔记的正文已经发出，空的新建笔记这时才可以删除。带上当时的挂载和代次。 */
  onFlushSettled?: (documentId: string, generation: number, mount: number) => void
  /** 这一次 iframe 的挂载编号。重开后必须比上次更大。 */
  claimEditorMount?: () => number
  /** 当前发给访客的代次，离开笔记时用它核对 flush。 */
  onFrameStamp?: (stamp: EditorFrameStamp) => void
  loadEditor?: () => Promise<string>
  onSave?: () => void
  onPreviewAttachment?: (id: string) => void
  onFiles?: (files: File[]) => void
  onExternalLink?: (url: string) => void
  onSelectionChange?: (text: string | null) => void
}

const THEME_KEYS = Object.keys(HOST_THEME_PROPERTIES)
let fallbackMount = 0
function claimFallback(): number {
  fallbackMount += 1
  return fallbackMount
}

/** Only the rich editor runs in the opaque frame; credentials and host APIs never enter it. */
export function RichEditor(props: EmbeddedEditorProps) {
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const pendingInsert = useRef(new Map<number, (inserted: boolean) => void>())
  const insertSequence = useRef(0)
  const callbacks = useRef(props)
  callbacks.current = props
  const token = useMemo(() => crypto.randomUUID(), [])
  // 代次只在真正把属性发给访客时递增，不在渲染期间改。iframe 换成新窗口时挂载编号也换，代次从 0 再计。
  const frameStamp = useRef<EditorFrameStamp | null>(null)
  const mountId = useRef<number | null>(null)
  const frameWindow = useRef<Window | null>(null)
  const recentStamps = useRef<EditorFrameStamp[]>([])
  const [load, setLoad] = useState<EditorLoadState>(initialEditorLoad)
  const [height, setHeight] = useState(430)
  const theme = useTheme()
  const t = translator(props.locale ?? 'en')
  const post = (kind: string, data?: unknown) => frame.current?.contentWindow?.postMessage({ channel: 'jot-editor', token, kind, data }, '*')
  const insert = (kind: string, data: Record<string, unknown>) => new Promise<boolean>(resolve => {
    // A removed frame can never acknowledge; the caller keeps its own fallback.
    if (!frame.current?.contentWindow) { resolve(false); return }
    const id = ++insertSequence.current
    pendingInsert.current.set(id, resolve)
    post(kind, { ...data, id })
  })
  const sync = () => {
    if (!root.current) return
    const win = frame.current?.contentWindow ?? null
    if (win && win !== frameWindow.current) {
      frameWindow.current = win
      mountId.current = callbacks.current.claimEditorMount?.() ?? claimFallback()
      frameStamp.current = null
    }
    if (mountId.current == null) return
    const id = callbacks.current.documentId ?? ''
    const next = frameStamp.current ? advanceEditorFrame(frameStamp.current, id) : initialEditorFrame(id, mountId.current)
    if (frameStamp.current && next !== frameStamp.current) {
      recentStamps.current = rememberEditorStamp(recentStamps.current, frameStamp.current)
      callbacks.current.onSelectionChange?.(null)
    }
    frameStamp.current = next
    callbacks.current.onFrameStamp?.(next)
    const style = getComputedStyle(root.current)
    const size = Number.parseFloat(style.fontSize)
    const fonts = Number.isFinite(size) ? {
      '--dsh-content-font-size': `${size}px`,
      '--dsw-font-markdown-base': `400 ${size}px/1.65 ${style.fontFamily}`,
      '--dsw-font-s-14': `400 ${size}px/1.5 ${style.fontFamily}`,
      '--dsw-font-s-strong-14': `600 ${size}px/1.5 ${style.fontFamily}`,
      '--dsw-font-xs-13': `400 ${size * 12 / 13}px/1.5 ${style.fontFamily}`,
      '--dsw-font-xxs-12': `400 ${size * 11 / 13}px/1.5 ${style.fontFamily}`,
    } : {}
    const recorded = callbacks.current.editorRevision
    const acknowledgedRevision = recorded && recorded.mount === next.mount && recorded.generation === next.generation ? recorded.revision : 0
    post('props', { value: callbacks.current.value, acknowledgedRevision, acknowledgedGeneration: next.generation, mount: next.mount, locale: callbacks.current.locale,
      protocol: EDITOR_FRAME_PROTOCOL, documentId: next.documentId, generation: next.generation,
      readOnly: callbacks.current.readOnly, dark: (theme.renderedMode ?? theme.resolvedMode) === 'dark',
      theme: { ...Object.fromEntries(THEME_KEYS.map(key => [key, style.getPropertyValue(key)])), ...fonts } })
  }
  useEffect(() => {
    let live = true
    const loader = props.loadEditor
    if (!loader) { setLoad(current => reduceEditorLoad(current, { type: 'missing-loader' })); return }
    setLoad(current => reduceEditorLoad(current, { type: 'start' }))
    void loader().then(value => { if (live) setLoad(current => reduceEditorLoad(current, { type: 'loaded', source: value })) },
      () => { if (live) setLoad(current => reduceEditorLoad(current, { type: 'failed' })) })
    return () => { live = false }
  }, [props.loadEditor, load.attempt])
  useEffect(() => {
    const actions: RichEditorActions = {
      focus: () => { frame.current?.focus(); post('focus') },
      insertImage: (attachmentId, alt) => insert('insert-image', { attachmentId, alt }),
      insertAttachment: (attachmentId, caption) => insert('insert-attachment', { attachmentId, caption }),
      appendBlocks: blocks => insert('append-blocks', { blocks }),
      handleShortcut: action => { post('shortcut', action); return true },
    }
    let live = true
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== 'jot-editor') return
      if (event.data.kind === 'hello') { sync(); return }
      if (event.data?.token !== token) return
      const { kind, data, id } = event.data
      const framed = guestEditorAction(frameStamp.current ?? initialEditorFrame(callbacks.current.documentId ?? ''), kind, data, recentStamps.current)
      if (framed.type === 'change') callbacks.current.onChange(framed.content, framed.revision, framed.documentId, framed.generation, framed.mount)
      else if (framed.type === 'flushed') callbacks.current.onFlushSettled?.(framed.documentId, framed.generation, framed.mount)
      else if (framed.type === 'selection') callbacks.current.onSelectionChange?.(framed.text)
      else if (framed.type === 'drop' && kind === 'change') reportDroppedEdit(framed.reason, data)
      else if (kind === 'inserted' && Number.isSafeInteger(data?.id)) {
        pendingInsert.current.get(data.id)?.(data.inserted === true)
        pendingInsert.current.delete(data.id)
      }
      else if (kind === 'ready') callbacks.current.onReady?.(actions)
      else if (kind === 'blur') callbacks.current.onBlur?.()
      else if (kind === 'save') callbacks.current.onSave?.()
      else if (kind === 'upload') callbacks.current.onRequestAttachment?.()
      else if (kind === 'files' && Array.isArray(data) && data.length <= 21 && data.every(file => file instanceof File)) callbacks.current.onFiles?.(data)
      else if (kind === 'link' && typeof data === 'string') { const href = openableLinkHref(data); if (href) callbacks.current.onExternalLink?.(href) }
      else if (kind === 'preview' && typeof data === 'string' && /^[a-f0-9]{32}$/.test(data)) callbacks.current.onPreviewAttachment?.(data)
      else if (kind === 'height' && Number.isFinite(data)) setHeight(Math.max(360, Math.min(100_000, data)))
      else if (kind === 'image' && typeof data === 'string' && /^[a-f0-9]{32}$/.test(data)) {
        void Promise.resolve(callbacks.current.resolveAttachmentUrl?.(data) ?? '').then(url => {
          if (live) post('image-result', { id, url })
        }, () => { if (live) post('image-result', { id, url: '' }) })
      }
    }
    window.addEventListener('message', receive)
    return () => {
      live = false; window.removeEventListener('message', receive)
      for (const resolve of pendingInsert.current.values()) resolve(false)
      pendingInsert.current.clear()
      callbacks.current.onSelectionChange?.(null)
    }
  }, [token])
  useEffect(sync, [props.value, props.editorRevision, props.locale, props.readOnly, props.documentId, load.source])
  useEffect(() => {
    // Hermes paints its CSS variables in the provider's effect. Child effects
    // run first, so reading immediately can send the previous palette to the
    // frame. Read after that paint; no host DOM mutation or theme polling.
    const repaint = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(repaint)
  }, [theme.resolvedMode, theme.renderedMode, theme.themeName, theme.theme])
  return <div ref={root} className="jot-embedded-editor" style={{ minWidth: 0, width: '100%' }}>
    {load.error ? <div role="alert" className="jot-editor-load-error">
      <p>{load.error === 'unavailable' ? t('Hermes editor backend is unavailable.')
        : t('Could not load the Jot editor. Re-enable the backend and reopen this note.')}</p>
      {editorLoadOffersRetry(load) && <button type="button" className="jot-text-btn" onClick={() => setLoad(current => reduceEditorLoad(current, { type: 'retry' }))}>{t('Retry')}</button>}
    </div> : load.source ? <SandboxedFrame ref={frame} src={load.source}
      title={t('Jot document editor')} onLoad={sync}
      style={{ display: 'block', width: '100%', height, border: 0, background: 'transparent' }} />
      : <p role="status">{t('Loading editor…')}</p>}
  </div>
}
export type { RichEditorActions }
