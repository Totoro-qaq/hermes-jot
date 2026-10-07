import { useId, useMemo, useState } from 'react'
import { noteDisplay } from './note-list.js'
import type { JotLocale, Note } from './types.js'

export interface CaptureSubmission { text: string; source?: string; targetNoteId: string | null; title?: string }
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
  const en = locale === 'en'
  const available = useMemo(() => notes.filter(note => note.deletedAt === null)
    .sort((a, b) => Number(b.id === currentNoteId) - Number(a.id === currentNoteId) || b.updatedAt.localeCompare(a.updatedAt)), [notes, currentNoteId])
  const [text, setText] = useState(capturedText)
  const [sourceText, setSourceText] = useState(source)
  const [title, setTitle] = useState('')
  const [targetNoteId, setTargetNoteId] = useState<string | null>(() => currentNoteId && available.some(note => note.id === currentNoteId) ? currentNoteId : null)
  const targetAvailable = targetNoteId === null || available.some(note => note.id === targetNoteId)
  const label = (note: Note) => {
    const name = noteDisplay(note).title || (en ? 'Untitled' : '无标题')
    return note.id === currentNoteId ? en ? `Current note · ${name}` : `当前笔记 · ${name}` : name
  }
  return <form className="jot-capture-form" onSubmit={event => {
    event.preventDefault()
    if (busy || !text.trim() || !targetAvailable) return
    void onSubmit({ text, targetNoteId, ...(sourceText.trim() ? { source: sourceText.trim() } : {}),
      ...(targetNoteId === null && title.trim() ? { title: title.trim() } : {}) })
  }}>
    <div className="jot-capture-field">
      <label htmlFor={`${id}-text`}>{en ? 'Text to capture' : '记下这段内容'}</label>
      <textarea id={`${id}-text`} className="jot-capture-text" rows={6} autoFocus disabled={busy} value={text}
        onChange={event => setText(event.target.value)} placeholder={en ? 'Paste or write something here…' : '粘贴文字，或者随手写一点…'} />
    </div>
    <div className="jot-capture-field">
      <label htmlFor={`${id}-target`}>{en ? 'Save to' : '保存到'}</label>
      <select id={`${id}-target`} className="jot-capture-target" disabled={busy} value={targetNoteId ?? ''}
        onChange={event => setTargetNoteId(event.target.value || null)}>
        <option value="">{en ? 'New note' : '新笔记'}</option>
        {!targetAvailable && <option value={targetNoteId!} disabled>{en ? 'Selected note is unavailable' : '所选笔记已不可用'}</option>}
        {available.map(note => <option key={note.id} value={note.id}>{label(note)}</option>)}
      </select>
    </div>
    {targetNoteId === null && <div className="jot-capture-field">
      <label htmlFor={`${id}-title`}>{en ? 'Title (optional)' : '标题（可选）'}</label>
      <input id={`${id}-title`} className="jot-capture-title" disabled={busy} value={title} maxLength={240}
        onChange={event => setTitle(event.target.value)} placeholder={en ? 'Uses the first line when empty' : '留空时使用第一行'} />
    </div>}
    <div className="jot-capture-field">
      <label htmlFor={`${id}-source`}>{en ? 'Source (optional)' : '来源（可选）'}</label>
      <input id={`${id}-source`} className="jot-capture-source" type="text" disabled={busy} value={sourceText} maxLength={2_048}
        onChange={event => setSourceText(event.target.value)} placeholder={en ? 'A link or a short source label' : '链接或一句来源说明'} />
    </div>
    {error && <p className="jot-capture-error" role="alert">{error}</p>}
    {!targetAvailable && <p className="jot-capture-error" role="alert">{en ? 'Choose another note or create a new one.' : '请选择另一条笔记，或新建笔记。'}</p>}
    <div className="jot-capture-actions">
      <button type="button" className="jot-btn" disabled={busy} onClick={onClose}>{en ? 'Cancel' : '取消'}</button>
      <button type="submit" className="jot-btn jot-primary" disabled={busy || !text.trim() || !targetAvailable}>
        {busy ? en ? 'Saving…' : '保存中…' : targetNoteId === null ? en ? 'Create note' : '新建笔记' : en ? 'Append to note' : '追加到笔记'}
      </button>
    </div>
  </form>
}

export default CaptureDialog
