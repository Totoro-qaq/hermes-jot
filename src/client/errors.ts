import { translator, type Translate } from './i18n.js'
import type { JotLocale } from './types.js'

type Copy = (t: Translate) => string

/** Host error codes are stable; their English messages are for logs and agents, not the UI. */
const BY_CODE: Record<string, Copy> = {
  REVISION_CONFLICT: t => t('This note changed elsewhere. Reopen it and try again.'),
  NOT_FOUND: t => t('The note or folder no longer exists; it may have been deleted elsewhere.'),
  LOCK_TIMEOUT: t => t('The notes library is busy. Try again in a moment.'),
  PERSISTENCE_ERROR: t => t('Could not write to the notes folder. Your changes are still here.'),
  CORRUPT_STATE: t => t('The notes file could not be read. The original and its backup were kept.'),
  HUMAN_ONLY: t => t('Only you can do this.'),
  AGENT_DISABLED: t => t('AI collaboration is turned off.'),
  UNAUTHORIZED: t => t('The Hermes session expired. Reload the Hermes page.'),
  FORBIDDEN: t => t('Hermes refused this request. Reload the page and try again.'),
  // Thrown by the Hermes adapter when the person switched profile or connection under an open panel.
  PROFILE_CHANGED: t => t('The active Hermes profile changed. Return to the original profile to continue.'),
  REQUEST_TOO_LARGE: t => t('This content is too large to save at once.'),
  ATTACHMENT_TOO_LARGE: t => t('The file is larger than the attachment limit.'),
  ATTACHMENT_QUOTA: t => t('Attachment storage is full. Empty Trash to free space.'),
  ATTACHMENT_NOT_FOUND: t => t('This attachment is no longer available.'),
  ATTACHMENT_LOCKED: t => t('Attachments are busy. Try again in a moment.'),
  ATTACHMENT_PERSISTENCE: t => t('The attachment could not be saved or read. Try again.'),
  CORRUPT_ATTACHMENTS: t => t('Attachment data could not be read. The original files were kept.'),
  INVALID_ATTACHMENT: t => t('This file name cannot be used.'),
  ATTACHMENT_ACTIONS_UNAVAILABLE: t => t('This host cannot open attachments in other apps. Download the file instead.'),
  ATTACHMENT_OPEN_UNAVAILABLE: t => t('This host cannot open attachments in other apps. Download the file instead.'),
  ATTACHMENT_OPEN_FAILED: t => t('The attachment could not be opened. Check the default app or download it.'),
  ATTACHMENT_OPEN_TIMEOUT: t => t('The app took too long to respond. Download the file instead.'),
  ATTACHMENT_OPEN_CANCELLED: t => t('Opening was cancelled.'),
  ATTACHMENT_PREVIEW_FAILED: t => t('The preview could not be prepared. Download the file instead.'),
  IMPORT_TOO_LARGE: t => t('Import files are limited to 100 MB.'),
  REQUEST_TIMEOUT: t => t('Jot took too long. Check the current notes before trying again.'),
  RUNTIME_UNAVAILABLE: t => t('Jot’s note engine could not start. Check that Hermes dependencies (Node.js 22.19+) are prepared.'),
  RUNTIME_ERROR: t => t('Jot’s note engine returned an invalid response. Try again.'),
  HOST_VERSION_UNSUPPORTED: t => t('Update Hermes to use Jot.'),
  INVALID_EXPORT_FORMAT: t => t('Choose TXT, Markdown, PDF or Word.'),
  // Raised in the Hermes adapter and the embedded editor, never by the engine.
  EXPORT_FILE_MISSING: t => t('Hermes did not return the export file. Try again.'),
  UNSUPPORTED_LINK: t => t('Jot opens only web and email links.'),
  LINK_OPEN_FAILED: t => t('The link could not be opened.'),
  EDITOR_UNAVAILABLE: t => t('Could not load the Jot editor. Re-enable the backend and reopen this note.'),
}

/** Messages more specific than their code's generic sentence. */
const BEFORE_CODE: Array<[RegExp, Copy]> = [
  [/no agent edit to undo/iu, t => t('This is no longer the AI-edited version, so it cannot be undone.')],
]

