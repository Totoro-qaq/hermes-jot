import type { LibraryDownload } from './types.js'

interface ExportDraft { noteId: string; dirty: boolean }

/** A library archive reads persisted notes, so never report success while this writing is still a draft. */
export async function exportSavedLibrary(options: {
  draft: ExportDraft | null
  readDraft(noteId: string): ExportDraft | undefined
  conflicted(noteId: string): boolean
  save(noteId: string): Promise<boolean>
  export(): Promise<LibraryDownload>
  unsavedMessage: string
}): Promise<LibraryDownload> {
  const current = options.draft
  if (current?.dirty) {
    // The first await may only settle an older autosave. Save the still-dirty
    // draft once more, then refuse the archive if it still is not persisted.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.conflicted(current.noteId) || !await options.save(current.noteId)) throw new Error(options.unsavedMessage)
      if (!options.readDraft(current.noteId)?.dirty) break
      if (attempt === 1) throw new Error(options.unsavedMessage)
    }
  }
  return options.export()
}
