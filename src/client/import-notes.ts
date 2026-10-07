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
  const en = locale === 'en'
  const notes = en ? `Imported ${result.notes} ${result.notes === 1 ? 'note' : 'notes'}` : `已导入 ${result.notes} 条笔记`
  const { listed, total } = skippedFiles(result)
  const toast = total ? `${notes}${en ? ` · ${total} skipped` : `，跳过 ${total} 个`}` : notes
  if (!total) return { toast, details: '' }
  const lines = listed.slice(0, DETAIL_LINES).map(item => `${item.path}: ${item.reason}`)
  const rest = total - Math.min(listed.length, DETAIL_LINES)
  if (rest > 0) lines.push(en ? `…and ${rest} more` : `……还有 ${rest} 个`)
  return { toast, details: [en ? 'Skipped while importing:' : '导入时跳过：', ...lines].join('\n') }
}

/** Rejected before reading the bytes, so a huge file never loads into memory. */
export function importFileProblem(file: { name: string; size: number }, locale: JotLocale): string | null {
  const en = locale === 'en'
  if (!/\.(?:md|markdown|txt|zip)$/iu.test(file.name)) {
    return en ? `${file.name}: choose Markdown, text or ZIP files.` : `${file.name}：请选择 Markdown、文本或 ZIP 文件。`
  }
  if (file.size > IMPORT_MAX_BYTES) return en ? `${file.name} is larger than 100 MB.` : `${file.name} 超过 100 MB。`
  return null
}
