import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { BiliDynamicItem, BiliLiveInfo, BiliSubscription } from '../types';
import { pluginState } from '../core/state';
import { fetchLatestDynamics, fetchLiveStatusBatch } from './bilibili-api';
import { imageSegment, sendGroupMessage, textSegment } from '../handlers/message-handler';

const POLL_TIMER_ID = 'bilibili-poller';

let pollRunning = false;

// 启动轮询：记录下一次执行时间，并初始化每条订阅的游标。
export function startSubscriptionPolling(ctx: NapCatPluginContext): void {
    stopSubscriptionPolling();
    const intervalMs = Math.max(1, pluginState.config.pollingIntervalSeconds) * 1000;
    pluginState.stats.nextPollAt = Date.now() + intervalMs;
    const timer = setInterval(() => {
        pluginState.stats.nextPollAt = Date.now() + intervalMs;
        void pollSubscriptions(ctx);
    }, intervalMs);
    pluginState.timers.set(POLL_TIMER_ID, timer);
    void initializeSubscriptionCursors();
}

// 停止轮询：只负责移除定时器，不改动订阅内容。
export function stopSubscriptionPolling(): void {
    const timer = pluginState.timers.get(POLL_TIMER_ID);
    if (timer) clearInterval(timer);
    pluginState.timers.delete(POLL_TIMER_ID);
}

// 轮询主入口：可由定时器驱动，也可由 WebUI/命令手动触发。
export async function pollSubscriptions(ctx: NapCatPluginContext, force = false): Promise<void> {
    if (!pluginState.config.enabled && !force) return;
    if (pollRunning) return;
    if (!force && pluginState.stats.pausedUntil && pluginState.stats.pausedUntil > Date.now()) return;

    pollRunning = true;
    pluginState.stats.lastPollAt = Date.now();
    let pushed = 0;
    try {
        pluginState.clearRequestPause();
        const subscriptions = pluginState.subscriptions.filter((item) => pluginState.isGroupEnabled(item.groupId));
        for (const sub of subscriptions) {
            if (pushed >= pluginState.config.maxPushPerPoll) break;
            pushed += await pollOneSubscription(ctx, sub, pluginState.config.maxPushPerPoll - pushed);
        }
        if (pluginState.config.liveDetectionEnabled) {
            await pollLiveStatuses(ctx, subscriptions);
        }
        pluginState.saveSubscriptions();
        pluginState.saveConfig();
    } catch (error) {
        pluginState.markRequestFailure(error);
        pluginState.log('warn', 'Bilibili polling failed', error);
    } finally {
        pollRunning = false;
    }
}

// 首次启动时需要先把游标对齐到当前最新动态，避免把历史内容误认为新内容。
export async function initializeSubscriptionCursors(): Promise<void> {
    const replayCutoff = pluginState.config.replayWindowMinutes > 0
        ? Math.floor(Date.now() / 1000) - pluginState.config.replayWindowMinutes * 60
        : undefined;

    for (const sub of pluginState.subscriptions) {
        if (sub.lastDynamicId) continue;
        try {
            const dynamics = await fetchLatestDynamics(sub.uid);
            const latest = dynamics[0];
            if (!latest) continue;
            if (replayCutoff && latest.timestamp >= replayCutoff) {
                sub.lastDynamicTimestamp = replayCutoff;
            } else {
                sub.lastDynamicId = latest.id;
                sub.lastDynamicTimestamp = latest.timestamp;
            }
        } catch (error) {
            pluginState.log('warn', `Failed to initialize cursor for ${sub.uid}`, error);
        }
    }
    pluginState.saveSubscriptions();
}

// 单个 UP 的轮询逻辑：拉动态、找未读、发送消息、再更新游标。
async function pollOneSubscription(
    ctx: NapCatPluginContext,
    sub: BiliSubscription,
    remainingBudget: number,
): Promise<number> {
    const dynamics = await fetchLatestDynamics(sub.uid);
    if (dynamics.length === 0) return 0;

    const latest = dynamics[0];
    const unseen = collectUnseenDynamics(sub, dynamics)
        .slice(0, Math.min(pluginState.config.maxDynamicPerPoll, remainingBudget))
        .reverse();

    for (const item of unseen) {
        await pushDynamic(ctx, sub, item);
    }

    sub.lastDynamicId = latest.id;
    sub.lastDynamicTimestamp = latest.timestamp;
    if (latest.authorName) sub.name = latest.authorName;
    if (unseen.length > 0) {
        pluginState.incrementPushedDynamics(unseen.length);
        pluginState.incrementProcessed();
    }
    return unseen.length;
}

