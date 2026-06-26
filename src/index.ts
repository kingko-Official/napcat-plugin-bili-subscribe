import type {
    NapCatPluginContext,
    PluginConfigSchema,
    PluginModule,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { buildConfigSchema } from './config';
import { pluginState } from './core/state';
import { handleMessage } from './handlers/message-handler';
import { registerApiRoutes } from './services/api-service';
import { startSubscriptionPolling, stopSubscriptionPolling } from './services/subscription-service';
import type { PluginConfig } from './types';

export let plugin_config_ui: PluginConfigSchema = [];

// 插件初始化阶段：建立全局状态、注册 WebUI/API，并启动订阅轮询。
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        pluginState.init(ctx);
        plugin_config_ui = buildConfigSchema(ctx);
        registerWebUI(ctx);
        registerApiRoutes(ctx);
        startSubscriptionPolling(ctx);
        ctx.logger.info('BiliSub initialized');
    } catch (error) {
        ctx.logger.error('BiliSub initialization failed', error);
    }
};

// 只处理消息事件，其他 OneBot 事件直接忽略。
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    if (event.post_type !== 'message') return;
    if (!pluginState.config.enabled) return;
    await handleMessage(ctx, event);
};

export const plugin_onevent: PluginModule['plugin_onevent'] = async () => {
};

// 卸载或重载时清理定时器、落盘配置与订阅数据。
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        stopSubscriptionPolling();
        pluginState.cleanup();
        ctx.logger.info('BiliSub cleaned up');
    } catch (error) {
        ctx.logger.warn('BiliSub cleanup failed', error);
    }
};

// WebUI 直接读取当前配置，保证前后端看到的是同一份状态。
export const plugin_get_config: PluginModule['plugin_get_config'] = async () => {
    return pluginState.config;
};

// 外部写入整份配置时，先做一次整体替换，再重启轮询器。
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    pluginState.replaceConfig(config as PluginConfig);
    restartPolling(ctx);
};

// 仅有单个 UI 字段变化时，增量更新配置并立即生效。
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (ctx, _ui, key, value) => {
    pluginState.updateConfig({ [key]: value } as Partial<PluginConfig>);
    restartPolling(ctx);
};

// 注册 WebUI 静态资源和页面入口。
function registerWebUI(ctx: NapCatPluginContext): void {
    const router = ctx.router;
    router.static('/static', 'webui');
    router.page({
        path: 'dashboard',
        title: 'BiliSub',
        htmlFile: 'webui/index.html',
        description: 'Bilibili dynamic and live subscription manager',
    });
}

// 配置变化会影响轮询间隔和过滤逻辑，所以需要先停再启。
function restartPolling(ctx: NapCatPluginContext): void {
    stopSubscriptionPolling();
    startSubscriptionPolling(ctx);
}
