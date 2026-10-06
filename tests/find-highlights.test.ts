import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightWindow } from '../src/client/find-highlights.js'

test('large find results retain every result but only decorate a bounded active window', () => {
  const matches = Array.from({ length: 200_000 }, (_, i) => ({ from: i + 1, to: i + 2, text: 'a' }))
  for (const active of [0, 100_000, 199_999]) {
    const window = highlightWindow(matches, active)
    assert.equal(window.matches.length, 256)
    assert.ok(window.matches.includes(matches[active]!))
    assert.equal(window.matches[active - window.start], matches[active])
  }
  assert.equal(matches.length, 200_000)
  assert.deepEqual(highlightWindow([], 0), { start: 0, matches: [] })
})