function collectUnseenDynamics(sub: BiliSubscription, dynamics: BiliDynamicItem[]): BiliDynamicItem[] {
    // 通过最后一次已知动态 ID 或时间戳，判断哪些内容还没有推送过。
    if (!sub.lastDynamicId && !sub.lastDynamicTimestamp) return [];
    const seenIndex = sub.lastDynamicId
        ? dynamics.findIndex((item) => item.id === sub.lastDynamicId)
        : -1;
    if (seenIndex >= 0) return dynamics.slice(0, seenIndex);

    if (sub.lastDynamicTimestamp) {
        const lastTimestamp = sub.lastDynamicTimestamp;
        const timeIndex = dynamics.findIndex((item) => item.timestamp <= lastTimestamp);
        if (timeIndex >= 0) return dynamics.slice(0, timeIndex);
    }

    return [];
}

// 直播轮询和动态轮询共用同一个执行窗口，避免批量请求过大。
async function pollLiveStatuses(ctx: NapCatPluginContext, subscriptions: BiliSubscription[]): Promise<void> {
    const uniqueUids = [...new Set(subscriptions.map((item) => item.uid))];
    const batchSize = Math.max(1, pluginState.config.liveStatusBatchSize);
    for (let i = 0; i < uniqueUids.length; i += batchSize) {
        const batch = uniqueUids.slice(i, i + batchSize);
        const liveMap = await fetchLiveStatusBatch(batch);
        for (const sub of subscriptions.filter((item) => batch.includes(item.uid))) {
            const live = liveMap.get(sub.uid);
            if (!live) continue;
            await maybePushLive(ctx, sub, live);
        }
    }
}

async function pushDynamic(ctx: NapCatPluginContext, sub: BiliSubscription, item: BiliDynamicItem): Promise<void> {
    // 动态消息尽量保留文本摘要，并在有图时附带首图。
    const config = pluginState.config;
    const lines = [
        ` ${item.authorName || sub.name} 发布了新动态`,
        config.dynamicMessageIncludeTitle && item.title ? `标题: ${item.title}` : '',
        config.dynamicMessageIncludeContent && item.text ? `${trimText(item.text, 500)}` : '',
        config.dynamicMessageIncludeType && item.badge ? `类型: ${item.badge}` : '',
        config.dynamicMessageIncludeLink ? `链接: ${item.url}` : '',
    ].filter(Boolean);

    const imageUrl = config.dynamicMessageIncludeImage ? (item.images[0] ?? item.cover) : undefined;
    const message = imageUrl
        ? [textSegment(lines.join('\n') + '\n'), imageSegment(imageUrl)]
        : lines.join('\n');
    await sendGroupMessage(ctx, sub.groupId, message);
}

async function maybePushLive(ctx: NapCatPluginContext, sub: BiliSubscription, live: BiliLiveInfo): Promise<void> {
    // 只有状态发生变化时才推送，避免重复刷屏。
    const previous = sub.liveStatus;
    sub.liveStatus = live.status;
    sub.liveRoomId = live.roomId || sub.liveRoomId;
    sub.lastLiveTitle = live.title || sub.lastLiveTitle;

    if (!previous || previous === live.status) return;
    if (live.status === 'open' && previous !== 'open') {
        const lines = [
            ` ${sub.name} 开播了`,
            live.title ? `标题: ${live.title}` : '',
            live.area ? `分区: ${live.area}` : '',
            `直播间: https://live.bilibili.com/${live.roomId}`,
        ].filter(Boolean);
        await sendGroupMessage(ctx, sub.groupId, live.cover
            ? [textSegment(lines.join('\n') + '\n'), imageSegment(live.cover)]
            : lines.join('\n'));
        pluginState.incrementPushedLives();
        pluginState.incrementProcessed();
    }

    if (previous === 'open' && live.status === 'close') {
        await sendGroupMessage(ctx, sub.groupId, ` ${sub.name} 已下播`);
        pluginState.incrementPushedLives();
        pluginState.incrementProcessed();
    }
}

function trimText(text: string, maxLength: number): string {
    // 过长正文只保留前段，避免群消息过于冗长。
    const normalized = text.trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
}
