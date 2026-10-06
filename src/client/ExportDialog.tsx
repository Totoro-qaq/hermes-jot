import { useState } from 'react'
import type { JotLocale, LibraryExportFormat } from './types.js'

/** Matches MAX_LIBRARY_PDF_NOTES on the Host: each PDF embeds its own font subset. */
const PDF_NOTE_LIMIT = 500

export interface ExportDialogProps {
  locale: JotLocale
  /** "全部 12 篇笔记" or "「工作」里的 3 篇笔记": what the export will contain. */
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
  const en = locale === 'en'
  const [format, setFormat] = useState<LibraryExportFormat>(initialFormat)
  const choices: Array<{ value: LibraryExportFormat; label: string; detail: string }> = [
    { value: 'docx', label: en ? 'Word (.docx)' : 'Word（.docx）',
      detail: en ? 'Opens in Word, WPS and Pages; images are embedded.' : 'Word、WPS 和 Pages 都能打开，图片直接嵌在文档里。' },
    { value: 'pdf', label: 'PDF', detail: en ? 'Fixed layout for reading, printing and sharing.' : '排版固定，适合阅读、打印和分享。' },
    { value: 'md', label: 'Markdown', detail: en ? 'Plain text for Obsidian and other note apps.' : '纯文本格式，方便导入 Obsidian 等笔记软件。' },
  ]
  const tooManyForPdf = format === 'pdf' && count > PDF_NOTE_LIMIT
  return <form className="jot-export-form" onSubmit={event => { event.preventDefault(); if (!busy && count && !tooManyForPdf) onSubmit(format) }}>
    <p className="jot-dialog-text">{en ? `Export ${scope}.` : `导出${scope}。`}</p>
    <fieldset className="jot-export-choices" disabled={busy}>
      <legend>{en ? 'Format' : '格式'}</legend>
      {choices.map(choice => <label key={choice.value} className="jot-export-choice">
        <input type="radio" name="jot-export-format" value={choice.value} checked={format === choice.value}
          onChange={() => setFormat(choice.value)} data-autofocus={format === choice.value ? '' : undefined} />
        <span><strong>{choice.label}</strong><small>{choice.detail}</small></span>
      </label>)}
    </fieldset>
    <p className="jot-export-note">{en
      ? 'Each note becomes one file, sorted into folders inside one ZIP. PNG and JPG images are embedded in Word and PDF; other images and files are included as originals in the attachments folder.'
      : '每篇笔记一个文件，按文件夹放进一个 ZIP。PNG、JPG 图片会嵌进 Word 和 PDF；其他图片和附件以原文件放在「附件」文件夹里。'}</p>
    {tooManyForPdf && <p className="jot-dialog-error" role="status">{en
      ? `PDF exports at most ${PDF_NOTE_LIMIT} notes at once. Export one folder at a time, or choose Word.`
      : `PDF 一次最多导出 ${PDF_NOTE_LIMIT} 篇笔记，可以按文件夹分批导出，或改用 Word。`}</p>}
    {error && <p className="jot-dialog-error" role="alert">{error}</p>}
    <div className="jot-dialog-actions">
      <button type="button" className="jot-btn" disabled={busy} onClick={onClose}>{en ? 'Cancel' : '取消'}</button>
      <button type="submit" className="jot-btn jot-primary" disabled={busy || !count || tooManyForPdf}>
        {busy ? en ? 'Exporting…' : '正在导出…' : en ? 'Export' : '导出'}</button>
    </div>
  </form>
}

export default ExportDialog