/** Some INVALID_INPUT messages carry a limit the user can act on. */
const BY_MESSAGE: Array<[RegExp, Copy]> = [
  // Markdown import: retrying the same file cannot help, so say what to change.
  [/not a readable ZIP|ZIP archive is damaged/iu, t => t('This ZIP file is damaged or cannot be read.')],
  [/ZIP import holds at most/iu, t => t('The ZIP holds too many notes. Import one folder at a time.')],
  [/ZIP import links at most/iu, t => t('The ZIP links too many attachments. Import one folder at a time.')],
  [/archive expands to more than/iu, t => t('The ZIP expands to more than 100 MB. Import one folder at a time.')],
  [/ZIP archive has more than [\d,]+ entries/iu, t => t('The ZIP contains too many files. Import one folder at a time.')],
  [/Imports? (?:files )?are limited to/iu, t => t('Import files are limited to 100 MB.')],
  [/Import Markdown, text or ZIP files/iu, t => t('Choose Markdown, text or ZIP files.')],
  [/byte limit|too long|too complex|too many entries|size limit/iu, t => t('This note is over the size limit. Split it into several notes.')],
  [/Folder name already exists/iu, t => t('A folder with this name already exists.')],
  [/exceed(?:s)? 200 MiB/iu, t => t('Attachments or the export exceed 200 MiB. Export one folder at a time.')],
  [/Export exceeds/iu, t => t('The export is larger than 50 MiB.')],
  [/no notes to export/iu, t => t('There are no notes to export here.')],
  [/notes as PDF at once/iu, t => t('PDF exports at most 500 notes at once. Export one folder at a time, or choose Word.')],
  [/notes at once/iu, t => t('Export at most 2,000 notes at once. Export one folder at a time.')],
  [/Unsafe link/iu, t => t('The note contains an unsafe link and was not saved.')],
]

/** A short, localized sentence for any thrown value. */
export function describeError(cause: unknown, locale: JotLocale): string {
  const t = translator(locale)
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  for (const [pattern, copy] of BEFORE_CODE) if (pattern.test(message)) return copy(t)
  if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code]!(t)
  for (const [pattern, copy] of BY_MESSAGE) if (pattern.test(message)) return copy(t)
  if (cause instanceof TypeError && /fetch|network|load failed/iu.test(message)) return t('Cannot reach Hermes. Check that it is still running.')
  if (code === 'INVALID_INPUT') return t('This content could not be saved. Check it and try again.')
  // Messages created by Jot's own client code are already localized.
  if (message && !code) return message
  return t('The operation did not complete. Try again.')
}

/** The engine's reasons for files an import skipped (English, as agents and logs read them). */
const SKIP_REASONS: Array<[RegExp, Copy]> = [
  [/^The note is larger than/u, t => t('The note is larger than 4 MiB.')],
  [/^The file is not UTF-8 text/u, t => t('The file is not UTF-8 text.')],
  [/^The note is too large or complex/u, t => t('The note is too large or complex for Jot.')],
  [/^Unsafe path in the archive/u, t => t('Unsafe path in the archive.')],
  [/^Duplicate entry in the archive/u, t => t('Duplicate entry in the archive.')],
  [/^Unsupported ZIP compression/u, t => t('Unsupported ZIP compression.')],
  [/^The file exceeds the attachment size limit/u, t => t('The file exceeds the attachment size limit.')],
  [/^Not a Markdown or text note/u, t => t('Not a Markdown or text note, and no imported note links to it.')],
  [/^The file could not be attached/u, t => t('The file could not be attached.')],
]

/**
 * A skipped file's reason in the interface language. English keeps the engine's own
 * sentence, which may carry a technical detail; the "N more files were skipped." summary
 * entry stays as it is, because the import summary parses it.
 */
export function describeSkipReason(reason: string, locale: JotLocale): string {
  if (locale === 'en') return reason
  const t = translator(locale)
  for (const [pattern, copy] of SKIP_REASONS) if (pattern.test(reason)) return copy(t)
  return reason
}
