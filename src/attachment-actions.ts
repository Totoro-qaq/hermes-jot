export interface AttachmentActions {
  capabilities(): { nativeOpen: boolean }
  preparePreview(id: string): Promise<{ path: string }>
  open(id: string, signal?: AbortSignal): Promise<void>
}
