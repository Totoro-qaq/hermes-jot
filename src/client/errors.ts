import type { JotLocale } from './types.js'

type Copy = readonly [zh: string, en: string]

/** Host error codes are stable; their English messages are for logs and agents, not the UI. */
const BY_CODE: Record<string, Copy> = {
  REVISION_CONFLICT: ['这条笔记已在别处更新，请重新打开后再试。', 'This note changed elsewhere. Reopen it and try again.'],
  NOT_FOUND: ['笔记或文件夹已不存在，可能已在别处删除。', 'The note or folder no longer exists; it may have been deleted elsewhere.'],
  LOCK_TIMEOUT: ['笔记库正被其他操作占用，请稍后再试。', 'The notes library is busy. Try again in a moment.'],
  PERSISTENCE_ERROR: ['无法写入笔记目录，内容仍保留在这里。', 'Could not write to the notes folder. Your changes are still here.'],
  CORRUPT_STATE: ['笔记数据无法读取，原文件和备份均已保留。', 'The notes file could not be read. The original and its backup were kept.'],
  HUMAN_ONLY: ['这个操作只能由你本人完成。', 'Only you can do this.'],
  AGENT_DISABLED: ['AI 协作已关闭。', 'AI collaboration is off.'],
  UNAUTHORIZED: ['登录状态已失效，请刷新 Hermes 页面。', 'The Hermes session expired. Reload the Hermes page.'],
  FORBIDDEN: ['Hermes 拒绝了这次请求，请刷新页面后再试。', 'Hermes refused this request. Reload the page and try again.'],
  REQUEST_TOO_LARGE: ['内容太大，无法一次保存。', 'This content is too large to save at once.'],
  ATTACHMENT_TOO_LARGE: ['文件超过单个附件的大小上限。', 'The file is larger than the attachment limit.'],
  ATTACHMENT_QUOTA: ['附件空间已满，请先清理回收站中的笔记。', 'Attachment storage is full. Empty Trash to free space.'],
  ATTACHMENT_NOT_FOUND: ['附件已不存在。', 'This attachment is no longer available.'],
  ATTACHMENT_LOCKED: ['附件正在被其他操作使用，请稍后再试。', 'Attachments are busy. Try again in a moment.'],
  ATTACHMENT_PERSISTENCE: ['附件没能保存或读取，请重试。', 'The attachment could not be saved or read. Try again.'],
  CORRUPT_ATTACHMENTS: ['附件数据无法读取，原文件已保留。', 'Attachment data could not be read. The original files were kept.'],
  INVALID_ATTACHMENT: ['这个文件名无法使用。', 'This file name cannot be used.'],
  ATTACHMENT_ACTIONS_UNAVAILABLE: ['当前主机不能用其他应用打开附件，请下载后打开。', 'This Host cannot open attachments in other apps. Download the file instead.'],
  ATTACHMENT_OPEN_UNAVAILABLE: ['当前主机不能用其他应用打开附件，请下载后打开。', 'This Host cannot open attachments in other apps. Download the file instead.'],
  ATTACHMENT_OPEN_FAILED: ['没能打开附件，请检查默认应用或下载后打开。', 'The attachment could not be opened. Check the default app or download it.'],
  ATTACHMENT_OPEN_TIMEOUT: ['应用响应超时，请下载后打开。', 'The app took too long to respond. Download the file instead.'],
  ATTACHMENT_OPEN_CANCELLED: ['已取消打开附件。', 'Opening was cancelled.'],
  ATTACHMENT_PREVIEW_FAILED: ['附件预览没能准备好，请下载后查看。', 'The preview could not be prepared. Download the file instead.'],
  INVALID_EXPORT_FORMAT: ['请选择 TXT、Markdown、PDF 或 Word。', 'Choose TXT, Markdown, PDF or Word.'],
}

/** Messages more specific than their code's generic sentence. */
const BEFORE_CODE: Array<[RegExp, Copy]> = [
  [/no agent edit to undo/iu, ['这一版已经不是 AI 修改后的版本，无法撤销。', 'This is no longer the AI-edited version, so it cannot be undone.']],
]

/** Some INVALID_INPUT messages carry a limit the user can act on. */
const BY_MESSAGE: Array<[RegExp, Copy]> = [
  [/byte limit|too long|too complex|too many entries|size limit/iu, ['笔记内容超过容量上限，请拆分成几条笔记。', 'This note is over the size limit. Split it into several notes.']],
  [/Folder name already exists/iu, ['已经有同名文件夹了。', 'A folder with this name already exists.']],
  [/exceed(?:s)? 200 MiB/iu, ['附件或导出文件超过 200 MiB，请按文件夹分批导出。', 'Attachments or the export exceed 200 MiB. Export one folder at a time.']],
  [/Export exceeds/iu, ['导出文件超过 50 MiB 上限。', 'The export is larger than 50 MiB.']],
  [/no notes to export/iu, ['这里没有可以导出的笔记。', 'There are no notes to export here.']],
  [/notes as PDF at once/iu, ['PDF 一次最多导出 500 篇笔记，可以按文件夹分批导出，或改用 Word。', 'PDF exports at most 500 notes at once. Export one folder at a time, or choose Word.']],
  [/notes at once/iu, ['一次最多导出 2000 篇笔记，请按文件夹分批导出。', 'Export at most 2,000 notes at once. Export one folder at a time.']],
  [/Unsafe link/iu, ['包含不安全的链接，已拒绝保存。', 'The note contains an unsafe link and was not saved.']],
]

/** A short, localized sentence for any thrown value. */
export function describeError(cause: unknown, locale: JotLocale): string {
  const pick = ([zh, en]: Copy) => locale === 'en' ? en : zh
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  for (const [pattern, copy] of BEFORE_CODE) if (pattern.test(message)) return pick(copy)
  if (BY_CODE[code]) return pick(BY_CODE[code])
  for (const [pattern, copy] of BY_MESSAGE) if (pattern.test(message)) return pick(copy)
  if (cause instanceof TypeError && /fetch|network|load failed/iu.test(message)) {
    return pick(['无法连接到 Hermes，请确认它仍在运行。', 'Cannot reach Hermes. Check that it is still running.'])
  }
  if (code === 'INVALID_INPUT') return pick(['内容格式无法保存，请检查后重试。', 'This content could not be saved. Check it and try again.'])
  // Messages created by Jot's own client code are already localized.
  if (message && !code) return message
  return pick(['操作没有完成，请重试。', 'The operation did not complete. Try again.'])
}
