import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextRovingIndex } from '../src/client/roving-focus.js'

test('arrow keys wrap through a menu, Home and End jump to the ends, and left and right follow direction', () => {
  assert.equal(nextRovingIndex(3, -1, 'ArrowDown'), 0)
  assert.equal(nextRovingIndex(3, 0, 'ArrowDown'), 1)
  assert.equal(nextRovingIndex(3, 2, 'ArrowRight'), 0)
  assert.equal(nextRovingIndex(3, 0, 'ArrowUp'), 2)
  assert.equal(nextRovingIndex(3, 2, 'ArrowLeft'), 1)
  assert.equal(nextRovingIndex(3, 1, 'Home'), 0)
  assert.equal(nextRovingIndex(3, 1, 'End'), 2)
  assert.equal(nextRovingIndex(0, 0, 'ArrowDown'), null)
  assert.equal(nextRovingIndex(3, 1, 'Enter'), null)
  assert.equal(nextRovingIndex(3, 0, 'ArrowLeft', 'rtl'), 1)
  assert.equal(nextRovingIndex(3, 1, 'ArrowRight', 'rtl'), 0)
  assert.equal(nextRovingIndex(3, 0, 'ArrowDown', 'rtl'), 1)
})
