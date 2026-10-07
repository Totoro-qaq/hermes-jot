import type { PluginContext } from '@hermes/plugin-sdk'
import { JotApiError } from '../client/api.js'
import type { AttachmentInfo, ImportResult, JotApi, JotState, NoteDownload, RichDoc } from '../client/types.js'

interface Response { status?: number; headers?: Record<string, string>; data?: any; error?: { code: string; message: string }; file?: { path: string; filename: string } }

export interface HermesJotApi extends JotApi {
  resolveAttachmentUrl(id: string): Promise<string>
  downloadAttachment(attachment: AttachmentInfo): Promise<void>
  dispose(): void
}

/**
 * Hermes rejects a non-2xx plugin reply with an Error whose message ends in
 * "<status>: <body>". Recover the coded `{ error }` body Jot's backend sent, so
 * callers can describe it like any other Jot error.
 */
export function hostRestError(cause: unknown): unknown {
  const message = cause instanceof Error ? cause.message : ''
  const match = /(\d{3}): (\{[\s\S]*\})\s*$/u.exec(message)
  if (!match) return cause
  try {
    const detail = (JSON.parse(match[2]!) as { error?: { code?: unknown; message?: unknown } }).error
    if (typeof detail?.code === 'string' && typeof detail.message === 'string') return new JotApiError(Number(match[1]), detail.code, detail.message)
  } catch { /* not a Jot error body */ }
  return cause
}

