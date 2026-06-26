import type {
    BiliDynamicItem,
    BiliLiveInfo,
    BiliLoginState,
    BiliPublisher,
    LiveStatus,
    QrCodeGenerateResult,
    QrCodePollResult,
} from '../types';
import { QrCodeLoginStatus } from '../types';
import { pluginState } from '../core/state';

const BILI_HOME = 'https://www.bilibili.com';
const API_HOME = 'https://api.bilibili.com';
const LIVE_API_HOME = 'https://api.live.bilibili.com';
const PASSPORT_HOME = 'https://passport.bilibili.com';

const QRCODE_GENERATE_API = `${PASSPORT_HOME}/x/passport-login/web/qrcode/generate`;
const QRCODE_POLL_API = `${PASSPORT_HOME}/x/passport-login/web/qrcode/poll`;

const QRCODE_TIMEOUT = 180 * 1000;

let currentQrSession: {
    qrcodeKey: string;
    url: string;
    createTime: number;
} | null = null;

// B 站接口返回字段层级不稳定，这里统一做基础归一化和容错读取。
function normalizeUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text) return undefined;
    if (text.startsWith('//')) return `https:${text}`;
    if (text.startsWith('/')) return `${BILI_HOME}${text}`;
    return text;
}

function getByPath(value: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
        if (current && typeof current === 'object' && key in current) {
            return (current as Record<string, unknown>)[key];
        }
        return undefined;
    }, value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickString(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return fallback;
}

function pickNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function parseLoginCookieFromUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        const sessdata = parsed.searchParams.get('SESSDATA')?.trim() || '';
        const biliJct = parsed.searchParams.get('bili_jct')?.trim() || '';
        const dedeUserId = parsed.searchParams.get('DedeUserID')?.trim() || '';
        if (!sessdata || !biliJct || !dedeUserId) return null;
        return `SESSDATA=${sessdata}; bili_jct=${biliJct}; DedeUserID=${dedeUserId}`;
    } catch {
        return null;
    }
}

