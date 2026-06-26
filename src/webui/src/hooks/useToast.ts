import { useSyncExternalStore } from 'react'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
    id: number
    message: string
    type: ToastType
    hiding?: boolean
}

let toasts: Toast[] = []
let toastId = 0
const listeners = new Set<() => void>()

function emitChange() {
    // 采用外部 store 模式，组件只负责订阅变化。
    listeners.forEach(fn => fn())
}

function subscribe(listener: () => void) {
    // useSyncExternalStore 需要一个标准订阅入口。
    listeners.add(listener)
    return () => listeners.delete(listener)
}

function getSnapshot() {
    // 当前快照直接返回内存中的 toast 列表。
    return toasts
}

export function addToast(message: string, type: ToastType = 'info') {
    // toast 自动在几秒后淡出并删除，不需要业务层手动清理。
    const id = ++toastId
    toasts = [...toasts, { id, message, type }]
    emitChange()
    setTimeout(() => {
        toasts = toasts.map(t => t.id === id ? { ...t, hiding: true } : t)
        emitChange()
        setTimeout(() => {
            toasts = toasts.filter(t => t.id !== id)
            emitChange()
        }, 350)
    }, 3000)
}

export function useToasts() {
    // WebUI 的提示列表通过同步外部存储实现，刷新不会丢状态。
    return useSyncExternalStore(subscribe, getSnapshot)
}

export const showToast = (message: string, type: ToastType = 'info') => addToast(message, type)
