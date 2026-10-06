import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JotActionIcon, type JotActionIconName } from '../src/client/icons.js'

/** The shipped assets/icons/*.svg text for one action icon, generated from the component. */
export function actionIconSvg(name: JotActionIconName): string {
  const html = renderToStaticMarkup(createElement(JotActionIcon, { name, size: 24 }))
  const inner = html.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>$/u, '')
    .replace(/<(path|circle|rect)([^>]*)><\/\1>/gu, '<$1$2/>')
  let depth = 1
  const body = inner.split(/(?=<(?:path|circle|rect|g|\/g)[\s>])/u).map(part => {
    if (part.startsWith('</g')) depth--
    const line = `${'  '.repeat(depth)}${part}`
    if (part.startsWith('<g')) depth++
    return line
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">\n${body}\n</svg>\n`
}
