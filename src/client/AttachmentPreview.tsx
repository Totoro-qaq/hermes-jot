import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal.js'
import { JotApiError } from './api.js'
import type { AttachmentCapabilities, AttachmentInfo, JotLocale } from './types.js'

export function attachmentOpenMessage(error: unknown, locale: JotLocale): string {
  const en = locale === 'en'
  if (error instanceof JotApiError && error.code === 'ATTACHMENT_OPEN_UNAVAILABLE') {
    return en ? 'This Host cannot open applications. Download the file to open it.' : '当前主机无法打开应用，请下载文件后打开。'
  }
  if (error instanceof JotApiError && error.code === 'ATTACHMENT_OPEN_TIMEOUT') {
    return en ? 'The application took too long to respond. Try again or download the file.' : '应用响应超时，请重试或下载文件后打开。'
  }
  return en ? 'Could not open the file. Check its default application or download it.' : '打开失败，请检查该文件的默认应用，或下载后打开。'
}

export function AttachmentPreview({ hostPreview, onDownload, attachment, onClose, locale = 'zh', getCapabilities, onOpenNative }: {
  hostPreview?: ReactNode; onDownload?: () => Promise<void>
  attachment: AttachmentInfo; onClose: () => void; locale?: JotLocale
  getCapabilities?: () => Promise<AttachmentCapabilities>
  onOpenNative?: (signal: AbortSignal) => Promise<void>
}) {
  const en = locale === 'en'
  const [nativeOpen, setNativeOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    let active = true
    setNativeOpen(false)
    setMessage(''); setError(''); setOpening(false)
    if (onOpenNative && getCapabilities) {
      void getCapabilities().then(capabilities => { if (active) setNativeOpen(capabilities.nativeOpen) }, () => {})
    }
    return () => { active = false; request.current?.abort() }
  }, [attachment.id, getCapabilities, onOpenNative !== undefined])

  const openNative = async () => {
    if (!onOpenNative || request.current && !request.current.signal.aborted) return
    const controller = new AbortController()
    request.current = controller
    setOpening(true); setError(''); setMessage('')
    try {
      await onOpenNative(controller.signal)
      if (!controller.signal.aborted) setMessage(en ? 'Sent to the default application.' : '已交给默认应用打开。')
    } catch (cause) {
      if (!controller.signal.aborted) setError(attachmentOpenMessage(cause, locale))
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setOpening(false)
    }
  }
  return <Modal title={attachment.name} onClose={onClose} closeLabel={en ? 'Close' : '关闭'}
    footer={<>
      <button type="button" className="jot-btn" onClick={() => void onDownload?.()}>{en ? 'Download file' : '下载文件'}</button>
      {nativeOpen && <button type="button" className="jot-btn" disabled={opening} onClick={() => void openNative()}>
        {opening ? (en ? 'Opening…' : '正在打开…') : (en ? 'Open in default app' : '用默认应用打开')}
      </button>}
    </>}>
    <div className="jot-attachment-preview">
      {hostPreview}
      {attachment.kind === 'image' ? <img className="jot-attachment-preview-image" src={attachment.url} alt={attachment.name} />
        : attachment.kind === 'pdf' ? <iframe className="jot-attachment-preview-pdf" src={attachment.url} title={attachment.name} />
          : <p>{en ? 'Preview is unavailable for this file type. Download it to open.' : '此文件类型暂不提供预览，下载后可以打开。'}</p>}
      <p className="jot-file-details">{attachment.mimeType} · {(attachment.size / 1024).toFixed(1)} KB</p>
      {nativeOpen && <p className="jot-file-details">{en
        ? 'Opens a copy on the computer running Hermes. Changes in the other app do not sync back to this note.'
        : '在运行 Hermes 的电脑上打开附件副本，外部修改不会自动同步到笔记。'}</p>}
      {message && <p role="status" className="jot-file-details">{message}</p>}
      {error && <p role="alert" className="jot-attachment-error">{error}</p>}
    </div>
  </Modal>
}
