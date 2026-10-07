import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askAgentMessage, askAgentReference, deliverAskAgent } from '../src/client/ask-agent.js'

test('the reference names the note and carries the id the agent reads it by', () => {
  assert.equal(askAgentReference({ id: 'n-123', title: 'Trip plan' }), 'Jot note “Trip plan” (id: n-123)')
  assert.equal(askAgentReference({ id: 'n-1', title: '' }), 'Jot note “Untitled” (id: n-1)')
  assert.equal(askAgentReference({ id: 'n-2', title: '  \n ' }), 'Jot note “Untitled” (id: n-2)')
  assert.equal(askAgentReference({ id: 'n-3', title: 'Line\none' }), 'Jot note “Line one” (id: n-3)')
})

test('the message box is preferred, then the clipboard', async () => {
  const sent: string[] = []
  const insert = async (text: string) => { sent.push(`insert:${text}`); return true }
  const copy = async (text: string) => { sent.push(`copy:${text}`); return true }
  assert.equal(await deliverAskAgent('ref', { insert, copy }), 'inserted')
  assert.deepEqual(sent, ['insert:ref'])
  assert.equal(await deliverAskAgent('ref', { insert: async () => false, copy }), 'copied')
  assert.equal(await deliverAskAgent('ref', { insert: async () => { throw new Error('bus') }, copy }), 'copied')
  assert.equal(await deliverAskAgent('ref', { copy }), 'copied', 'older hosts have no composer')
})

test('nothing delivered is reported as a failure, never as success', async () => {
  assert.equal(await deliverAskAgent('ref', { insert: async () => false, copy: async () => false }), 'failed')
  assert.equal(await deliverAskAgent('ref', { copy: () => { throw new TypeError('no os') } }), 'failed')
  assert.equal(await deliverAskAgent('ref', {}), 'failed')
})

test('outcome copy is localized', () => {
  assert.equal(askAgentMessage('inserted', 'en'), 'Added to the message box')
  assert.equal(askAgentMessage('inserted', 'zh'), '已放进输入框')
  assert.equal(askAgentMessage('copied', 'en'), 'Copied — paste it into a conversation')
  assert.equal(askAgentMessage('copied', 'zh'), '已复制，可粘贴到对话中')
  assert.match(askAgentMessage('failed', 'en'), /Try again/)
})
