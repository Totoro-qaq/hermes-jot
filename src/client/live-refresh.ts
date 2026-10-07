/** A push notification that the library changed somewhere; it carries no data. */
export interface ChangeSignal { subscribe(listener: () => void): () => void }

/** Schedules one callback and returns its cancel function. Injected by tests. */
export type RefreshTimer = (run: () => void, ms: number) => () => void

export const LIVE_REFRESH = {
  /** Without change events every visible panel polls. */
  pollMs: 3000,
  /** Events can be missed (tools run from a messaging gateway reach no Desktop), so they keep a slow poll. */
  signalPollMs: 30_000,
  /** A failed refresh (backend starting, brief disconnect) retries soon even when events are on. */
  retryMs: 3000,
  /** One agent turn often writes several times in a row. */
  coalesceMs: 150,
} as const

const defaultTimer: RefreshTimer = (run, ms) => {
  const handle = setTimeout(run, ms)
  return () => clearTimeout(handle)
}

/** A fan-out for one host subscription shared by every mounted panel. */
export function createChangeEmitter(): ChangeSignal & { emit(): void } {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit() {
      for (const listener of [...listeners]) {
        try { listener() } catch { /* one panel cannot starve the others */ }
      }
    },
  }
}

export interface LiveRefreshOptions {
  /** Rejects (or throws) when the refresh failed, so the next attempt comes sooner. */
  refresh: () => unknown
  /** Hidden windows skip polls and change events; becoming visible calls wake(). */
  isVisible: () => boolean
  signal?: ChangeSignal
  timer?: RefreshTimer
}

/**
 * Refreshes once now, then on change events (coalesced), on wake() (window
 * focus, visibility) and on a fallback poll, which comes after retryMs instead
 * when the last refresh failed. At most one refresh runs at a time; triggers
 * during it queue a single follow-up.
 */
export function startLiveRefresh({ refresh, isVisible, signal, timer = defaultTimer }: LiveRefreshOptions) {
  const pollMs = signal ? LIVE_REFRESH.signalPollMs : LIVE_REFRESH.pollMs
  let disposed = false
  let running = false
  let again = false
  let cancelPoll: (() => void) | null = null
  let cancelPending: (() => void) | null = null
  const schedulePoll = (ms: number) => {
    cancelPoll?.()
    cancelPoll = timer(() => {
      cancelPoll = null
      if (isVisible()) run()
      else schedulePoll(ms)
    }, ms)
  }
  const run = () => {
    if (disposed) return
    cancelPending?.(); cancelPending = null
    if (running) { again = true; return }
    running = true
    cancelPoll?.(); cancelPoll = null
    const done = (failed: boolean) => {
      running = false
      if (disposed) return
      if (again && isVisible()) { again = false; run() }
      else { again = false; schedulePoll(failed ? Math.min(pollMs, LIVE_REFRESH.retryMs) : pollMs) }
    }
    try { Promise.resolve(refresh()).then(() => done(false), () => done(true)) }
    catch { done(true) }
  }
  const request = () => {
    if (disposed || !isVisible()) return
    if (running) { again = true; return }
    cancelPending ??= timer(() => { cancelPending = null; run() }, LIVE_REFRESH.coalesceMs)
  }
  const unsubscribe = signal?.subscribe(request)
  run()
  return {
    /** The panel came back into view or focus. */
    wake: request,
    dispose() {
      disposed = true
      cancelPoll?.(); cancelPending?.()
      cancelPoll = cancelPending = null
      unsubscribe?.()
    },
  }
}
