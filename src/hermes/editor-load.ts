/** 编辑器 iframe 的加载状态。Retry 只在失败后把 attempt 加一，真正的重新请求由 effect 发出。 */
export interface EditorLoadState {
  error: '' | 'unavailable' | 'failed'
  source: string
  attempt: number
}

export type EditorLoadAction =
  | { type: 'missing-loader' }
  | { type: 'start' }
  | { type: 'loaded'; source: string }
  | { type: 'failed' }
  | { type: 'retry' }

export const initialEditorLoad: EditorLoadState = { error: '', source: '', attempt: 0 }

export function reduceEditorLoad(state: EditorLoadState, action: EditorLoadAction): EditorLoadState {
  switch (action.type) {
    case 'missing-loader': return { ...state, error: 'unavailable' }
    case 'start': return { ...state, error: '' }
    case 'loaded': return { ...state, error: '', source: action.source }
    case 'failed': return { ...state, error: 'failed' }
    case 'retry': return state.error === 'failed' ? { ...state, attempt: state.attempt + 1 } : state
  }
}

/** 只有加载失败才提供重试；后端缺失时重试也没有加载函数。 */
export function editorLoadOffersRetry(state: EditorLoadState): boolean {
  return state.error === 'failed'
}
