/** Export format names, kept apart from the export code so requests validate without loading PDF/Word libraries. */
export const EXPORT_FORMATS = ['txt', 'md', 'pdf', 'docx'] as const
export type ExportFormat = typeof EXPORT_FORMATS[number]
export const LIBRARY_EXPORT_FORMATS = ['docx', 'pdf', 'md'] as const
export type LibraryExportFormat = typeof LIBRARY_EXPORT_FORMATS[number]
