export interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

export interface RichDoc extends RichNode {
  type: 'doc'
}

export interface Note {
  id: string
  title: string
  content: RichDoc
  text: string
  folderId: string | null
  pinned: boolean
  revision: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface Folder { id: string; name: string }
export interface AgentEdit {
  revision: number; at: string
  /** The version from before this run of AI edits can be restored. */
  undo?: boolean
}
export interface JotState {
  version: 1; notes: Note[]; folders: Folder[]; agentEnabled: boolean
  /** Present from Hosts that record agent attribution; keyed by note id. */
  agentEdits?: Record<string, AgentEdit>
}
export interface PurgeResult { purged: string[]; attachments: string[] }
export interface NoteInput { title?: string; content?: RichDoc; folderId?: string | null }
export interface NotePatch extends NoteInput { revision: number; pinned?: boolean }
export interface NoteQuery { q?: string; folderId?: string | null; trash?: boolean }
export interface AttachmentInfo {
  id: string; name: string; mimeType: string; size: number; createdAt: string
  kind: 'image' | 'pdf' | 'file'; url: string; downloadUrl: string; path?: string
}
export interface AttachmentCapabilities { nativeOpen: boolean }
export type ExportFormat = 'txt' | 'md' | 'pdf' | 'docx'
export type LibraryExportFormat = 'docx' | 'pdf' | 'md'
export interface NoteDownload { blob: Blob; filename: string; save?: () => Promise<void> }
export interface LibraryDownload extends NoteDownload { notes: number; attachments: number }
export interface LibraryExportOptions {
  format: LibraryExportFormat
  /** Omitted exports every note; null exports unfiled notes; an id exports one folder. */
  folderId?: string | null
  locale: JotLocale
}
export interface ImportResult {
  notes: number; attachments: number; folders: number; noteIds: string[]
  /** Files inside the upload that were not imported, with a short reason. */
  skipped: Array<{ path: string; reason: string }>
}

export interface JotApi {
  loadEditor?(): Promise<string>
  openExternal?(url: string): Promise<void>
  resolveAttachmentUrl?(id: string): string | Promise<string>
  downloadAttachment?(attachment: AttachmentInfo): Promise<void>
  getState(): Promise<JotState>
  listNotes(query?: NoteQuery): Promise<Note[]>
  getNote(id: string): Promise<Note>
  createNote(input?: NoteInput): Promise<Note>
  updateNote(id: string, patch: NotePatch): Promise<Note>
  deleteNote(id: string, revision: number): Promise<Note>
  restoreNote(id: string, revision: number): Promise<Note>
  /** Permanently delete one note and files that only it referenced. */
  purgeNote?(id: string, revision: number): Promise<PurgeResult>
  /** Permanently delete every note in Trash. */
  emptyTrash?(): Promise<PurgeResult>
  createFolder(name: string): Promise<Folder>
  updateFolder(id: string, name: string): Promise<Folder>
  deleteFolder(id: string): Promise<void>
  setAgentEnabled(agentEnabled: boolean): Promise<{ agentEnabled: boolean }>
  uploadAttachment(file: File): Promise<AttachmentInfo>
  getAttachment(id: string): Promise<AttachmentInfo>
  getAttachmentCapabilities?(): Promise<AttachmentCapabilities>
  prepareAttachmentPreview?(id: string, options?: { signal?: AbortSignal }): Promise<{ path: string }>
  openAttachment?(id: string, options?: { signal?: AbortSignal }): Promise<void>
  exportNote(input: { title: string; content: RichDoc }, format: ExportFormat): Promise<NoteDownload>
  /** A ZIP of many notes, one file each, sorted into folders. */
  exportLibrary?(options: LibraryExportOptions): Promise<LibraryDownload>
  /** Restore the version from before the latest run of AI edits. */
  revertAgentEdit?(id: string, revision: number): Promise<Note>
  /** Import Markdown, text or a ZIP of them; folderId null imports unfiled. */
  importNotes?(file: File, options: { folderId: string | null }): Promise<ImportResult>
}

import type { JotLocale } from './i18n.js'
export type { JotLocale }
