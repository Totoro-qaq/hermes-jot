import { translator } from './i18n.js'
import type { ImportResult, JotLocale } from './types.js'

export const IMPORT_ACCEPT = '.md,.markdown,.txt,.zip'
export const IMPORT_MAX_BYTES = 100 * 1024 * 1024
const DETAIL_LINES = 5

/** Combined results of several uploads, in order. */
export function mergeImportResults(results: readonly ImportResult[]): ImportResult {
  return {
    notes: results.reduce((sum, item) => sum + item.notes, 0),
    attachments: results.reduce((sum, item) => sum + item.attachments, 0),
    folders: results.reduce((sum, item) => sum + item.folders, 0),
    noteIds: results.flatMap(item => item.noteIds),
    skipped: results.flatMap(item => item.skipped),
  }
}

/** The engine lists at most 1,000 skipped files and then one "N more files were skipped." entry. */
function skippedFiles(result: ImportResult): { listed: ImportResult['skipped']; total: number } {
  let omitted = 0
  const listed = result.skipped.filter(item => {
    const more = item.path === '…' ? /^(\d+) more files? (?:were|was) skipped/u.exec(item.reason) : null
    if (more) omitted += Number(more[1])
    return !more
  })
  return { listed, total: listed.length + omitted }
}

/** A toast line, and the skipped files as "path: reason" lines for the error area. */
export function summarizeImport(result: ImportResult, locale: JotLocale): { toast: string; details: string } {
  const t = translator(locale)
  const imported = t('Imported {count} notes', { count: result.notes })
  const { listed, total } = skippedFiles(result)
  const toast = total ? t('{imported} · {count} skipped', { imported, count: total }) : imported
  if (!total) return { toast, details: '' }
  const lines = listed.slice(0, DETAIL_LINES).map(item => `${item.path}: ${item.reason}`)
  const rest = total - Math.min(listed.length, DETAIL_LINES)
  if (rest > 0) lines.push(t('…and {count} more', { count: rest }))
  return { toast, details: [t('Skipped while importing:'), ...lines].join('\n') }
}

/** Rejected before reading the bytes, so a huge file never loads into memory. */
export function importFileProblem(file: { name: string; size: number }, locale: JotLocale): string | null {
  const t = translator(locale)
  if (!/\.(?:md|markdown|txt|zip)$/iu.test(file.name)) return t('{name}: choose Markdown, text or ZIP files.', { name: file.name })
  if (file.size > IMPORT_MAX_BYTES) return t('{name} is larger than 100 MB.', { name: file.name })
  return null
}
