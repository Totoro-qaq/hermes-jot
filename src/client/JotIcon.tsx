export interface JotIconProps {
  /** The native sidebar asks for 16px expanded and 18px in its compact rail. */
  size?: number
  active?: boolean
  className?: string
}

/**
 * Bamboo cover, warm paper and a golden bookmark that rises above the cover,
 * with a check on the page. The broken outline and the check keep the mark
 * distinct from document or spreadsheet file icons at 16px.
 */
export function JotIcon({ size = 18, active = false, className }: JotIconProps) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className}
    aria-hidden="true" focusable="false" style={{ display: 'block', flex: 'none' }}>
    <rect x="3.5" y="3.5" width="17" height="18.5" rx="2.5" fill={active ? '#28765F' : '#3B8C76'} />
    <path d="M7 3.5V22H6a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 6 3.5h1Z" fill="#185F50" />
    <rect x="7" y="5" width="12" height="15.5" rx="1.25" fill="#FFF9EA" />
    <path d="M13.5 1h4v9.5l-2-1.5-2 1.5V1Z" fill="#E6AD54" />
    <path d="m9.4 14 1.8 1.8 3.4-3.6M9.4 18.2h6.2" fill="none" stroke="#286B5D" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
