import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JOT_ACTION_ICON_NAMES } from '../src/client/icons.js'
import { actionIconSvg } from '../dev/icon-assets.js'

test('shipped action SVGs match the icons rendered by the plugin', async () => {
  for (const name of JOT_ACTION_ICON_NAMES) {
    const shipped = (await readFile(new URL(`../assets/icons/${name}.svg`, import.meta.url), 'utf8')).replace(/\r\n/gu, '\n')
    assert.equal(shipped, actionIconSvg(name), `assets/icons/${name}.svg is stale; run pnpm icons`)
  }
})

test('the product mark in the README and the shipped assets share one geometry', async () => {
  const readme = await readFile(new URL('../assets/readme/jot-icon.svg', import.meta.url), 'utf8')
  const product = await readFile(new URL('../assets/icons/product.svg', import.meta.url), 'utf8')
  assert.equal(readme, product)
})
