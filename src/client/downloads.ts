import type { NoteDownload } from './types.js'

export async function downloadNote({ blob, filename, save }: NoteDownload): Promise<void> {
  if (save) { await save(); return }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.replace(/[\\/\u0000-\u001f]/g, '_')
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
