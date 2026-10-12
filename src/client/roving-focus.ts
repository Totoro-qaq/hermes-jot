/**
 * Enter 或空格已经在 keydown 里打开菜单时，紧跟着的 detail 为 0 的 click 不要再关一次。
 * 读屏直接发出的 click 没有这次 keydown，仍然要打开菜单。
 */
export function styleMenuActivationIsDuplicate(detail: number, handledKeydown: boolean): boolean {
  return detail === 0 && handledKeydown
}

/** 只有 Enter 和空格会再发一次 click。方向键不会，不能拿来挡住之后的读屏点击。 */
export function styleMenuArmsClickDedupe(key: string): boolean {
  return key === 'Enter' || key === ' '
}

/**
 * Enter 和空格的 keydown 会 preventDefault，激活用的 click 不会来，标记不能只靠 click 清掉。
 * 下一拍一定清。keyup 再排到下一拍，这样 keyup 末尾补发的 click 仍能看见这次按键。
 * 方向键的 keyup 不清，避免把后来的 Enter 标记提前抹掉。
 */
export function styleMenuDedupeShouldRelease(phase: 'tick' | 'keyup', key: string): boolean {
  if (phase === 'tick') return true
  return key === 'Enter' || key === ' '
}

/** Escape 关掉样式菜单后，焦点回到「样式」按钮。 */
export function styleMenuDismissFocus(): 'trigger' {
  return 'trigger'
}

/** 键盘打开样式菜单时，焦点进入哪一端。鼠标点击不使用这个结果。 */
export function styleMenuKeyboardEdge(key: string): 'first' | 'last' | null {
  if (key === 'ArrowUp') return 'last'
  if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return 'first'
  return null
}

/** 菜单内方向键移动。index 为 -1 表示焦点还不在任何一项上。从右向左时左右键对调。 */
export function nextRovingIndex(count: number, index: number, key: string, direction: 'ltr' | 'rtl' = 'ltr'): number | null {
  if (count <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
  const backward = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
  if (key === 'ArrowDown' || key === forward) return index < 0 ? 0 : (index + 1) % count
  if (key === 'ArrowUp' || key === backward) return index <= 0 ? count - 1 : index - 1
  return null
}
