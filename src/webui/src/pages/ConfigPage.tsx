import { useState, useEffect, useCallback, useRef } from 'react'
import { noAuthFetch } from '../utils/api'
import { showToast } from '../hooks/useToast'
import { QrCodeLoginStatus } from '../types'
import type { BiliLoginState, PluginConfig, QrCodeGenerateResult, QrCodePollResult } from '../types'
import { IconTerminal } from '../components/icons'

interface QrCodeUiState {
    url: string
    imgUrl: string
    qrcodeKey: string
    generating: boolean
    loading: boolean
    status: QrCodeLoginStatus | ''
    statusText: string
    isExpired: boolean
}

const DEFAULT_QR_STATE: QrCodeUiState = {
    url: '',
    imgUrl: '',
    qrcodeKey: '',
    generating: false,
    loading: false,
    status: '',
    statusText: '',
    isExpired: false,
}

export default function ConfigPage() {
    const [config, setConfig] = useState<PluginConfig | null>(null)
    const [saving, setSaving] = useState(false)
    const [loginState, setLoginState] = useState<BiliLoginState | null>(null)
    const [cookieDraft, setCookieDraft] = useState('')
    const [testingLogin, setTestingLogin] = useState(false)
    const [qrCode, setQrCode] = useState<QrCodeUiState>(DEFAULT_QR_STATE)
    const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const stopQrPolling = useCallback(() => {
        if (qrTimerRef.current) {
            clearInterval(qrTimerRef.current)
            qrTimerRef.current = null
        }
    }, [])

    const syncLoginState = useCallback(async () => {
        try {
            const res = await noAuthFetch<BiliLoginState>('/login/status')
            if (res.code === 0 && res.data) {
                setLoginState(res.data)
                return res.data
            }
        } catch {
            // ignore
        }
        return null
    }, [])

    const fetchConfig = useCallback(async () => {
        // 配置页打开时先从后端拉取当前配置，确保编辑的是最新值。
        try {
            const res = await noAuthFetch<PluginConfig>('/config')
            if (res.code === 0 && res.data) {
                setConfig(res.data)
                setCookieDraft(res.data.cookie || '')
            }
        } catch { showToast('获取配置失败', 'error') }
    }, [])

    const fetchLoginState = syncLoginState

    useEffect(() => {
        fetchConfig()
        fetchLoginState()
    }, [fetchConfig, fetchLoginState])

    useEffect(() => {
        return () => {
            stopQrPolling()
        }
    }, [stopQrPolling])

    const saveConfig = useCallback(async (update: Partial<PluginConfig>) => {
        // 保存时先合并本地配置，再整份回传给后端。
        if (!config) return
        setSaving(true)
        try {
            const newConfig = { ...config, ...update }
            await noAuthFetch('/config', {
                method: 'POST',
                body: JSON.stringify(newConfig),
            })
            setConfig(newConfig)
            showToast('配置已保存', 'success')
        } catch {
            showToast('保存失败', 'error')
        } finally {
            setSaving(false)
        }
    }, [config])

    const saveCookie = useCallback(async () => {
        if (!config) return
        const cookie = cookieDraft.trim()
        if (!cookie) {
            showToast('请输入 Bilibili Cookie', 'error')
            return
        }
        setTestingLogin(true)
        try {
            const res = await noAuthFetch<{ login: BiliLoginState; config: PluginConfig }>('/login/cookie', {
                method: 'POST',
                body: JSON.stringify({ cookie }),
            })
            if (res.code === 0 && res.data) {
                setConfig(res.data.config)
                setCookieDraft(res.data.config.cookie || '')
                setLoginState(res.data.login)
                showToast('Cookie 已验证并保存', 'success')
                return
            }
            showToast(res.message || 'Cookie 校验失败', 'error')
        } catch (error) {
            showToast(error instanceof Error ? error.message : 'Cookie 校验失败', 'error')
        } finally {
            setTestingLogin(false)
        }
    }, [config, cookieDraft])

    const refreshConfigAndLogin = useCallback(async () => {
        await Promise.all([fetchConfig(), syncLoginState()])
    }, [fetchConfig, syncLoginState])

    const pollQrCode = useCallback(async (qrcodeKey: string) => {
        try {
            const res = await noAuthFetch<QrCodePollResult>(`/login/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`)
            const data = res.data
            if (res.code !== 0 || !data) {
                return
            }

            const nextStatusText = data.statusText || data.message || '等待扫码...'
            setQrCode((prev) => ({
                ...prev,
                status: data.status,
                statusText: nextStatusText,
                isExpired: Boolean(data.isExpired),
            }))

            if (data.isSuccess) {
                stopQrPolling()
                setQrCode((prev) => ({
                    ...prev,
                    statusText: '登录成功，正在同步状态...',
                    isExpired: false,
                    loading: false,
                }))
                await refreshConfigAndLogin()
                showToast('二维码登录成功', 'success')
                return
            }

            if (data.isExpired) {
                stopQrPolling()
                setQrCode((prev) => ({
                    ...prev,
                    isExpired: true,
                    loading: false,
                    statusText: '二维码已过期，请刷新',
                }))
            }
        } catch {
            // 轮询失败不阻断 UI，只保留当前状态。
        }
    }, [refreshConfigAndLogin, stopQrPolling])

    const startQrPolling = useCallback((qrcodeKey: string) => {
        stopQrPolling()
        void pollQrCode(qrcodeKey)
        qrTimerRef.current = setInterval(() => {
            void pollQrCode(qrcodeKey)
        }, 2000)
    }, [pollQrCode, stopQrPolling])

    const generateQrCode = useCallback(async () => {
        if (qrCode.generating) return
        stopQrPolling()
        setQrCode({
            ...DEFAULT_QR_STATE,
            generating: true,
            loading: true,
            statusText: '正在生成二维码...',
        })

        try {
            const res = await noAuthFetch<QrCodeGenerateResult>('/login/qrcode/generate', {
                method: 'POST',
            })
            const data = res.data
            if (res.code !== 0 || !data) {
                showToast(res.message || '生成二维码失败', 'error')
                setQrCode(DEFAULT_QR_STATE)
                return
            }

            const imgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data.url)}`
            setQrCode({
                url: data.url,
                imgUrl,
                qrcodeKey: data.qrcode_key,
                generating: false,
                loading: true,
                status: QrCodeLoginStatus.WAITING,
                statusText: '请使用 B 站 App 扫描二维码',
                isExpired: false,
            })
            startQrPolling(data.qrcode_key)
        } catch (error) {
            showToast(error instanceof Error ? error.message : '生成二维码失败', 'error')
            setQrCode(DEFAULT_QR_STATE)
        }
    }, [qrCode.generating, startQrPolling, stopQrPolling])

    const updateField = <K extends keyof PluginConfig>(key: K, value: PluginConfig[K]) => {
        // UI 先乐观更新，再异步保存，用户体验更顺滑。
        if (!config) return
        const updated = { ...config, [key]: value }
        setConfig(updated)
        saveConfig({ [key]: value })
    }

    if (!config) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">加载配置中...</div>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-6 stagger-children">
            {/* 基础配置：目前只暴露最常用的几个字段。 */}
            <div className="card p-5 hover-lift">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-5">
                    <IconTerminal size={16} className="text-gray-400" />
                    基础配置
                </h3>
                <div className="space-y-5">
                    <ToggleRow
                        label="启用插件"
                        desc="全局开关，关闭后不响应任何命令"
                        checked={config.enabled}
                        onChange={(v) => updateField('enabled', v)}
                    />
                    <ToggleRow
                        label="调试模式"
                        desc="启用后输出详细日志到控制台"
                        checked={config.debug}
                        onChange={(v) => updateField('debug', v)}
                    />
                    <InputRow
                        label="命令前缀"
                        desc="触发命令的前缀"
                        value={config.commandPrefix}
                        onChange={(v) => updateField('commandPrefix', v)}
                    />
                    <InputRow
                        label="冷却时间 (秒)"
                        desc="同一命令请求冷却时间，0 表示不限制"
                        value={String(config.cooldownSeconds)}
                        type="number"
                        onChange={(v) => updateField('cooldownSeconds', Number(v) || 0)}
                    />
                    <CookieRow
                        cookie={cookieDraft}
                        onChange={setCookieDraft}
                        onSave={saveCookie}
                        saving={testingLogin}
                        loginState={loginState}
                    />
                </div>
            </div>

            <div className="card p-5 hover-lift">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">二维码登录</h3>
                <div className="grid gap-4 lg:grid-cols-[220px,1fr] items-center">
                    <div className="relative w-[220px] h-[220px] mx-auto lg:mx-0 rounded-2xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#111113] flex items-center justify-center">
                        {!qrCode.url && !qrCode.generating && !qrCode.isExpired && (
                            <button
                                type="button"
                                className="w-full h-full flex flex-col items-center justify-center gap-3 hover:bg-gray-100 dark:hover:bg-[#19191c] transition-colors"
                                onClick={generateQrCode}
                            >
                                <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center text-2xl font-bold">
                                    Q
                                </div>
                                <span className="text-xs text-gray-500 dark:text-gray-400">点击生成二维码</span>
                            </button>
                        )}

                        {qrCode.generating && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/90 dark:bg-black/40">
                                <div className="loading-spinner text-primary" />
                                <span className="text-xs text-gray-500 mt-3">生成中...</span>
                            </div>
                        )}

                        {qrCode.imgUrl && !qrCode.generating && !qrCode.isExpired && (
                            <img
                                src={qrCode.imgUrl}
                                alt="Bilibili 登录二维码"
                                className="w-full h-full object-contain bg-white"
                                referrerPolicy="no-referrer"
                            />
                        )}

                        {qrCode.isExpired && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/95 dark:bg-black/60 px-4 text-center">
                                <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 flex items-center justify-center mb-2">
                                    !
                                </div>
                                <div className="text-sm text-gray-600 dark:text-gray-300">二维码已过期</div>
                                <button type="button" className="btn-primary mt-3" onClick={generateQrCode} disabled={qrCode.generating}>
                                    刷新二维码
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="space-y-3">
                        <div>
                            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">扫码登录说明</div>
                            <div className="text-xs text-gray-400 mt-1">使用 B 站 App 扫码确认后，插件会自动保存 Cookie 并刷新当前登录状态。</div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={`px-2 py-1 rounded-full ${loginState?.loggedIn ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                                {loginState?.loggedIn ? '已登录' : '未登录'}
                            </span>
                            <span className="text-gray-500 dark:text-gray-400">
                                {qrCode.statusText || '等待生成二维码'}
                            </span>
                        </div>

                        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#111113] p-4 text-sm text-gray-600 dark:text-gray-300">
                            {loginState?.loggedIn ? (
                                <div className="space-y-1">
                                    <div>当前账号：{loginState.account?.name || loginState.account?.userId || '未知'}</div>
                                    <div className="text-xs text-gray-400">二维码登录成功后会覆盖当前 Cookie。</div>
                                </div>
                            ) : (
                                <div>二维码登录成功后，Cookie 会自动回写到配置中；如果二维码过期，点击刷新即可重新生成。</div>
                            )}
                        </div>

                        <div className="flex flex-wrap gap-3">
                            <button type="button" className="btn-primary" onClick={generateQrCode} disabled={qrCode.generating}>
                                {qrCode.generating ? '生成中...' : '生成二维码'}
                            </button>
                            {qrCode.loading && qrCode.qrcodeKey && !qrCode.isExpired && (
                                <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={() => pollQrCode(qrCode.qrcodeKey)}
                                >
                                    手动刷新状态
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {saving && (
                <div className="saving-indicator fixed bottom-4 right-4 bg-primary text-white text-xs px-3 py-2 rounded-lg shadow-lg flex items-center gap-2">
                    <div className="loading-spinner !w-3 !h-3 !border-[1.5px]" />
                    保存中...
                </div>
            )}
        </div>
    )
}

/* ---- 子组件 ---- */

function ToggleRow({ label, desc, checked, onChange }: {
    label: string; desc: string; checked: boolean; onChange: (v: boolean) => void
}) {
    // 布尔配置统一使用开关，避免输入框带来的歧义。
    return (
        <div className="flex items-center justify-between">
            <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
            </div>
            <label className="toggle">
                <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
                <div className="slider" />
            </label>
        </div>
    )
}

function InputRow({ label, desc, value, type = 'text', onChange }: {
    label: string; desc: string; value: string; type?: string; onChange: (v: string) => void
}) {
    // 输入框做本地缓存，只有失焦或回车时才提交到后端。
    const [local, setLocal] = useState(value)
    useEffect(() => { setLocal(value) }, [value])

    const handleBlur = () => {
        if (local !== value) onChange(local)
    }

    return (
        <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">{label}</div>
            <div className="text-xs text-gray-400 mb-2">{desc}</div>
            <input
                className="input-field"
                type={type}
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={(e) => e.key === 'Enter' && handleBlur()}
            />
        </div>
    )
}

function CookieRow({
    cookie,
    onChange,
    onSave,
    saving,
    loginState,
}: {
    cookie: string
    onChange: (v: string) => void
    onSave: () => void
    saving: boolean
    loginState: BiliLoginState | null
}) {
    return (
        <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-3">
            <div>
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">Bilibili Cookie</div>
                <div className="text-xs text-gray-400">
                    先输入完整 Cookie，再点击“验证并保存”。校验成功后才会写入配置。
                </div>
            </div>
            <textarea
                className="input-field min-h-[96px] resize-y"
                value={cookie}
                onChange={(e) => onChange(e.target.value)}
                placeholder="SESSDATA=...; bili_jct=..."
            />
            <div className="flex items-center gap-3 flex-wrap">
                <button
                    type="button"
                    className="btn-primary"
                    onClick={onSave}
                    disabled={saving}
                >
                    {saving ? '验证中...' : '验证并保存'}
                </button>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                    {loginState
                        ? (loginState.loggedIn
                            ? `当前已登录：${loginState.account?.name || loginState.account?.userId || '未知账号'}`
                            : `当前未登录：${loginState.message}`)
                        : '尚未检查登录状态'}
                </div>
            </div>
        </div>
    )
}
