import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import type { BiliSubscription, PluginConfig } from '../types';
import { fetchLatestDynamics, resolvePublisher, searchPublishers } from './bilibili-api';
import { pollSubscriptions } from './subscription-service';

// WebUI 通过这些 no-auth 路由直接读取和操作插件状态。
export function registerApiRoutes(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // 运行状态接口：用于仪表盘和健康检查。
    router.getNoAuth('/status', (_req, res) => {
        res.json({
            code: 0,
            data: {
                pluginName: ctx.pluginName,
                uptime: pluginState.getUptime(),
                uptimeFormatted: pluginState.getUptimeFormatted(),
                config: pluginState.config,
                stats: pluginState.stats,
                subscriptions: pluginState.subscriptions,
            },
        });
    });

    // 配置读取接口：前端配置页启动时会先拉取一次。
    router.getNoAuth('/config', (_req, res) => {
        res.json({ code: 0, data: pluginState.config });
    });

    // 配置写入接口：由 WebUI 表单提交后调用。
    router.postNoAuth('/config', (req, res) => {
        try {
            pluginState.updateConfig((req.body ?? {}) as Partial<PluginConfig>);
            res.json({ code: 0, message: 'ok' });
        } catch (error) {
            res.status(500).json({ code: -1, message: String(error) });
        }
    });

    // 订阅列表接口：可按群过滤，也可直接取全量。
    router.getNoAuth('/subscriptions', (req, res) => {
        const groupId = typeof req.query?.groupId === 'string' ? req.query.groupId : undefined;
        const data = groupId
            ? pluginState.subscriptions.filter((item) => item.groupId === groupId)
            : pluginState.subscriptions;
        res.json({ code: 0, data });
    });

    // 新增订阅：先解析 UP 主，再记录最新动态作为游标。
    router.postNoAuth('/subscriptions', async (req, res) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const groupId = String(body.groupId ?? '').trim();
            const query = String(body.uid ?? body.query ?? '').trim();
            if (!groupId || !query) {
                return res.status(400).json({ code: -1, message: 'groupId and uid/query are required' });
            }

            const publisher = await resolvePublisher(query);
            if (!publisher) {
                return res.status(404).json({ code: -1, message: 'publisher not found' });
            }
            const dynamics = await fetchLatestDynamics(publisher.uid).catch(() => []);
            const latest = dynamics[0];
            const sub: BiliSubscription = {
                groupId,
                uid: publisher.uid,
                name: publisher.name,
                face: publisher.face,
                createdAt: Date.now(),
                lastDynamicId: latest?.id,
                lastDynamicTimestamp: latest?.timestamp,
            };
            pluginState.upsertSubscription(sub);
            res.json({ code: 0, data: sub });
        } catch (error) {
            pluginState.markRequestFailure(error);
            res.status(500).json({ code: -1, message: String(error) });
        }
    });

    // 删除订阅：按群号 + UID 精确移除。
    router.postNoAuth('/subscriptions/delete', (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const groupId = String(body.groupId ?? '').trim();
        const uid = String(body.uid ?? '').trim();
        if (!groupId || !uid) {
            return res.status(400).json({ code: -1, message: 'groupId and uid are required' });
        }
        const removed = pluginState.removeSubscription(groupId, uid);
        res.json({ code: 0, data: { removed } });
    });

    // 手动触发轮询，方便 UI 上立即验证效果。
    router.postNoAuth('/poll', async (_req, res) => {
        try {
            await pollSubscriptions(ctx, true);
            res.json({ code: 0, message: 'ok' });
        } catch (error) {
            res.status(500).json({ code: -1, message: String(error) });
        }
    });

    // 搜索接口：用于 WebUI 内搜索 B站 UP 主。
    router.getNoAuth('/search', async (req, res) => {
        try {
            const query = String(req.query?.q ?? '').trim();
            if (!query) return res.json({ code: 0, data: [] });
            const data = await searchPublishers(query, 10);
            res.json({ code: 0, data });
        } catch (error) {
            res.status(500).json({ code: -1, message: String(error) });
        }
    });

    // 群列表接口：附带每个群的启用状态和当前订阅数。
    router.getNoAuth('/groups', async (_req, res) => {
        try {
            const groups = await pluginState.callApi<Array<{
                group_id: number;
                group_name: string;
                member_count: number;
                max_member_count: number;
            }>>('get_group_list', {});

            res.json({
                code: 0,
                data: (groups || []).map((group) => {
                    const groupId = String(group.group_id);
                    return {
                        ...group,
                        enabled: pluginState.isGroupEnabled(groupId),
                        subscriptionCount: pluginState.subscriptions.filter((item) => item.groupId === groupId).length,
                    };
                }),
            });
        } catch (error) {
            res.status(500).json({ code: -1, message: String(error) });
        }
    });

    // 单群配置接口：当前只暴露启用/禁用开关。
    router.postNoAuth('/groups/:id/config', (req, res) => {
        const groupId = req.params?.id;
        if (!groupId) return res.status(400).json({ code: -1, message: 'missing group id' });
        const body = (req.body ?? {}) as Record<string, unknown>;
        pluginState.updateGroupConfig(groupId, { enabled: Boolean(body.enabled) });
        res.json({ code: 0, message: 'ok' });
    });
}