export function createHermesApi(ctx: PluginContext, ownsProfile: () => boolean,
  captureGatewayFileDownload: () => (path: string, suggestedName: string) => Promise<void>): HermesJotApi {
  let disposed = false
  let cached: { tag: string; state: JotState; sequence: number } | undefined
  let sequence = 0
  let generation = 0
  const images = new Map<string, Promise<string>>()
  const imageSizes = new Map<string, number>()
  let editorSource: Promise<string> | undefined
  const assertOwner = () => {
    if (disposed || !ownsProfile()) throw new JotApiError(409, 'PROFILE_CHANGED', 'The active Hermes profile changed. Return to the original profile to continue.')
  }
  const rest = <T>(path: string, options?: Parameters<PluginContext['rest']>[1]) =>
    ctx.rest<T>(path, options).catch(cause => { throw hostRestError(cause) })
  const check = (response: Response) => {
    if (response.error) throw new JotApiError(response.status ?? 400, response.error.code, response.error.message)
    return response
  }
  const rpc = async (path: string, method = 'GET', body?: unknown, etag?: string): Promise<Response> => {
    assertOwner()
    const response = check(await rest<Response>('/rpc', { method: 'POST', body: { path, method, ...(body === undefined ? {} : { body }), ...(etag ? { etag } : {}) }, timeoutMs: 100_000 }))
    if (method !== 'GET') generation++
    return response
  }
  const data = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => (await rpc(path, method, body)).data
  const note = (id: string) => `/notes/${encodeURIComponent(id)}`
  const download = async (path: string, body: unknown): Promise<NoteDownload & { notes: number; attachments: number }> => {
    assertOwner()
    const save = captureGatewayFileDownload()
    const response = await rpc(path, 'POST', body)
    if (!response.file) throw new Error('No export file was returned.')
    const file = response.file
    return { blob: new Blob(), filename: file.filename, save: () => save(file.path, file.filename),
      notes: Number(response.headers?.['x-jot-export-notes'] ?? 0), attachments: Number(response.headers?.['x-jot-export-attachments'] ?? 0) }
  }
  const inline = async (id: string): Promise<string> => {
    assertOwner()
    const response = check(await rest<Response>(`/attachments/${encodeURIComponent(id)}/inline`))
    const item = response.data
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(item.mimeType)) throw new Error('Unsupported inline type.')
    // The editor has an opaque origin; a host-origin blob URL is not a portable
    // capability into that sandbox. Verified data URLs need no host credentials.
    return `data:${item.mimeType};base64,${item.base64}`
  }
  return {
    async openExternal(url) {
      assertOwner()
      if (!['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) throw new Error('Unsupported link.')
      if (!await ctx.os.openExternal(url)) throw new Error('Could not open the link.')
    },
    loadEditor: () => {
      assertOwner()
      editorSource ??= rest<{ src: string }>('/editor').then(response => response.src)
      return editorSource
    },
    async getState() {
      const requestSequence = ++sequence
      const atStart = generation
      const previous = cached
      const response = await rpc('/state', 'GET', undefined, previous?.tag)
      assertOwner()
      if (atStart !== generation) return this.getState()
      if (cached && cached.sequence > requestSequence) return cached.state
      if (response.status === 304 && previous) return cached?.state ?? previous.state
      cached = { tag: response.headers?.etag ?? '', state: response.data, sequence: requestSequence }
      return response.data
    },
    listNotes: (query = {}) => data('/notes?' + new URLSearchParams(Object.entries({ q: query.q ?? '',
      ...(query.folderId === undefined ? {} : { folderId: query.folderId ?? '' }), ...(query.trash ? { trash: '1' } : {}) }))),
    getNote: id => data(note(id)), createNote: input => data('/notes', 'POST', input ?? {}),
    updateNote: (id, patch) => data(note(id), 'PATCH', patch),
    deleteNote: (id, revision) => data(note(id), 'DELETE', { revision }),
    restoreNote: (id, revision) => data(`${note(id)}/restore`, 'POST', { revision }),
    purgeNote: (id, revision) => data(`${note(id)}/purge`, 'POST', { revision }),
    emptyTrash: () => data('/trash/empty', 'POST', {}),
    createFolder: name => data('/folders', 'POST', { name }),
    updateFolder: (id, name) => data(`/folders/${encodeURIComponent(id)}`, 'PATCH', { name }),
    deleteFolder: id => data(`/folders/${encodeURIComponent(id)}`, 'DELETE', {}),
    setAgentEnabled: agentEnabled => data('/settings', 'PATCH', { agentEnabled }),
    revertAgentEdit: (id, revision) => data(`${note(id)}/revert-agent-edit`, 'POST', { revision }),
    async uploadAttachment(file) {
      const bytes = await file.arrayBuffer()
      assertOwner()
      const response = check(await rest<Response>('/attachments', { method: 'POST', upload: { filename: file.name, contentType: file.type, bytes }, timeoutMs: 100_000 }))
      return response.data
    },
    async importNotes(file, { folderId }): Promise<ImportResult> {
      const bytes = await file.arrayBuffer()
      assertOwner()
      try {
        const response = check(await rest<Response>('/import?folderId=' + encodeURIComponent(folderId ?? ''),
          { method: 'POST', upload: { filename: file.name, contentType: file.type, bytes }, timeoutMs: 300_000 }))
        return response.data
      } finally {
        // Even a failed or timed-out import may have written notes; a state read in flight is stale.
        generation++
      }
    },
    async getAttachment(id) {
      assertOwner()
      const response = check(await rest<Response>(`/attachments/${encodeURIComponent(id)}/preview`))
      const item = response.data.attachment as AttachmentInfo
      // Hermes owns document previews. Only images need bytes for Jot's inline display.
      const url = item.kind === 'image' ? await inline(id) : ''
      return { ...item, path: response.data.path, url, downloadUrl: url }
    },
    getAttachmentCapabilities: async () => { assertOwner(); return rest('/attachment-capabilities') },
    async openAttachment(id, options) {
      assertOwner()
      if (options?.signal?.aborted) return
      check(await rest<Response>(`/attachments/${encodeURIComponent(id)}/open`, { method: 'POST', body: {}, timeoutMs: 20_000 }))
    },
    async prepareAttachmentPreview(id) {
      assertOwner()
      const response = check(await rest<Response>(`/attachments/${encodeURIComponent(id)}/preview`))
      return { path: response.data.path }
    },
    exportNote: (input, format) => download('/export', { ...input, format }),
    exportLibrary: options => download('/export-library', options),
    resolveAttachmentUrl(id) {
      const existing = images.get(id)
      if (existing) { images.delete(id); images.set(id, existing); return existing }
      const loading = inline(id).then(url => {
        if (disposed || images.get(id) !== loading) return url
        imageSizes.set(id, url.length)
        let total = [...imageSizes.values()].reduce((sum, size) => sum + size, 0)
        for (const key of images.keys()) {
          if (total <= 32 * 1024 * 1024) break
          if (key === id) continue
          total -= imageSizes.get(key) ?? 0
          images.delete(key); imageSizes.delete(key)
        }
        return url
      }, error => {
        if (images.get(id) === loading) { images.delete(id); imageSizes.delete(id) }
        throw error
      })
      images.set(id, loading)
      return loading
    },
    async downloadAttachment(attachment) {
      assertOwner()
      const save = captureGatewayFileDownload()
      const response = check(await rest<Response>(`/attachments/${encodeURIComponent(attachment.id)}/preview`))
      await save(response.data.path, attachment.name)
    },
    dispose() {
      disposed = true
      images.clear(); imageSizes.clear()
    },
  }
}
