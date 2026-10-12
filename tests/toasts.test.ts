import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOAST_ACTION_MS, TOAST_NOTICE_MS, toastDeadline, toastRemainingAfter, toastTimerDeps } from '../src/client/toasts.js'

test('the undo timer pauses while busy and an ordinary notice does not', () => {
  const fresh = toastDeadline({ id: 1, hasAction: true, busy: false, clock: null })
  assert.equal(fresh.delayMs, TOAST_ACTION_MS)
  const paused = toastDeadline({ id: 1, hasAction: true, busy: true, clock: fresh.clock })
  assert.equal(paused.delayMs, null)
  assert.equal(paused.clock?.remainingMs, TOAST_ACTION_MS)
  const resumed = toastDeadline({ id: 1, hasAction: true, busy: false, clock: { id: 1, remainingMs: toastRemainingAfter(TOAST_ACTION_MS, 2500) } })
  assert.equal(resumed.delayMs, TOAST_ACTION_MS - 2500)
  const replaced = toastDeadline({ id: 2, hasAction: true, busy: false, clock: resumed.clock })
  assert.equal(replaced.delayMs, TOAST_ACTION_MS)
  const notice = toastDeadline({ id: 3, hasAction: false, busy: true, clock: replaced.clock })
  assert.equal(notice.delayMs, TOAST_NOTICE_MS)
  assert.equal(notice.clock, null)
  const idleNotice = toastTimerDeps(3, false, false)
  const busyNotice = toastTimerDeps(3, false, true)
  assert.equal(idleNotice.paused, false)
  assert.deepEqual(busyNotice, idleNotice)
  const idleUndo = toastTimerDeps(1, true, false)
  const busyUndo = toastTimerDeps(1, true, true)
  assert.equal(idleUndo.paused, false)
  assert.equal(busyUndo.paused, true)
  assert.equal(busyUndo.id, 1)
})
