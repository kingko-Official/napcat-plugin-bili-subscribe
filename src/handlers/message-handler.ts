import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { fetchLatestDynamics, resolvePublisher, searchPublishers } from '../services/bilibili-api';
import { pollSubscriptions } from '../services/subscription-service';
import type { BiliSubscription } from '../types';

type MessageSegment = { type: string; data: Record<string, unknown> };

const cooldownMap = new Map<string, number>();

// 合并转发/图片消息需要的最小消息片段结构。
export function textSegment(text: string): MessageSegment {
    return { type: 'text', data: { text } };
}

export function imageSegment(file: string): MessageSegment {
    return { type: 'image', data: { file } };
}

// 回复当前消息时自动适配群聊/私聊参数。
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message'],
): Promise<boolean> {
    try {
        await pluginState.callApi('send_msg', {
            message,
            message_type: event.message_type,
            ...(event.message_type === 'group' && event.group_id ? { group_id: String(event.group_id) } : {}),
            ...(event.message_type === 'private' && event.user_id ? { user_id: String(event.user_id) } : {}),
        });
        return true;
    } catch (error) {
        pluginState.log('error', 'Failed to send reply', error);
        return false;
    }
}

export async function sendGroupMessage(
    ctx: NapCatPluginContext,
    groupId: number | string,
    message: OB11PostSendMsg['message'],
): Promise<boolean> {
    try {
        await pluginState.callApi('send_msg', {
            message,
            message_type: 'group',
            group_id: String(groupId),
        });
        return true;
    } catch (error) {
        pluginState.log('error', 'Failed to send group message', error);
        return false;
    }
}

export async function sendPrivateMessage(
    ctx: NapCatPluginContext,
    userId: number | string,
    message: OB11PostSendMsg['message'],
): Promise<boolean> {
    try {
        await pluginState.callApi('send_msg', {
            message,
            message_type: 'private',
            user_id: String(userId),
        });
        return true;
    } catch (error) {
        pluginState.log('error', 'Failed to send private message', error);
        return false;
    }
}

// 群聊里只有管理员和群主可以修改订阅类命令。
export function isAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return true;
    const role = (event.sender as Record<string, unknown> | undefined)?.role;
    return role === 'admin' || role === 'owner';
}

