/** 菜单内方向键移动。index 为 -1 表示焦点还不在任何一项上。 */
export function nextRovingIndex(count: number, index: number, key: string): number | null {
  if (count <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown' || key === 'ArrowRight') return index < 0 ? 0 : (index + 1) % count
  if (key === 'ArrowUp' || key === 'ArrowLeft') return index <= 0 ? count - 1 : index - 1
  return null
}
