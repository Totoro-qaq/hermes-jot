import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { RichEditor, type RichEditorActions } from '../client/RichEditor.js'
import type { RichDoc } from '../client/types.js'
import { intlLocale, isRtlLocale, normalizeLocale, type JotLocale } from '../client/i18n.js'
import { openableLinkHref } from '../link-href.js'
import { EDITOR_FRAME_PROTOCOL, mountEditorSession, reportDroppedEdit, type MountedEditorSession } from './editor-frame.js'
import { jotStyles } from '../client/styles.js'
import { HOST_THEME_PROPERTIES } from './theme.js'

let token = ''
const imageRequests = new Map<number, (url: string) => void>()
let nextImage = 0
const send = (kind: string, data?: unknown, id?: number) => {
  if (token) parent.postMessage({ channel: 'jot-editor', token, kind, data, id }, '*')
}
const image = (attachmentId: string) => new Promise<string>(resolve => {
  const id = ++nextImage
  imageRequests.set(id, resolve)
  send('image', attachmentId, id)
})

function BoundNoteEditor({ documentId, generation, value, acknowledgedRevision, locale, readOnly, sessionRef, actionsRef, selectionGate }: {
  documentId: string
  generation: number
  value: RichDoc
  acknowledgedRevision: number
  locale: JotLocale
  readOnly: boolean
  sessionRef: MutableRefObject<MountedEditorSession | null>
  actionsRef: MutableRefObject<RichEditorActions | null>
  selectionGate: MutableRefObject<{ muted: boolean; last: string }>
}) {
  const session = useRef<MountedEditorSession | null>(null)
  if (!session.current) session.current = mountEditorSession({ documentId, generation }, value, acknowledgedRevision)
  const bound = session.current
  useEffect(() => {
    sessionRef.current = bound
    return () => { if (sessionRef.current === bound) sessionRef.current = null }
  }, [bound, sessionRef])
  const resolveExternalValue = useMemo(() => () => bound.hostUpdate(value, acknowledgedRevision), [bound, value, acknowledgedRevision])
  return <RichEditor value={value} resolveExternalValue={resolveExternalValue} locale={locale} readOnly={readOnly}
    resolveAttachmentUrl={image} onChange={content => send('change', bound.change(content))} onBlur={() => send('blur')}
    onReady={editor => {
      actionsRef.current = editor
      if (!editor) return
      selectionGate.current.muted = false
      send('ready')
      const text = document.getSelection()?.toString() ?? ''
      selectionGate.current.last = text
      send('selection', bound.selection(text))
    }} onRequestAttachment={() => send('upload')} />
}

