import { useEffect } from 'react'

export function useTheme() {
    useEffect(() => {
        // 跟随系统暗色模式切换，并把结果同步到根节点 class。
        const update = () => {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
            document.documentElement.classList.toggle('dark', isDark)
        }
        update()
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        mq.addEventListener('change', update)
        return () => mq.removeEventListener('change', update)
    }, [])
}