export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    // 只识别前缀命令，普通聊天内容不参与处理。
    const rawMessage = event.raw_message?.trim() || '';
    const prefix = pluginState.config.commandPrefix || '#bili';
    if (!rawMessage.startsWith(prefix)) return;

    const args = rawMessage.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
    const command = (args.shift() || 'help').toLowerCase();
    const groupId = event.group_id ? String(event.group_id) : undefined;

    // 群级开关关闭时直接忽略该群的命令。
    if (event.message_type === 'group' && groupId && !pluginState.isGroupEnabled(groupId)) return;
    if (event.message_type === 'group' && groupId) {
        // 冷却是按“群 + 命令”维度计算，避免同一个群刷屏。
        const remaining = getCooldownRemaining(groupId, command);
        if (remaining > 0) {
            await sendReply(ctx, event, `请等 ${remaining} 秒后再试。`);
            return;
        }
        setCooldown(groupId, command);
    }

    try {
        // 命令分发集中在这里，方便新增子命令时快速定位。
        switch (command) {
            case 'help':
            case 'h':
                await sendReply(ctx, event, buildHelp(prefix));
                break;
            case 'status':
                await sendReply(ctx, event, buildStatus());
                break;
            case 'sub':
            case 'subscribe':
                await handleSubscribe(ctx, event, args, groupId);
                break;
            case 'unsub':
            case 'unsubscribe':
                await handleUnsubscribe(ctx, event, args, groupId);
                break;
            case 'list':
                await handleList(ctx, event, groupId);
                break;
            case 'check':
                await pollSubscriptions(ctx, true);
                await sendReply(ctx, event, '已完成一次手动检查。');
                break;
            case 'search':
                await handleSearch(ctx, event, args);
                break;
            case 'latest':
                await handleLatest(ctx, event, args);
                break;
            default:
                await sendReply(ctx, event, `未知命令：${command}\n发送 ${prefix} help 查看帮助。`);
                break;
        }
            // 成功处理一次命令，统计计数会同步更新到状态面板。
        pluginState.incrementProcessed();
    } catch (error) {
            // 任何请求或解析失败都记录下来，并把错误直接反馈给发送者。
        pluginState.markRequestFailure(error);
        await sendReply(ctx, event, `处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

async function handleSubscribe(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
    groupId?: string,
): Promise<void> {
    if (!groupId) {
        await sendReply(ctx, event, '订阅命令只能在群聊中使用。');
        return;
    }
    if (!isAdmin(event)) {
        await sendReply(ctx, event, '只有群主或管理员可以修改订阅。');
        return;
    }
    const query = args.join(' ').trim();
    if (!query) {
        await sendReply(ctx, event, `用法：${pluginState.config.commandPrefix} sub <UID 或 UP 主名称>`);
        return;
    }

    // 先把用户输入解析成实际 UP 主，再抓一次最新动态作为初始游标。
    const publisher = await resolvePublisher(query);
    if (!publisher) {
        await sendReply(ctx, event, `没有找到 Bilibili UP：${query}`);
        return;
    }

    const dynamics = await fetchLatestDynamics(publisher.uid).catch(() => []);
    const latest = dynamics[0];
    const sub: BiliSubscription = {
        uid: publisher.uid,
        name: publisher.name,
        face: publisher.face,
        groupId,
        createdAt: Date.now(),
        createdBy: event.user_id ? String(event.user_id) : undefined,
        lastDynamicId: latest?.id,
        lastDynamicTimestamp: latest?.timestamp,
    };
    pluginState.upsertSubscription(sub);
    await sendReply(ctx, event, `已订阅 ${publisher.name}（UID: ${publisher.uid}）。`);
}

async function handleUnsubscribe(
    ctx: NapCatPluginContext,
    event: OB11Message,
    args: string[],
    groupId?: string,
): Promise<void> {
    if (!groupId) {
        await sendReply(ctx, event, '退订命令只能在群聊中使用。');
        return;
    }
    if (!isAdmin(event)) {
        await sendReply(ctx, event, '只有群主或管理员可以修改订阅。');
        return;
    }
    const uid = args[0]?.trim();
    if (!uid) {
        await sendReply(ctx, event, `用法：${pluginState.config.commandPrefix} unsub <UID>`);
        return;
    }
    const removed = pluginState.removeSubscription(groupId, uid);
    await sendReply(ctx, event, removed ? `已退订 UID ${uid}。` : `当前群没有订阅 UID ${uid}。`);
}

async function handleList(ctx: NapCatPluginContext, event: OB11Message, groupId?: string): Promise<void> {
    // 群内只看本群订阅，私聊则查看全部订阅，方便管理员排查。
    const subs = groupId
        ? pluginState.subscriptions.filter((item) => item.groupId === groupId)
        : pluginState.subscriptions;
    if (subs.length === 0) {
        await sendReply(ctx, event, '当前没有订阅。');
        return;
    }
    const lines = subs.map((item, index) => {
        const live = item.liveStatus ? ` | live: ${item.liveStatus}` : '';
        return `${index + 1}. ${item.name} (${item.uid})${live}`;
    });
    await sendReply(ctx, event, lines.join('\n'));
}

async function handleSearch(ctx: NapCatPluginContext, event: OB11Message, args: string[]): Promise<void> {
    const query = args.join(' ').trim();
    if (!query) {
        await sendReply(ctx, event, `用法：${pluginState.config.commandPrefix} search <UP 主名称>`);
        return;
    }
    const results = await searchPublishers(query, 5);
    if (results.length === 0) {
        await sendReply(ctx, event, `没有找到：${query}`);
        return;
    }
    await sendReply(ctx, event, results.map((item, index) => `${index + 1}. ${item.name} (${item.uid})`).join('\n'));
}

async function handleLatest(ctx: NapCatPluginContext, event: OB11Message, args: string[]): Promise<void> {
    const uid = args[0]?.trim();
    if (!uid) {
        await sendReply(ctx, event, `用法：${pluginState.config.commandPrefix} latest <UID>`);
        return;
    }
    const items = await fetchLatestDynamics(uid);
    const item = items[0];
    if (!item) {
        await sendReply(ctx, event, `没有找到 UID ${uid} 的动态。`);
        return;
    }
    await sendReply(ctx, event, [
        `${item.authorName} 最新动态`,
        item.title ? `标题: ${item.title}` : '',
        item.text ? item.text.slice(0, 500) : '',
        item.url,
    ].filter(Boolean).join('\n'));
}

function buildHelp(prefix: string): string {
    // 帮助文本直接拼成多行，方便群里复制阅读。
    return [
        'BiliSub 命令',
        `${prefix} sub <UID|名称> - 订阅 UP 主`,
        `${prefix} unsub <UID> - 退订 UP 主`,
        `${prefix} list - 查看本群订阅`,
        `${prefix} check - 立即检查`,
        `${prefix} search <名称> - 搜索 UP 主`,
        `${prefix} latest <UID> - 查看最新动态`,
        `${prefix} status - 查看运行状态`,
    ].join('\n');
}

function buildStatus(): string {
    // 状态文本汇总运行时长、订阅数和最近轮询情况。
    const total = pluginState.subscriptions.length;
    const groups = new Set(pluginState.subscriptions.map((item) => item.groupId)).size;
    const paused = pluginState.stats.pausedUntil && pluginState.stats.pausedUntil > Date.now()
        ? `\n暂停到: ${new Date(pluginState.stats.pausedUntil).toLocaleString()}`
        : '';
    return [
        'BiliSub 状态',
        `运行: ${pluginState.getUptimeFormatted()}`,
        `订阅: ${total} 个 UP / ${groups} 个群`,
        `动态推送: ${pluginState.stats.pushedDynamics}`,
        `直播推送: ${pluginState.stats.pushedLives}`,
        `失败请求: ${pluginState.stats.failedRequests}`,
        pluginState.stats.lastPollAt ? `上次轮询: ${new Date(pluginState.stats.lastPollAt).toLocaleString()}` : '',
        paused.trim(),
    ].filter(Boolean).join('\n');
}

function getCooldownRemaining(groupId: string, command: string): number {
    // 同群同命令冷却，避免重复触发接口和刷屏。
    const seconds = pluginState.config.cooldownSeconds;
    if (seconds <= 0) return 0;
    const key = `${groupId}:${command}`;
    const expireAt = cooldownMap.get(key);
    if (!expireAt) return 0;
    const remaining = Math.ceil((expireAt - Date.now()) / 1000);
    if (remaining <= 0) {
        cooldownMap.delete(key);
        return 0;
    }
    return remaining;
}

function setCooldown(groupId: string, command: string): void {
    // 记录这次命令的失效时间。
    const seconds = pluginState.config.cooldownSeconds;
    if (seconds <= 0) return;
    cooldownMap.set(`${groupId}:${command}`, Date.now() + seconds * 1000);
}
