/** Marks a catalog key without translating it: the host translates `label` when it registers the command. */
const t = (source: string): string => source

/** `label` is English and doubles as the catalog key for the palette and keyboard shortcut settings. */
export const JOT_COMMANDS = [
  { id: 'jot.open', action: 'open' as const, label: t('Jot: Open Jot') },
  { id: 'jot.new-note', action: 'new' as const, label: t('Jot: New note') },
  { id: 'jot.capture', action: 'capture' as const, label: t('Jot: Capture selected text') },
] as const

/** Input selections are separate from the document selection in browsers. */
export function readCommandSelection(target: HTMLElement | null): string {
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') {
    const input = target as HTMLInputElement | HTMLTextAreaElement
    // Password and unsupported input types do not expose selectable text.
    if (input.tagName === 'INPUT' && input.type === 'password') return ''
    return typeof input.selectionStart === 'number' && typeof input.selectionEnd === 'number'
      ? input.value.slice(input.selectionStart, input.selectionEnd) : ''
  }
  return target?.ownerDocument?.getSelection()?.toString() ?? globalThis.getSelection?.()?.toString() ?? ''
}

/** A host keyboard command addressed to one Jot panel. */
export interface JotCompactRecipient {
  sessionId: string
  tabId: string
  /** The host's occurrence lifetime; restoring a closed tab mints a new signal. */
  signal: AbortSignal
}
export interface JotCommandRequest {
  action: 'new' | 'capture' | 'open-note'
  target: 'wide' | 'compact'
  revision: number
  /** Text selected when the command ran, captured before any navigation. */
  text?: string
  /** The note chosen in the "/jot" picker, for `open-note`. */
  noteId?: string
  recipient?: JotCompactRecipient
}

/** Busy operations defer the request; modal ownership explicitly discards it. */
export function consumeJotCommand(request: JotCommandRequest | undefined, state: {
  ready: boolean; busy: boolean; blocked: boolean; lastHandled: number
}, callbacks: {
  claim?: (revision: number) => boolean
  acknowledge?: (revision: number) => void; run: (request: JotCommandRequest) => void
}): number {
  if (!request || !state.ready || request.revision <= state.lastHandled) return state.lastHandled
  if (state.busy && !state.blocked) return state.lastHandled
  if (callbacks.claim && !callbacks.claim(request.revision)) return state.lastHandled
  callbacks.acknowledge?.(request.revision)
  if (!state.blocked) callbacks.run(request)
  return request.revision
}

/**
 * One controller per plugin activation. A request survives until the target
 * panel mounts and acknowledges it, so opening a panel and acting are one step.
 */
export function createCommandBus() {
  let revision = 0
  let pending: JotCommandRequest | undefined
  const listeners = new Set<() => void>()
  let disposed = false
  let releaseLifetime: (() => void) | undefined
  const publish = () => { for (const listener of listeners) listener() }
  const matches = (target: JotCommandRequest['target'], recipient?: JotCompactRecipient) => pending?.target === target
    && (target === 'wide' || recipient !== undefined && pending.recipient?.sessionId === recipient.sessionId
      && pending.recipient.tabId === recipient.tabId && pending.recipient.signal === recipient.signal && !recipient.signal.aborted)
  const clear = () => {
    releaseLifetime?.(); releaseLifetime = undefined
    pending = undefined; publish()
  }
  return {
    subscribe(listener: () => void) {
      if (disposed) return () => {}
      listeners.add(listener); return () => { listeners.delete(listener) }
    },
    getSnapshot: () => pending,
    /** Requests for the other panel are invisible to this one. */
    snapshotFor: (target: JotCommandRequest['target'], recipient?: JotCompactRecipient) => matches(target, recipient) ? pending : undefined,
    send(request: Omit<JotCommandRequest, 'revision'>) {
      if (disposed) return
      if (request.target === 'compact' && (!request.recipient || request.recipient.signal.aborted)) return
      releaseLifetime?.(); releaseLifetime = undefined
      pending = { ...request, revision: ++revision }
      if (request.recipient) {
        const signal = request.recipient.signal
        const abort = () => { if (pending?.recipient?.signal === signal) clear() }
        signal.addEventListener('abort', abort, { once: true })
        releaseLifetime = () => signal.removeEventListener('abort', abort)
      }
      publish()
    },
    /** Atomic ownership: stale React effects may hold a request already consumed elsewhere. */
    claim(answered: number, target: JotCommandRequest['target'], recipient?: JotCompactRecipient): boolean {
      if (disposed || pending?.revision !== answered || !matches(target, recipient)) return false
      clear()
      return true
    },
    acknowledge(answered: number) { if (pending?.revision === answered) clear() },
    dispose() {
      if (disposed) return
      disposed = true
      clear()
      listeners.clear()
    },
  }
}
