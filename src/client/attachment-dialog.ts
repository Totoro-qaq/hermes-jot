export interface AttachmentDialogRequest { attachmentId: string; revision: number }

/** Retain a failed wide-panel navigation across its intentional unmount. */
export function createAttachmentDialogHandoff(reveal: () => void) {
  let revision = 0
  let pending: AttachmentDialogRequest | undefined
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => pending,
    open(attachmentId: string) { pending = { attachmentId, revision: ++revision }; publish(); reveal() },
    acknowledge(answered: number) { if (pending?.revision === answered) { pending = undefined; publish() } },
  }
}