function Editor() {
  const [props, setProps] = useState<{ value: RichDoc; locale: JotLocale; readOnly: boolean; documentId: string; generation: number; acknowledgedRevision: number } | null>(null)
  const actions = useRef<RichEditorActions | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const activeSession = useRef<MountedEditorSession | null>(null)
  const selectionGate = useRef({ muted: true, last: '' })
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || event.data?.channel !== 'jot-editor') return
      const { kind, data } = event.data
      if (kind === 'props') {
        if (token && token !== event.data.token) return
        token = event.data.token
        const locale = normalizeLocale(data.locale)
        const documentId = typeof data.documentId === 'string' ? data.documentId : ''
        const generation = Number.isSafeInteger(data.generation) && data.generation >= 0 ? data.generation : 0
        if (typeof data.protocol === 'number' && data.protocol !== EDITOR_FRAME_PROTOCOL) {
          reportDroppedEdit('protocol', data)
          return
        }
        const current = activeSession.current
        const switched = !current || current.documentId !== documentId || current.generation !== generation
        if (switched && current) {
          // 外层代次还没换到这篇编辑器身上。先用挂载时记下的笔记把还没发出去的正文发出去。
          const content = actions.current?.readDocument?.()
          const pending = content ? current.pendingChange(content) : null
          if (pending) send('change', pending)
          selectionGate.current = { muted: true, last: '' }
          send('selection', { protocol: EDITOR_FRAME_PROTOCOL, text: '', documentId, generation })
        }
        // The slash menu is portaled to <body>, so the language and direction belong to the whole frame.
        document.documentElement.lang = intlLocale(locale)
        document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr'
        document.documentElement.classList.toggle('dark', Boolean(data.dark))
        document.documentElement.style.colorScheme = data.dark ? 'dark' : 'light'
        document.body.toggleAttribute('data-ds-dark-theme', Boolean(data.dark))
        for (const [key, value] of Object.entries(data.theme ?? {})) {
          if (Object.hasOwn(HOST_THEME_PROPERTIES, key) && typeof value === 'string') document.documentElement.style.setProperty(key, value)
        }
        setProps({ value: data.value, locale, readOnly: Boolean(data.readOnly), documentId, generation, acknowledgedRevision: Number.isSafeInteger(data.acknowledgedRevision) ? data.acknowledgedRevision : 0 })
      } else if (event.data.token === token) {
        if (kind === 'focus') actions.current?.focus()
        if (kind === 'insert-image' || kind === 'insert-attachment') {
          const inserted = kind === 'insert-image' ? actions.current?.insertImage(data.attachmentId, data.alt)
            : actions.current?.insertAttachment(data.attachmentId, data.caption)
          void Promise.resolve(inserted ?? false).then(value => send('inserted', { id: data.id, inserted: value }))
        }
        if (kind === 'append-blocks') {
          // The change message is sent synchronously by the edit, so the host has the
          // appended document before it reads this acknowledgement.
          let appended: boolean | Promise<boolean> | undefined = false
          try { if (Array.isArray(data?.blocks)) appended = actions.current?.appendBlocks?.(data.blocks) } catch { appended = false }
          void Promise.resolve(appended ?? false).then(value => value === true, () => false).then(value => send('inserted', { id: data.id, inserted: value }))
        }
        if (kind === 'shortcut') {
          if (data === 'find') actions.current?.focus()
          actions.current?.handleShortcut(data, document.activeElement)
        }
        if (kind === 'image-result') {
          const request = imageRequests.get(data.id)
          imageRequests.delete(data.id)
          if (request) {
            const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(data.url)
            if (!match) request('')
            else {
              const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0))
              // Created in this opaque realm, so the blob is usable here and
              // is released with its editor node or the whole frame.
              request(URL.createObjectURL(new Blob([bytes], { type: match[1] })))
            }
          }
        }
      }
    }
    const key = (event: KeyboardEvent) => {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform)
      if ((mac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); send('save') }
    }
    const click = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest('[data-jot-attachment-id]') : null
      if (element) { event.preventDefault(); event.stopPropagation(); send('preview', element.getAttribute('data-jot-attachment-id')); return }
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (link && /^(?:https?:|mailto:)/i.test(link.href)) {
        event.preventDefault(); event.stopPropagation()
        const href = openableLinkHref(link.href)
        if (href) send('link', href)
        return
      }
    }
    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length) { event.preventDefault(); event.stopPropagation(); send('files', files.slice(0, 21)) }
    }
    const drag = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length) { event.preventDefault(); event.stopPropagation(); send('files', files.slice(0, 21)) }
    }
    const captureResize = (event: PointerEvent) => {
      const editor = event.target instanceof Element ? event.target.closest<HTMLElement>('.ProseMirror') : null
      if (event.button === 0 && editor?.getAttribute('contenteditable') === 'true' && editor.classList.contains('resize-cursor')) {
        // Keep the upstream mouse-based column drag receiving events when the
        // pointer crosses the editor frame's edge, including the final mouseup.
        editor.setPointerCapture(event.pointerId)
      }
    }
    const publishSelection = (text: string, force = false) => {
      const session = activeSession.current
      if (!session || selectionGate.current.muted) return
      if (!force && text === selectionGate.current.last) return
      selectionGate.current.last = text
      send('selection', session.selection(text))
    }
    const selection = () => {
      if (!document.hasFocus()) return
      publishSelection(document.getSelection()?.toString() ?? '')
    }
    const focused = () => publishSelection(document.getSelection()?.toString() ?? '', true)
    window.addEventListener('message', receive)
    window.addEventListener('keydown', key, true)
    document.addEventListener('click', click, true)
    document.addEventListener('paste', paste, true)
    document.addEventListener('dragover', drag)
    document.addEventListener('drop', drop, true)
    document.addEventListener('selectionchange', selection)
    window.addEventListener('focus', focused)
    document.addEventListener('pointerdown', captureResize, true)
    parent.postMessage({ channel: 'jot-editor', kind: 'hello' }, '*')
    return () => {
      window.removeEventListener('message', receive); window.removeEventListener('keydown', key, true)
      document.removeEventListener('click', click, true); document.removeEventListener('paste', paste, true)
      document.removeEventListener('dragover', drag); document.removeEventListener('drop', drop, true)
      document.removeEventListener('selectionchange', selection)
      window.removeEventListener('focus', focused)
      document.removeEventListener('pointerdown', captureResize, true)
    }
  }, [])
  useEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(() => send('height', Math.ceil(root.current!.getBoundingClientRect().height + 12)))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [Boolean(props)])
  return props && <div ref={root} lang={intlLocale(props.locale)} dir={isRtlLocale(props.locale) ? 'rtl' : 'ltr'} className="jot-app jot-editor-frame" style={{ height: 'auto', display: 'block', minHeight: 340 }}>
    <style>{jotStyles}</style>
    <BoundNoteEditor key={`${props.documentId}:${props.generation}`} documentId={props.documentId} generation={props.generation}
      value={props.value} acknowledgedRevision={props.acknowledgedRevision} locale={props.locale} readOnly={props.readOnly}
      sessionRef={activeSession} actionsRef={actions} selectionGate={selectionGate} />
  </div>
}
createRoot(document.getElementById('jot-editor-root')!).render(<Editor />)
