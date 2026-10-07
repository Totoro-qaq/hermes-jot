import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal.js'
import { JotApiError } from './api.js'
import { intlLocale, translator } from './i18n.js'
import type { AttachmentCapabilities, AttachmentInfo, JotLocale } from './types.js'

export function attachmentOpenMessage(error: unknown, locale: JotLocale): string {
  const t = translator(locale)
  if (error instanceof JotApiError && error.code === 'ATTACHMENT_OPEN_UNAVAILABLE') {
    return t('This Host cannot open applications. Download the file to open it.')
  }
  if (error instanceof JotApiError && error.code === 'ATTACHMENT_OPEN_TIMEOUT') {
    return t('The application took too long to respond. Try again or download the file.')
  }
  return t('Could not open the file. Check its default application or download it.')
}

/**
 * Binary kilobytes (1024 bytes) with one decimal: "1.5 KB", "1,5 Ko". Intl's `kilobyte` unit means 1000 bytes,
 * so only the number goes through Intl and the unit comes from the catalog.
 */
export function fileSize(bytes: number, locale: JotLocale): string {
  const t = translator(locale)
  const size = new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024)
  return t('{size} KB', { size })
}

export function AttachmentPreview({ hostPreview, onDownload, attachment, onClose, locale = 'en', getCapabilities, onOpenNative }: {
  hostPreview?: ReactNode; onDownload?: () => Promise<void>
  attachment: AttachmentInfo; onClose: () => void; locale?: JotLocale
  getCapabilities?: () => Promise<AttachmentCapabilities>
  onOpenNative?: (signal: AbortSignal) => Promise<void>
}) {
  const t = translator(locale)
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
      if (!controller.signal.aborted) setMessage(t('Sent to the default application.'))
    } catch (cause) {
      if (!controller.signal.aborted) setError(attachmentOpenMessage(cause, locale))
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setOpening(false)
    }
  }
  return <Modal title={attachment.name} onClose={onClose} closeLabel={t('Close')}
    footer={<>
      <button type="button" className="jot-btn" onClick={() => void onDownload?.()}>{t('Download file')}</button>
      {nativeOpen && <button type="button" className="jot-btn" disabled={opening} onClick={() => void openNative()}>
        {opening ? t('Opening…') : t('Open in default app')}
      </button>}
    </>}>
    <div className="jot-attachment-preview">
      {hostPreview}
      {attachment.kind === 'image' ? <img className="jot-attachment-preview-image" src={attachment.url} alt={attachment.name} />
        : hostPreview ? null
          : attachment.kind === 'pdf' ? <iframe className="jot-attachment-preview-pdf" src={attachment.url} title={attachment.name} />
          : <p>{t('Preview is unavailable for this file type. Download it to open.')}</p>}
      <p className="jot-file-details">{attachment.mimeType} · {fileSize(attachment.size, locale)}</p>
      {nativeOpen && <p className="jot-file-details">
        {t('Opens a copy on the computer running Hermes. Changes in the other app do not sync back to this note.')}</p>}
      {message && <p role="status" className="jot-file-details">{message}</p>}
      {error && <p role="alert" className="jot-attachment-error">{error}</p>}
    </div>
  </Modal>
}
