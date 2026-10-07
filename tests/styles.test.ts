import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { jotStyles } from '../src/client/styles.js'
import { HOST_THEME_PROPERTIES } from '../src/hermes/theme.js'

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string, css = jotStyles): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`(?:^|[}\\n])${escaped}\\{([^}]*)\\}`, 'u').exec(css)
  assert.ok(match, `no rule for ${selector}`)
  return match[1]!
}

test('page header and pane topbar are one 1.75rem row with a tertiary inset hairline', () => {
  for (const selector of ['.jot-workbench-header', '.jot-topbar']) {
    const body = rule(selector)
    assert.match(body, /(?:^|;)height:1\.75rem(?:;|$)/u, selector)
    assert.match(body, /(?:^|;)min-height:1\.75rem(?:;|$)/u, selector)
    assert.match(body, /box-sizing:border-box/u, selector)
    assert.match(body, /box-shadow:inset 0 -1px 0 var\(--jot-line\)/u, selector)
    assert.doesNotMatch(body, /(?:^|;)border[-:]/u, `${selector} draws its divider as a shadow, not a border`)
  }
  assert.doesNotMatch(rule('.jot-compact .jot-topbar'), /height/u, 'the compact topbar keeps the shared height')
  assert.match(rule('[data-tree-group][data-zone-header] .jot-topbar'), /box-shadow:none/u)
  assert.match(jotStyles, /--jot-line:var\(--dsw-alias-border-l3,/u)
  assert.equal(HOST_THEME_PROPERTIES['--dsw-alias-border-l3'], 'var(--ui-stroke-tertiary)')
})

test('header contents use the host row metrics', () => {
  assert.match(rule('.jot-workbench-header>svg'), /width:16px;height:16px/u)
  assert.match(rule('.jot-workbench-header .jot-brand'), /font-size:13px;font-weight:600/u)
  assert.match(rule(':is(.jot-workbench-header,.jot-topbar) :is(.jot-btn,.jot-icon-btn,.jot-back)'), /height:24px;min-height:24px/u)
  assert.match(rule(':is(.jot-workbench-header,.jot-topbar) .jot-icon-btn'), /width:24px/u)
})

test('dividers, footer row and surfaces follow the Hermes chrome', async () => {
  assert.match(rule('.jot-list-panel'), /border-inline-end:1px solid var\(--jot-line\)/u)
  const agent = rule('.jot-agent-line')
  assert.match(agent, /(?:^|;)height:28px/u)
  assert.doesNotMatch(agent, /(?:^|;)border[-:]/u)
  assert.match(rule('.jot-app'), /background:var\(--jot-surface,var\(--jot-bg\)\)/u)
  assert.equal(HOST_THEME_PROPERTIES['--jot-surface'], 'var(--ui-editor-surface-background,var(--ui-bg-editor))')
  assert.equal(HOST_THEME_PROPERTIES['--dsw-alias-bg-layer-1'], 'var(--ui-bg-editor)', 'popovers and modals stay elevated')
  const entry = await readFile(new URL('../src/hermes/entry.tsx', import.meta.url), 'utf8')
  assert.match(entry, /\.jot-host>\.jot-app\{[^}]*background:var\(--ui-editor-surface-background,var\(--ui-bg-editor\)\)/u)
})

test('styles use logical properties wherever direction matters', () => {
  const physical = [
    /(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b/gu,
    /text-align:(?:left|right)\b/gu,
    /float:(?:left|right)\b/gu,
    /clear:(?:left|right)\b/gu,
  ].flatMap(pattern => [...jotStyles.matchAll(pattern)].map(match => match[0]))
  assert.deepEqual(physical, [])
  // Bare left/right insets are allowed only for direction-neutral centering.
  for (const match of jotStyles.matchAll(/[{;](left|right):([^;}]*)/gu)) {
    assert.equal(`${match[1]}:${match[2]}`, 'left:50%', `physical inset ${match[0]}`)
    assert.match(jotStyles.slice(match.index, jotStyles.indexOf('}', match.index)), /translateX\(-50%\)/u)
  }
  // A four-value padding or margin with different left and right sides is direction-dependent.
  for (const match of jotStyles.matchAll(/[{;](padding|margin):([^;}]*)/gu)) {
    const sides = match[2]!.replace(/!important/u, '').trim().match(/calc\([^)]*\)|\S+/gu) ?? []
    assert.ok(sides.length < 4 || sides[1] === sides[3], `asymmetric ${match[0]}`)
  }
})

test('pointing icons mirror in right-to-left languages and the placeholder follows the editor', () => {
  assert.match(jotStyles, /\[dir=rtl\] \.jot-back \.jot-action-icon,\.jot-back \.jot-action-icon:dir\(rtl\)\{transform:scaleX\(-1\)\}/u)
  assert.match(jotStyles, /content:attr\(data-placeholder\)/u)
  assert.doesNotMatch(jotStyles, /Start writing|从这里开始记/u)
})