function buildQrResult(
    status: QrCodeLoginStatus,
    message: string,
    extra: Partial<QrCodePollResult> = {},
): QrCodePollResult {
    return {
        status,
        message,
        statusText: extra.statusText ?? message,
        isSuccess: extra.isSuccess ?? status === QrCodeLoginStatus.SUCCESS,
        isExpired: extra.isExpired ?? status === QrCodeLoginStatus.EXPIRED,
        isScanned: extra.isScanned ?? status === QrCodeLoginStatus.SCANNED,
        login: extra.login,
    };
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    // 所有请求统一带上 UA、Referer 和可选 Cookie，降低被拦截概率。
    const extraHeaders = (init.headers as Record<string, string> | undefined) || {};
    const headers: Record<string, string> = {
        'User-Agent': pluginState.config.userAgent,
        Referer: BILI_HOME,
        Accept: 'application/json, text/plain, */*',
        ...extraHeaders,
    };
    if (pluginState.config.cookie && !('Cookie' in extraHeaders) && !('cookie' in extraHeaders)) {
        headers.Cookie = pluginState.config.cookie;
    }

    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
        throw new Error(`Bilibili request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as Record<string, unknown>;
    const code = Number(data.code ?? 0);
    if (code !== 0) {
        throw new Error(`Bilibili API error ${code}: ${data.message ?? data.msg ?? 'unknown'}`);
    }
    return data as T;
}

function toLoginState(cookiePresent: boolean, message: string, account?: BiliLoginState['account']): BiliLoginState {
    return {
        loggedIn: Boolean(account?.userId),
        message,
        cookiePresent,
        account,
    };
}

async function applyRequestDelay(): Promise<void> {
    // 连续请求之间留一点间隔，避免过于密集触发风控。
    const delayMs = Math.max(0, pluginState.config.requestIntervalSeconds * 1000);
    if (delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function callWithDelay<T>(block: () => Promise<T>): Promise<T> {
    // 不管请求成功还是失败，后面都补一个延迟，避免 burst 请求。
    try {
        return await block();
    } finally {
        await applyRequestDelay();
    }
}

export async function resolvePublisher(query: string): Promise<BiliPublisher | null> {
    // 数字直接按 UID 处理，非数字先走搜索再取第一个匹配项。
    const keyword = query.trim();
    if (!keyword) return null;
    if (/^\d+$/.test(keyword)) {
        return fetchPublisherByUid(keyword);
    }
    const matches = await searchPublishers(keyword, 1);
    return matches[0] ?? null;
}

export async function fetchPublisherByUid(uid: string): Promise<BiliPublisher | null> {
    // 通过空间卡片接口获取 UP 主头像和昵称。
    const url = `${API_HOME}/x/web-interface/card?mid=${encodeURIComponent(uid)}&photo=true`;
    const json = await callWithDelay(() => requestJson<{ data?: unknown }>(url));
    const card = asRecord(getByPath(json, 'data.card'));
    const mid = pickString(card.mid, uid);
    if (!mid || mid === '0') return null;
    return {
        uid: mid,
        name: pickString(card.name, uid),
        face: normalizeUrl(card.face),
    };
}

export async function fetchLoginState(cookie = pluginState.config.cookie): Promise<BiliLoginState> {
    const cookieValue = cookie.trim();
    if (!cookieValue) {
        return toLoginState(false, '未配置 Bilibili Cookie');
    }

    try {
        const json = await callWithDelay(() => requestJson<{ data?: unknown }>(
            `${API_HOME}/x/web-interface/nav`,
            {
                headers: { Cookie: cookieValue },
            },
        ));
        const nav = asRecord(json.data);
        const isLogin = Boolean(nav.isLogin ?? nav.is_login);
        const mid = pickString(nav.mid, pickString(nav.uid));
        if (!isLogin || !mid || mid === '0') {
            return toLoginState(true, 'Bilibili 未登录');
        }
        return toLoginState(true, '登录成功', {
            userId: mid,
            name: pickString(nav.uname),
            avatar: normalizeUrl(nav.face),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toLoginState(true, message || '登录状态检查失败');
    }
}

export async function generateQrCode(): Promise<QrCodeGenerateResult | null> {
    try {
        const json = await requestJson<{ data?: unknown }>(QRCODE_GENERATE_API, {
            headers: {
                Referer: BILI_HOME,
                'User-Agent': pluginState.config.userAgent,
            },
        });
        const data = asRecord(json.data);
        const url = pickString(data.url);
        const qrcodeKey = pickString(data.qrcode_key);
        if (!url || !qrcodeKey) return null;
        currentQrSession = {
            qrcodeKey,
            url,
            createTime: Date.now(),
        };
        return { url, qrcode_key: qrcodeKey };
    } catch (error) {
        pluginState.log('error', '生成二维码异常', error);
        return null;
    }
}

export function getQrSessionStatus(): {
    hasSession: boolean;
    isExpired: boolean;
    remainingTime: number;
} {
    if (!currentQrSession) {
        return { hasSession: false, isExpired: true, remainingTime: 0 };
    }
    const elapsed = Date.now() - currentQrSession.createTime;
    const remaining = Math.max(0, QRCODE_TIMEOUT - elapsed);
    return {
        hasSession: true,
        isExpired: remaining <= 0,
        remainingTime: Math.floor(remaining / 1000),
    };
}

export async function pollQrCodeStatus(qrcodeKey?: string): Promise<QrCodePollResult> {
    const key = qrcodeKey || currentQrSession?.qrcodeKey;
    if (!key) {
        currentQrSession = null;
        return buildQrResult(QrCodeLoginStatus.EXPIRED, '无有效的二维码会话，请重新生成');
    }
    if (currentQrSession && Date.now() - currentQrSession.createTime > QRCODE_TIMEOUT) {
        currentQrSession = null;
        return buildQrResult(QrCodeLoginStatus.EXPIRED, '二维码已过期，请重新生成');
    }

    try {
        const url = new URL(QRCODE_POLL_API);
        url.searchParams.set('qrcode_key', key);
        const json = await requestJson<{ data?: unknown }>(url.toString(), {
            headers: {
                Referer: BILI_HOME,
                'User-Agent': pluginState.config.userAgent,
            },
        });
        const data = asRecord(json.data);
        const code = Number(data.code ?? 0);
        const message = pickString(data.message, '未知状态');

        if (code === QrCodeLoginStatus.WAITING) {
            return buildQrResult(QrCodeLoginStatus.WAITING, '等待扫码', { statusText: '等待扫码' });
        }
        if (code === QrCodeLoginStatus.SCANNED) {
            return buildQrResult(QrCodeLoginStatus.SCANNED, '已扫码，请在手机上确认', { statusText: '已扫码，请在手机上确认' });
        }
        if (code === QrCodeLoginStatus.EXPIRED) {
            currentQrSession = null;
            return buildQrResult(QrCodeLoginStatus.EXPIRED, message || '二维码已过期', { statusText: '二维码已过期' });
        }
        if (code === QrCodeLoginStatus.SUCCESS) {
            const loginUrl = pickString(data.url);
            const cookie = parseLoginCookieFromUrl(loginUrl);
            if (!cookie) {
                currentQrSession = null;
                return buildQrResult(QrCodeLoginStatus.EXPIRED, '解析登录凭据失败，请重新扫码', { statusText: '解析登录凭据失败' });
            }

            const login = await fetchLoginState(cookie);
            if (!login.loggedIn) {
                currentQrSession = null;
                return buildQrResult(QrCodeLoginStatus.EXPIRED, login.message || '登录校验失败', { statusText: login.message || '登录校验失败' });
            }

            pluginState.updateConfig({ cookie });
            pluginState.markRequestSuccess();
            currentQrSession = null;
            return buildQrResult(QrCodeLoginStatus.SUCCESS, '登录成功', {
                statusText: '登录成功',
                isSuccess: true,
                login,
            });
        }

        return buildQrResult(QrCodeLoginStatus.EXPIRED, message, { statusText: message });
    } catch (error) {
        pluginState.log('error', '轮询二维码状态异常', error);
        currentQrSession = null;
        return buildQrResult(QrCodeLoginStatus.EXPIRED, '请求异常', { statusText: '请求异常' });
    }
}

export async function searchPublishers(keyword: string, limit = 10): Promise<BiliPublisher[]> {
    // 搜索接口返回结果结构比较散，这里只取我们真正需要的字段。
    const url = new URL(`${API_HOME}/x/web-interface/search/type`);
    url.searchParams.set('search_type', 'bili_user');
    url.searchParams.set('keyword', keyword);
    url.searchParams.set('page', '1');
    const json = await callWithDelay(() => requestJson<{ data?: unknown }>(url.toString()));
    const result = getByPath(json, 'data.result');
    if (!Array.isArray(result)) return [];
    return result
        .map((item): BiliPublisher | null => {
            const record = asRecord(item);
            const uid = pickString(record.mid);
            if (!uid || uid === '0') return null;
            return {
                uid,
                name: stripHtml(pickString(record.uname, uid)),
                face: normalizeUrl(record.upic),
            };
        })
        .filter((item): item is BiliPublisher => item !== null)
        .slice(0, Math.max(1, limit));
}

export async function fetchLatestDynamics(uid: string): Promise<BiliDynamicItem[]> {
    // 拉取空间最近动态，后续轮询就是基于这份列表比对游标。
    const url = new URL(`${API_HOME}/x/polymer/web-dynamic/v1/feed/space`);
    url.searchParams.set('host_mid', uid);
    url.searchParams.set('timezone_offset', '-480');
    url.searchParams.set('features', 'itemOpusStyle');
    const json = await callWithDelay(() => requestJson<{ data?: unknown }>(url.toString()));
    const items = getByPath(json, 'data.items');
    if (!Array.isArray(items)) return [];
    return items.map((item) => mapDynamicItem(uid, item)).filter((item): item is BiliDynamicItem => item !== null);
}

export async function fetchLiveStatusBatch(uids: string[]): Promise<Map<string, BiliLiveInfo>> {
    // 直播状态接口支持批量查询，适合轮询阶段一次性拉取多个 UID。
    const ids = uids.map((uid) => Number(uid)).filter((uid) => Number.isFinite(uid) && uid > 0);
    if (ids.length === 0) return new Map();

    const json = await callWithDelay(() => requestJson<{ data?: unknown }>(
        `${LIVE_API_HOME}/room/v1/Room/get_status_info_by_uids`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uids: ids }),
        },
    ));
    const data = asRecord(json.data);
    const out = new Map<string, BiliLiveInfo>();
    for (const [uid, raw] of Object.entries(data)) {
        const record = asRecord(raw);
        out.set(uid, {
            uid,
            roomId: pickString(record.room_id),
            status: mapLiveStatus(record.live_status),
            title: pickString(record.title, 'Bilibili live'),
            area: [record.area_v2_parent_name, record.area_v2_name].map((v) => pickString(v)).filter(Boolean).join(' / ') || undefined,
            cover: normalizeUrl(record.cover_from_user) ?? normalizeUrl(record.keyframe),
            startedAt: pickNumber(record.live_time, 0) || undefined,
        });
    }
    return out;
}

export async function expandShortUrl(inputUrl: string, timeoutSeconds: number): Promise<string | null> {
    // 对 b23.tv 之类短链进行自动跳转展开。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds * 1000));
    try {
        const res = await fetch(inputUrl, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': pluginState.config.userAgent },
        });
        return res.url || null;
    } finally {
        clearTimeout(timer);
    }
}

function mapDynamicItem(uid: string, raw: unknown): BiliDynamicItem | null {
    // 动态对象的实际结构会随着内容类型变化，这里尽量抽取通用字段。
    const item = asRecord(raw);
    const id = pickString(item.id_str) || pickString(item.id);
    if (!id) return null;
    const modules = asRecord(item.modules);
    const author = asRecord(modules.module_author);
    const dynamic = asRecord(modules.module_dynamic);
    const major = asRecord(dynamic.major);
    const desc = asRecord(dynamic.desc);
    const pubTs = pickNumber(author.pub_ts, pickNumber(item.pub_ts, Math.floor(Date.now() / 1000)));
    const badge = pickString(getByPath(major, 'type'), pickString(item.type));

    return {
        id,
        uid: pickString(author.mid, uid),
        authorName: pickString(author.name, uid),
        timestamp: pubTs,
        type: pickString(item.type, 'dynamic'),
        text: extractDynamicText(desc, major),
        title: extractTitle(major),
        url: `https://t.bilibili.com/${id}`,
        images: extractImages(major),
        cover: extractCover(major),
        badge,
    };
}

