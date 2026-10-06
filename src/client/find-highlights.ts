import type { DocumentMatch } from './document-find.js'

/** Keep DOM decorations bounded while navigation and replacement retain every match. */
export function highlightWindow(matches: readonly DocumentMatch[], active: number, limit = 256) {
  const current = Math.min(Math.max(0, active), Math.max(0, matches.length - 1))
  const start = Math.max(0, Math.min(current - Math.floor(limit / 2), matches.length - limit))
  return { start, matches: matches.slice(start, start + limit) }
}
