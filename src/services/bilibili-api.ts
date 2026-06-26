import type { BiliDynamicItem, BiliLiveInfo, BiliPublisher, LiveStatus } from '../types';
import { pluginState } from '../core/state';

const BILI_HOME = 'https://www.bilibili.com';
const API_HOME = 'https://api.bilibili.com';
const LIVE_API_HOME = 'https://api.live.bilibili.com';

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

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    // 所有请求统一带上 UA、Referer 和可选 Cookie，降低被拦截概率。
    const headers: Record<string, string> = {
        'User-Agent': pluginState.config.userAgent,
        Referer: BILI_HOME,
        Accept: 'application/json, text/plain, */*',
        ...(init.headers as Record<string, string> | undefined),
    };
    if (pluginState.config.cookie) headers.Cookie = pluginState.config.cookie;

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
