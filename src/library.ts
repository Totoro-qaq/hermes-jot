/**
 * Export and import code with its heavy dependencies (PDFKit, docx, fflate,
 * markdown-it). The engine loads it on demand; the build emits it as
 * runtime/library.cjs beside runtime/worker.cjs.
 */
export { exportJotLibrary, exportJotNote } from './exports.js'
export { importNotesFile, markdownToNote } from './markdown-import.js'
