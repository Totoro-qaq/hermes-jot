import { useId, useMemo, useState } from 'react'
import { translator } from './i18n.js'
import type { ExcerptSource } from './note-actions.js'
import { noteDisplay } from './note-list.js'
import type { JotLocale, Note } from './types.js'

/** `source` carries the interface language, so the saved "Source:" line reads in it. */
export interface CaptureSubmission { text: string; source?: ExcerptSource; targetNoteId: string | null; title?: string }
export interface CaptureDialogProps {
  notes: readonly Note[]
  capturedText: string
  source?: string
  /** The note open beside the capture, offered first and selected by default. */
  currentNoteId?: string | null
  onSubmit: (submission: CaptureSubmission) => void | Promise<void>
  onClose: () => void
  busy?: boolean
  error?: string
  locale?: JotLocale
}

/** Form body only: the application's shared modal owns focus, Escape, and its portal. */
export function CaptureDialog({ notes, capturedText, source = '', currentNoteId = null, onSubmit, onClose, busy = false, error = '', locale = 'en' }: CaptureDialogProps) {
  const id = useId()
  const t = translator(locale)
  const available = useMemo(() => notes.filter(note => note.deletedAt === null)
    .sort((a, b) => Number(b.id === currentNoteId) - Number(a.id === currentNoteId) || b.updatedAt.localeCompare(a.updatedAt)), [notes, currentNoteId])
  const [text, setText] = useState(capturedText)
  const [sourceText, setSourceText] = useState(source)
  const [title, setTitle] = useState('')
  const [targetNoteId, setTargetNoteId] = useState<string | null>(() => currentNoteId && available.some(note => note.id === currentNoteId) ? currentNoteId : null)
  const targetAvailable = targetNoteId === null || available.some(note => note.id === targetNoteId)
  const label = (note: Note) => {
    const name = noteDisplay(note).title || t('Untitled')
    return note.id === currentNoteId ? t('Current note · {name}', { name }) : name
  }
  return <form className="jot-capture-form" onSubmit={event => {
    event.preventDefault()
    if (busy || !text.trim() || !targetAvailable) return
    void onSubmit({ text, targetNoteId, ...(sourceText.trim() ? { source: { typed: sourceText.trim(), locale } } : {}),
      ...(targetNoteId === null && title.trim() ? { title: title.trim() } : {}) })
  }}>
    <div className="jot-capture-field">
      <label htmlFor={`${id}-text`}>{t('Text to capture')}</label>
      <textarea id={`${id}-text`} dir="auto" className="jot-capture-text" rows={6} autoFocus disabled={busy} value={text}
        onChange={event => setText(event.target.value)} placeholder={t('Paste or write something here…')} />
    </div>
    <div className="jot-capture-field">
      <label htmlFor={`${id}-target`}>{t('Save to')}</label>
      <select id={`${id}-target`} className="jot-capture-target" disabled={busy} value={targetNoteId ?? ''}
        onChange={event => setTargetNoteId(event.target.value || null)}>
        <option value="">{t('New note')}</option>
        {!targetAvailable && <option value={targetNoteId!} disabled>{t('Selected note is unavailable')}</option>}
        {available.map(note => <option key={note.id} value={note.id}>{label(note)}</option>)}
      </select>
    </div>
    {targetNoteId === null && <div className="jot-capture-field">
      <label htmlFor={`${id}-title`}>{t('Title (optional)')}</label>
      <input id={`${id}-title`} className="jot-capture-title" disabled={busy} value={title} maxLength={240}
        onChange={event => setTitle(event.target.value)} placeholder={t('Uses the first line when empty')} />
    </div>}
    <div className="jot-capture-field">
      <label htmlFor={`${id}-source`}>{t('Source (optional)')}</label>
      <input id={`${id}-source`} className="jot-capture-source" type="text" disabled={busy} value={sourceText} maxLength={2_048}
        onChange={event => setSourceText(event.target.value)} placeholder={t('A link or a short source label')} />
    </div>
    {error && <p className="jot-capture-error" role="alert">{error}</p>}
    {!targetAvailable && <p className="jot-capture-error" role="alert">{t('Choose another note or create a new one.')}</p>}
    <div className="jot-capture-actions">
      <button type="button" className="jot-btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button type="submit" className="jot-btn jot-primary" disabled={busy || !text.trim() || !targetAvailable}>
        {busy ? t('Saving…') : targetNoteId === null ? t('Create note') : t('Append to note')}
      </button>
    </div>
  </form>
}

export default CaptureDialog
