import type { ApiResponse } from '../types'

function resolvePluginName(): string {
    if (window.__PLUGIN_NAME__) return window.__PLUGIN_NAME__
    try {
        if (window.parent && (window.parent as Window & { __PLUGIN_NAME__?: string }).__PLUGIN_NAME__) {
            return (window.parent as Window & { __PLUGIN_NAME__?: string }).__PLUGIN_NAME__!
        }
    } catch { /* ignore */ }
    const extMatch = location.pathname.match(/\/ext\/([^/]+)/)
    if (extMatch) return extMatch[1]
    const pluginMatch = location.pathname.match(/\/plugin\/([^/]+)/)
    if (pluginMatch) return pluginMatch[1]
    return 'napcat-plugin-template'
}

const PLUGIN_NAME = resolvePluginName()

const API_BASE_NO_AUTH = '/plugin/' + PLUGIN_NAME + '/api'
const API_BASE_AUTH = '/api/Plugin/ext/' + PLUGIN_NAME

function getToken(): string {
    // 登录态 token 只在需要认证的接口里使用。
    return localStorage.getItem('token') || ''
}

function authHeaders(h: Record<string, string> = {}): Record<string, string> {
    // 如果本地存了 token，就给认证请求补上 Authorization 头。
    const token = getToken()
    if (token) h['Authorization'] = 'Bearer ' + token
    return h
}

function buildUrl(base: string, path: string): string {
    // 所有接口都统一从当前站点 origin 拼接，避免相对路径歧义。
    return new URL(base + path, window.location.origin).toString()
}

/**
 * 无认证 API 请求
 * 用于插件自带 WebUI 页面调用后端 router.getNoAuth / router.postNoAuth 注册的路由
 */
export async function noAuthFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    // 插件自带 WebUI 默认走无认证路由，方便直接调用。
    const res = await fetch(buildUrl(API_BASE_NO_AUTH, path), {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
    }
    return res.json()
}

/**
 * 认证 API 请求
 * 用于需要 NapCat WebUI 登录认证的接口
 */
export async function authFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    // 如果要访问 NapCat 主 WebUI 的受保护接口，就用这个封装。
    const res = await fetch(buildUrl(API_BASE_AUTH, path), {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers, ...authHeaders() }
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
    }
    return res.json()
}
