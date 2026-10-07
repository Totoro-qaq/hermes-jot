import { useState } from 'react'
import { translator } from './i18n.js'
import type { JotLocale, LibraryExportFormat } from './types.js'

/** Matches MAX_LIBRARY_PDF_NOTES on the Host: each PDF embeds its own font subset. */
const PDF_NOTE_LIMIT = 500

export interface ExportDialogProps {
  locale: JotLocale
  /** "all 12 notes" or "3 notes in “Work”": what the export will contain, already translated. */
  scope: string
  count: number
  initialFormat: LibraryExportFormat
  busy: boolean
  error: string
  onSubmit: (format: LibraryExportFormat) => void
  onClose: () => void
}

/** Several notes become one ZIP; Word is first because every office suite opens it and it embeds images. */
export function ExportDialog({ locale, scope, count, initialFormat, busy, error, onSubmit, onClose }: ExportDialogProps) {
  const t = translator(locale)
  const [format, setFormat] = useState<LibraryExportFormat>(initialFormat)
  const choices: Array<{ value: LibraryExportFormat; label: string; detail: string }> = [
    { value: 'docx', label: t('Word (.docx)'), detail: t('Opens in Word, WPS and Pages; images are embedded.') },
    { value: 'pdf', label: 'PDF', detail: t('Fixed layout for reading, printing and sharing.') },
    { value: 'md', label: 'Markdown', detail: t('Plain text for Obsidian and other note apps.') },
  ]
  const tooManyForPdf = format === 'pdf' && count > PDF_NOTE_LIMIT
  return <form className="jot-export-form" onSubmit={event => { event.preventDefault(); if (!busy && count && !tooManyForPdf) onSubmit(format) }}>
    <p className="jot-dialog-text">{t('Export {scope}.', { scope })}</p>
    <fieldset className="jot-export-choices" disabled={busy}>
      <legend>{t('Format')}</legend>
      {choices.map(choice => <label key={choice.value} className="jot-export-choice">
        <input type="radio" name="jot-export-format" value={choice.value} checked={format === choice.value}
          onChange={() => setFormat(choice.value)} data-autofocus={format === choice.value ? '' : undefined} />
        <span><strong>{choice.label}</strong><small>{choice.detail}</small></span>
      </label>)}
    </fieldset>
    <p className="jot-export-note">{t('Each note becomes one file, sorted into folders inside one ZIP. PNG and JPG images are embedded in Word and PDF; other images and files are included as originals in the attachments folder.')}</p>
    {tooManyForPdf && <p className="jot-dialog-error" role="status">{t('PDF exports at most {count} notes at once. Export one folder at a time, or choose Word.', { count: PDF_NOTE_LIMIT })}</p>}
    {error && <p className="jot-dialog-error" role="alert">{error}</p>}
    <div className="jot-dialog-actions">
      <button type="button" className="jot-btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button type="submit" className="jot-btn jot-primary" disabled={busy || !count || tooManyForPdf}>
        {busy ? t('Exporting…') : t('Export')}</button>
    </div>
  </form>
}

export default ExportDialog
