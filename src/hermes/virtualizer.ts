import { useLayoutEffect, useReducer, useState } from 'react'
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect, type VirtualizerOptions } from '@tanstack/virtual-core'

export { defaultRangeExtractor } from '@tanstack/virtual-core'

/**
 * React adapter for the MIT-licensed TanStack virtual-core, using batched React
 * updates (the upstream adapter's supported useFlushSync=false behavior).
 * Hermes exposes its React singleton, but does not expose ReactDOM.flushSync;
 * bundling another ReactDOM would neither share the host renderer nor load as ESM.
 */
export function useVirtualizer<TScroll extends Element, TItem extends Element>(
  options: Omit<VirtualizerOptions<TScroll, TItem>, 'observeElementRect' | 'observeElementOffset' | 'scrollToFn'>,
): Virtualizer<TScroll, TItem> {
  const rerender = useReducer((value: number) => value + 1, 0)[1]
  const resolved: VirtualizerOptions<TScroll, TItem> = {
    observeElementRect, observeElementOffset, scrollToFn: elementScroll,
    ...options,
    onChange: (instance, synchronous) => { rerender(); options.onChange?.(instance, synchronous) },
  }
  const [instance] = useState(() => new Virtualizer<TScroll, TItem>(resolved))
  instance.setOptions(resolved)
  useLayoutEffect(() => instance._didMount(), [instance])
  useLayoutEffect(() => instance._willUpdate())
  return instance
}
