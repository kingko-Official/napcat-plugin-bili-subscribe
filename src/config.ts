import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

// 默认配置尽量贴近可直接运行的安全值，避免首次启动就进入高频请求。
export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    debug: false,
    commandPrefix: '#bili',
    cooldownSeconds: 10,
    pollingIntervalSeconds: 60,
    requestIntervalSeconds: 0.8,
    replayWindowMinutes: 0,
    liveDetectionEnabled: true,
    liveStatusBatchSize: 30,
    maxDynamicPerPoll: 5,
    maxPushPerPoll: 20,
    shortUrlResolveTimeoutSeconds: 3,
    requestBlockCooldownMinutes: 30,
    cookie: '',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    groupConfigs: {},
};

// 配置 Schema 由 NapCat 配置构建器生成，WebUI 会直接消费这些字段。
export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        // 顶部说明块，让用户先理解这个插件解决什么问题。
        ctx.NapCatConfig.html(`
            <div style="padding:16px;background:#fb7299;border-radius:10px;color:white;margin-bottom:16px;">
                <h3 style="margin:0 0 6px 0;font-size:18px;">BiliSub</h3>
                <p style="margin:0;font-size:13px;opacity:.9;">Bilibili UP dynamic and live subscription for NapCat.</p>
            </div>
        `),
        ctx.NapCatConfig.boolean('enabled', '启用插件', true, '关闭后不处理命令，也不执行轮询。', true),
        ctx.NapCatConfig.boolean('debug', '调试日志', false, '输出更详细的请求和轮询日志。', true),
        ctx.NapCatConfig.text('commandPrefix', '命令前缀', '#bili', '默认命令前缀，例如 #bili sub 123456。', true),
        ctx.NapCatConfig.number('cooldownSeconds', '命令冷却（秒）', 10, '同一群同一命令的冷却时间，0 表示不限制。', true),
        ctx.NapCatConfig.number('pollingIntervalSeconds', '轮询间隔（秒）', 60, '多久检查一次新动态和直播状态。建议不要低于 30 秒。', true),
        ctx.NapCatConfig.number('requestIntervalSeconds', '接口请求间隔（秒）', 0.8, '连续请求 Bilibili 接口之间的等待时间，用于降低风控概率。', true),
        ctx.NapCatConfig.number('replayWindowMinutes', '启动补发窗口（分钟）', 0, '0 表示启动时只记录当前位置，不补发旧动态。', true),
        ctx.NapCatConfig.boolean('liveDetectionEnabled', '直播检测', true, '推送开播和下播提醒。', true),
        ctx.NapCatConfig.number('liveStatusBatchSize', '直播批量查询数量', 30, '一次最多查询多少个 UP 主直播状态。', true),
        ctx.NapCatConfig.number('maxDynamicPerPoll', '单 UP 单轮动态上限', 5, '每轮每个 UP 最多推送多少条新动态。', true),
        ctx.NapCatConfig.number('maxPushPerPoll', '单轮总推送上限', 20, '一次轮询最多推送多少条消息，避免补发过多。', true),
        ctx.NapCatConfig.number('shortUrlResolveTimeoutSeconds', '短链解析超时（秒）', 3, '解析 b23.tv 等短链接的超时时间。', true),
        ctx.NapCatConfig.number('requestBlockCooldownMinutes', '风控暂停时长（分钟）', 30, '检测到风控或登录失效后暂停轮询多久。', true),
        ctx.NapCatConfig.text('cookie', 'Bilibili Cookie', '', '可选。填写后用于访问动态、直播和搜索接口。', true),
        ctx.NapCatConfig.text('userAgent', 'User-Agent', DEFAULT_CONFIG.userAgent, '请求 Bilibili 接口时使用的 User-Agent。', true),
    );
}
