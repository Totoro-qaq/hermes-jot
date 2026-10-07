import type { ReactNode } from 'react'

/** Open Design K3's 24px grid, with review-led capture and format derivatives. */
export const JOT_ACTION_ICON_NAMES = [
  'attachment', 'back', 'capture', 'checklist', 'chevron-down', 'chevron-up', 'close',
  'duplicate', 'expand', 'export', 'folder', 'more', 'new-folder', 'new-note',
  'pin', 'redo', 'save', 'search', 'table', 'trash', 'undo',
  'previous', 'next', 'format', 'plus', 'rename', 'restore', 'sort', 'sidebar', 'sparkle',
  'ask', 'import',
] as const

export type JotActionIconName = typeof JOT_ACTION_ICON_NAMES[number]

export interface JotActionIconProps {
  name: JotActionIconName
  size?: number
  className?: string
}

const back = <><path d="M20 12H4.5" /><path d="M11 5.5 4.5 12l6.5 6.5" /></>
const shapes: Record<JotActionIconName, ReactNode> = {
  attachment: <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
  back,
  // Capture adds an excerpt: a quotation bar, its lines and a plus. It must not
  // resemble scissors (Cut) or a scan frame (screenshot / text recognition).
  capture: <><path d="M4 5.5v13" /><path d="M8 7.5h12M8 12h7M8 16.5h4.5" /><path d="M18 14.5v6M15 17.5h6" /></>,
  checklist: <><path d="M3.5 6.5 5 8l2.5-3M3.5 13.5 5 15l2.5-3" /><path d="M10.5 6.5h9.5M10.5 13.5h9.5M3.5 20h3M10.5 20h9.5" /></>,
  'chevron-down': <path d="M5.5 9.5 12 16l6.5-6.5" />,
  'chevron-up': <path d="M5.5 14.5 12 8l6.5 6.5" />,
  close: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  duplicate: <><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  expand: <><path d="M14 4h6v6M20 4 13.5 10.5M10 20H4v-6M4 20l6.5-6.5" /></>,
  export: <><path d="M12 15V3.5M7.5 7.5 12 3.5l4.5 4M4.5 13.5v5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" /></>,
  folder: <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2.5 2.8h7a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />,
  more: <g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></g>,
  'new-folder': <><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2.5 2.8h7a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" /><path d="M12 10.8v4.8M9.6 13.2h4.8" /></>,
  'new-note': <><path d="M15.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5zM15.5 3.5V8.5H19" /><path d="M12 11.5v5M9.5 14h5" /></>,
  pin: <><path d="M9 3.5h6M10 3.5v5.2L7 14h10l-3-5.3V3.5M12 14v6.5" /></>,
  redo: <><path d="M15.5 4.5 20 9l-4.5 4.5M20 9h-8.5a6.5 6.5 0 1 0 0 13H15" /></>,
  save: <><path d="M15.5 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM8.5 3.5v4h6v-4M7.5 20.5V15a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5.5" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M15.6 15.6 20.3 20.3" /></>,
  table: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M9.5 9.5v10M15.2 9.5v10" /></>,
  trash: <><path d="M4 6.5h16M9.5 6V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3V6M6 6.5l.9 12.3a2 2 0 0 0 2 1.7h6.2a2 2 0 0 0 2-1.7L18 6.5M10.2 10.5v6M13.8 10.5v6" /></>,
  undo: <><path d="M8.5 4.5 4 9l4.5 4.5M4 9h8.5a6.5 6.5 0 1 1 0 13H9" /></>,
  previous: back,
  next: <g transform="rotate(180 12 12)">{back}</g>,
  format: <><path d="m3.5 20 5-16 5 16M5.2 14.5h6.6M17 6h3.5M17 12h3.5M17 18h3.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  rename: <><path d="M15.2 4.8a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /><path d="m13.5 6.5 3 3" /></>,
  restore: <><path d="M4 12a8 8 0 1 0 8-8 8.7 8.7 0 0 0-6 2.5L4 8.5" /><path d="M4 4v4.5h4.5" /></>,
  sort: <><path d="M7 4.5v15M3.5 16 7 19.5l3.5-3.5" /><path d="M13 6.5h7.5M13 12h5.5M13 17.5h3.5" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></>,
  // A conversation bubble with the AI sparkle: hand this note to the agent.
  ask: <><path d="M20 12.5V17a2 2 0 0 1-2 2h-7l-4.5 3v-3H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /><path d="M17.5 2.5c.4 2 1.1 2.7 3 3.2-1.9.5-2.6 1.2-3 3.2-.4-2-1.1-2.7-3-3.2 1.9-.5 2.6-1.2 3-3.2z" /></>,
  import: <><path d="M12 3.5V15M7.5 10.5 12 15l4.5-4.5M4.5 13.5v5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" /></>,
  sparkle: <><path d="M11 3.5c.6 3.8 1.9 5.2 5.5 6.2-3.6 1-4.9 2.4-5.5 6.2-.6-3.8-1.9-5.2-5.5-6.2 3.6-1 4.9-2.4 5.5-6.2z" /><path d="M18.5 15v5M16 17.5h5" /></>,
}

/** Decorative artwork only: its button or menu item supplies the accessible name. */
export function JotActionIcon({ name, size = 16, className }: JotActionIconProps) {
  return <svg viewBox="0 0 24 24" width={size} height={size}
    className={['jot-action-icon', className].filter(Boolean).join(' ')}
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" style={{ display: 'block', flex: 'none', width: size, height: size }}>
    {shapes[name]}
  </svg>
}