function extractDynamicText(desc: Record<string, unknown>, major: Record<string, unknown>): string {
    // 优先取显式文本，再取图文/专栏摘要，最后回退到阻断提示。
    const text = pickString(desc.text);
    if (text) return text;
    const opusSummary = pickString(getByPath(major, 'opus.summary.text'));
    if (opusSummary) return opusSummary;
    const blocked = pickString(getByPath(major, 'blocked.hint_message'));
    return blocked;
}

function extractTitle(major: Record<string, unknown>): string | undefined {
    // 标题同样按常见内容类型逐个兜底。
    return pickString(getByPath(major, 'opus.title'))
        || pickString(getByPath(major, 'archive.title'))
        || pickString(getByPath(major, 'article.title'))
        || pickString(getByPath(major, 'live.title'))
        || undefined;
}

function extractImages(major: Record<string, unknown>): string[] {
    // 图文动态可能在不同字段里放图片列表，这里兼容两种常见结构。
    const drawItems = getByPath(major, 'draw.items');
    const opusPics = getByPath(major, 'opus.pics');
    const values = Array.isArray(drawItems) ? drawItems : Array.isArray(opusPics) ? opusPics : [];
    return values
        .map((item) => normalizeUrl(getByPath(item, 'src') ?? getByPath(item, 'url')))
        .filter((url): url is string => Boolean(url));
}

function extractCover(major: Record<string, unknown>): string | undefined {
    // 兜底封面用于视频、专栏和直播类动态。
    return normalizeUrl(getByPath(major, 'archive.cover'))
        ?? normalizeUrl(getByPath(major, 'article.covers.0'))
        ?? normalizeUrl(getByPath(major, 'live.cover'))
        ?? normalizeUrl(getByPath(major, 'pgc.cover'));
}

function mapLiveStatus(value: unknown): LiveStatus {
    // B 站直播状态是数字，统一映射成业务层可读的字符串。
    const status = Number(value);
    if (status === 1) return 'open';
    if (status === 2) return 'round';
    if (status === 0) return 'close';
    return 'unknown';
}

function stripHtml(value: string): string {
    // 搜索接口会返回少量 HTML 片段，搜索结果显示前先去掉标签。
    return value.replace(/<[^>]+>/g, '');
}
