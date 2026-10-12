import { useEffect, useMemo, useRef, useState } from 'react'
import * as sdk from '@hermes/plugin-sdk'
import { openableLinkHref } from '../link-href.js'
import { translator } from '../client/i18n.js'
import type { RichEditorActions, RichEditorProps } from '../client/RichEditor.js'
import { EDITOR_FRAME_PROTOCOL, acknowledgedRevision, guestEditorAction, nextEditorFrame, rememberEditorStamp, reportDroppedEdit, type EditorFrameStamp, type EditorRevision } from './editor-frame.js'
import { HOST_THEME_PROPERTIES } from './theme.js'

const { SandboxedFrame, useTheme } = sdk

export interface EmbeddedEditorProps extends RichEditorProps {
  /** 换笔记时只换文档，不重载 iframe。 */
  documentId?: string
  /** 当前这篇笔记已经收下的代次和修订号。 */
  editorRevision?: EditorRevision
  /** 离开这篇笔记的正文已经发出，空的新建笔记这时才可以删除。带上当时的代次。 */
  onFlushSettled?: (documentId: string, generation: number) => void
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

/** Only the rich editor runs in the opaque frame; credentials and host APIs never enter it. */
export function RichEditor(props: EmbeddedEditorProps) {
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const pendingInsert = useRef(new Map<number, (inserted: boolean) => void>())
  const insertSequence = useRef(0)
  const callbacks = useRef(props)
  callbacks.current = props
  const token = useMemo(() => crypto.randomUUID(), [])
  // 代次只在真正把属性发给访客时领，不在渲染期间改。换笔记或 iframe 换成新窗口时领新代次。
  const frameStamp = useRef<EditorFrameStamp | null>(null)
  const frameWindow = useRef<Window | null>(null)
  const recentStamps = useRef<EditorFrameStamp[]>([])
  const [source, setSource] = useState('')
  const [error, setError] = useState<'' | 'unavailable' | 'failed'>('')
  const [attempt, setAttempt] = useState(0)
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
    const win = frame.current?.contentWindow
    if (!win) return
    // 新窗口里的编辑器从头数修订号，上一扇窗口的代次不再沿用，也不留在名单里。
    let stamp = win === frameWindow.current ? frameStamp.current : null
    frameWindow.current = win
    const id = callbacks.current.documentId ?? ''
    if (!stamp || stamp.documentId !== id) {
      if (stamp) {
        recentStamps.current = rememberEditorStamp(recentStamps.current, stamp)
        callbacks.current.onSelectionChange?.(null)
      }
      stamp = nextEditorFrame(id)
      frameStamp.current = stamp
      callbacks.current.onFrameStamp?.(stamp)
    }
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
    post('props', { value: callbacks.current.value, acknowledgedRevision: acknowledgedRevision(callbacks.current.editorRevision, stamp), locale: callbacks.current.locale,
      protocol: EDITOR_FRAME_PROTOCOL, documentId: stamp.documentId, generation: stamp.generation,
      readOnly: callbacks.current.readOnly, dark: (theme.renderedMode ?? theme.resolvedMode) === 'dark',
      theme: { ...Object.fromEntries(THEME_KEYS.map(key => [key, style.getPropertyValue(key)])), ...fonts } })
  }
  useEffect(() => {
    let live = true
    const load = props.loadEditor
    if (!load) { setError('unavailable'); return }
    setError('')
    void load().then(value => { if (live) setSource(value) }, () => { if (live) setError('failed') })
    return () => { live = false }
  }, [props.loadEditor, attempt])
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
      const framed = guestEditorAction(frameStamp.current, kind, data, recentStamps.current)
      if (framed.type === 'change') callbacks.current.onChange(framed.content, framed.revision, framed.documentId, framed.generation)
      else if (framed.type === 'flushed') callbacks.current.onFlushSettled?.(framed.documentId, framed.generation)
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
  useEffect(sync, [props.value, props.editorRevision, props.locale, props.readOnly, props.documentId, source])
  useEffect(() => {
    // Hermes paints its CSS variables in the provider's effect. Child effects
    // run first, so reading immediately can send the previous palette to the
    // frame. Read after that paint; no host DOM mutation or theme polling.
    const repaint = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(repaint)
  }, [theme.resolvedMode, theme.renderedMode, theme.themeName, theme.theme])
  return <div ref={root} className="jot-embedded-editor" style={{ minWidth: 0, width: '100%' }}>
    {error ? <div role="alert" className="jot-editor-load-error">
      <p>{error === 'unavailable' ? t('Hermes editor backend is unavailable.')
        : t('Could not load the Jot editor. Re-enable the backend and reopen this note.')}</p>
      {/* 后端缺失时没有加载函数，重试也没用。 */}
      {error === 'failed' && <button type="button" className="jot-text-btn" onClick={() => setAttempt(count => count + 1)}>{t('Retry')}</button>}
    </div> : source ? <SandboxedFrame ref={frame} src={source}
      title={t('Jot document editor')} onLoad={sync}
      style={{ display: 'block', width: '100%', height, border: 0, background: 'transparent' }} />
      : <p role="status">{t('Loading editor…')}</p>}
  </div>
}
export type { RichEditorActions }
