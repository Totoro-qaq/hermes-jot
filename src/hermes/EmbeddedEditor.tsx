import { useEffect, useMemo, useRef, useState } from 'react'
import * as sdk from '@hermes/plugin-sdk'
import { HOST_THEME_PROPERTIES } from './theme.js'
import type { RichEditorActions, RichEditorProps } from '../client/RichEditor.js'
import { describeError } from '../client/errors.js'

const { SandboxedFrame, useTheme } = sdk

export interface EmbeddedEditorProps extends RichEditorProps {
  acknowledgedRevision?: number
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
  const [source, setSource] = useState('')
  /** Why the editor did not load, described in the current language when shown. */
  const [error, setError] = useState<unknown>(null)
  const [height, setHeight] = useState(430)
  const theme = useTheme()
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
    post('props', { value: callbacks.current.value, acknowledgedRevision: callbacks.current.acknowledgedRevision ?? 0, locale: callbacks.current.locale,
      readOnly: callbacks.current.readOnly, dark: (theme.renderedMode ?? theme.resolvedMode) === 'dark',
      theme: { ...Object.fromEntries(THEME_KEYS.map(key => [key, style.getPropertyValue(key)])), ...fonts } })
  }
  useEffect(() => {
    let live = true
    const load = props.loadEditor
    if (!load) { setError({ code: 'EDITOR_UNAVAILABLE' }); return }
    void load().then(value => { if (live) setSource(value) }, cause => { if (live) setError(cause ?? { code: 'EDITOR_UNAVAILABLE' }) })
    return () => { live = false }
  }, [props.loadEditor])
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
      if (kind === 'change' && data?.content?.type === 'doc' && Number.isSafeInteger(data.revision)) callbacks.current.onChange(data.content, data.revision)
      else if (kind === 'inserted' && Number.isSafeInteger(data?.id)) {
        pendingInsert.current.get(data.id)?.(data.inserted === true)
        pendingInsert.current.delete(data.id)
      }
      else if (kind === 'ready') callbacks.current.onReady?.(actions)
      else if (kind === 'blur') callbacks.current.onBlur?.()
      else if (kind === 'save') callbacks.current.onSave?.()
      else if (kind === 'upload') callbacks.current.onRequestAttachment?.()
      else if (kind === 'files' && Array.isArray(data) && data.length <= 21 && data.every(file => file instanceof File)) callbacks.current.onFiles?.(data)
      else if (kind === 'link' && typeof data === 'string' && /^(?:https?:|mailto:)/i.test(data)) callbacks.current.onExternalLink?.(data)
      else if (kind === 'selection' && typeof data === 'string') callbacks.current.onSelectionChange?.(data)
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
  useEffect(sync, [props.value, props.acknowledgedRevision, props.locale, props.readOnly, source])
  useEffect(() => {
    // Hermes paints its CSS variables in the provider's effect. Child effects
    // run first, so reading immediately can send the previous palette to the
    // frame. Read after that paint; no host DOM mutation or theme polling.
    const repaint = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(repaint)
  }, [theme.resolvedMode, theme.renderedMode, theme.themeName, theme.theme])
  return <div ref={root} className="jot-embedded-editor" style={{ minWidth: 0, width: '100%' }}>
    {error ? <p role="alert">{describeError(error, props.locale ?? 'en')}</p> : source ? <SandboxedFrame ref={frame} src={source}
      title={props.locale === 'zh' ? '随记正文编辑器' : 'Jot document editor'} onLoad={sync}
      style={{ display: 'block', width: '100%', height, border: 0, background: 'transparent' }} />
      : <p role="status">{props.locale === 'zh' ? '正在载入编辑器…' : 'Loading editor…'}</p>}
  </div>
}
export type { RichEditorActions }
