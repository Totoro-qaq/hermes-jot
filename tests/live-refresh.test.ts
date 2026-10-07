import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChangeEmitter, LIVE_REFRESH, startLiveRefresh, type RefreshTimer } from '../src/client/live-refresh.js'

function fakeClock() {
  let now = 0
  let timers: Array<{ at: number; run: () => void; live: boolean }> = []
  const timer: RefreshTimer = (run, ms) => {
    const item = { at: now + ms, run, live: true }
    timers.push(item)
    return () => { item.live = false }
  }
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = timers.filter(item => item.live && item.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.live = false
      next.run()
      await settle()
    }
    now = end
    timers = timers.filter(item => item.live)
  }
  return { timer, advance, pending: () => timers.filter(item => item.live).length }
}
const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }

function setup(options: { signal?: boolean; visible?: () => boolean; refresh?: () => unknown } = {}) {
  const clock = fakeClock()
  const emitter = createChangeEmitter()
  let calls = 0
  const live = startLiveRefresh({
    refresh: () => { calls++; return options.refresh?.() }, timer: clock.timer,
    isVisible: options.visible ?? (() => true), signal: options.signal ? emitter : undefined,
  })
  return { clock, emitter, live, calls: () => calls }
}

test('without change events a visible panel refreshes now and every three seconds', async () => {
  const { clock, calls, live } = setup()
  await settle()
  assert.equal(calls(), 1)
  await clock.advance(LIVE_REFRESH.pollMs * 3)
  assert.equal(calls(), 4)
  live.dispose()
})

test('with change events a burst of writes becomes one refresh, and polling slows to a fallback', async () => {
  const { clock, emitter, calls, live } = setup({ signal: true })
  await settle()
  assert.equal(calls(), 1)
  await clock.advance(LIVE_REFRESH.pollMs * 3)
  assert.equal(calls(), 1, 'no three-second polling while events arrive')
  emitter.emit(); emitter.emit(); emitter.emit()
  await clock.advance(LIVE_REFRESH.coalesceMs - 1)
  assert.equal(calls(), 1)
  await clock.advance(1)
  assert.equal(calls(), 2)
  await clock.advance(LIVE_REFRESH.signalPollMs - 1)
  assert.equal(calls(), 2, 'the fallback poll restarts after each refresh')
  await clock.advance(1)
  assert.equal(calls(), 3)
  live.dispose()
})

test('hidden panels skip events and polls, and refresh when they wake', async () => {
  let visible = true
  const { clock, emitter, calls, live } = setup({ signal: true, visible: () => visible })
  await settle()
  visible = false
  emitter.emit()
  await clock.advance(LIVE_REFRESH.signalPollMs * 2)
  assert.equal(calls(), 1)
  visible = true
  live.wake(); live.wake()
  await clock.advance(LIVE_REFRESH.coalesceMs)
  assert.equal(calls(), 2)
  live.dispose()
})

test('a change during a slow refresh queues exactly one follow-up', async () => {
  const gates: Array<() => void> = []
  const { clock, emitter, calls, live } = setup({ signal: true, refresh: () => new Promise<void>(done => gates.push(done)) })
  await settle()
  emitter.emit(); emitter.emit()
  live.wake()
  await clock.advance(LIVE_REFRESH.coalesceMs * 4)
  assert.equal(calls(), 1, 'never two refreshes at once')
  gates.shift()!()
  await settle()
  assert.equal(calls(), 2)
  gates.shift()!()
  await settle()
  await clock.advance(LIVE_REFRESH.coalesceMs * 4)
  assert.equal(calls(), 2)
  live.dispose()
})

test('a failing refresh keeps the schedule alive', async () => {
  const { clock, calls, live } = setup({ refresh: () => { throw new Error('offline') } })
  await settle()
  await clock.advance(LIVE_REFRESH.pollMs)
  assert.equal(calls(), 2)
  live.dispose()
})

test('dispose unsubscribes and cancels every timer', async () => {
  const { clock, emitter, calls, live } = setup({ signal: true })
  await settle()
  emitter.emit()
  live.dispose()
  assert.equal(clock.pending(), 0)
  emitter.emit()
  await clock.advance(LIVE_REFRESH.signalPollMs * 2)
  assert.equal(calls(), 1)
})

test('one emitter fans out to every panel and survives a throwing listener', () => {
  const emitter = createChangeEmitter()
  const heard: string[] = []
  const stopA = emitter.subscribe(() => { heard.push('a'); throw new Error('broken panel') })
  emitter.subscribe(() => heard.push('b'))
  emitter.emit()
  stopA()
  emitter.emit()
  assert.deepEqual(heard, ['a', 'b', 'b'])
})
