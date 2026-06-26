import fs from 'fs';
import path from 'path';
import type { NapCatPluginContext, PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';
import { DEFAULT_CONFIG } from '../config';
import type { BiliSubscription, GroupConfig, PluginConfig, RuntimeStats, SubscriptionStore } from '../types';

const STORE_FILE = 'subscriptions.json';

// 工具函数把外部输入清洗成可直接使用的运行时结构。
function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown, fallback: number, min = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function sanitizeGroupConfigs(raw: unknown): Record<string, GroupConfig> {
    if (!isObject(raw)) return {};
    const out: Record<string, GroupConfig> = {};
    for (const [groupId, value] of Object.entries(raw)) {
        if (!isObject(value)) continue;
        out[groupId] = {
            enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
        };
    }
    return out;
}

export function sanitizeConfig(raw: unknown): PluginConfig {
    // 配置文件可能来自旧版本或手动编辑，先回退到默认值，再覆盖有效字段。
    if (!isObject(raw)) return { ...DEFAULT_CONFIG, groupConfigs: {} };
    return {
        ...DEFAULT_CONFIG,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled,
        debug: typeof raw.debug === 'boolean' ? raw.debug : DEFAULT_CONFIG.debug,
        commandPrefix: typeof raw.commandPrefix === 'string' && raw.commandPrefix.trim()
            ? raw.commandPrefix.trim()
            : DEFAULT_CONFIG.commandPrefix,
        cooldownSeconds: toNumber(raw.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds),
        pollingIntervalSeconds: toNumber(raw.pollingIntervalSeconds, DEFAULT_CONFIG.pollingIntervalSeconds, 1),
        requestIntervalSeconds: toNumber(raw.requestIntervalSeconds, DEFAULT_CONFIG.requestIntervalSeconds),
        replayWindowMinutes: toNumber(raw.replayWindowMinutes, DEFAULT_CONFIG.replayWindowMinutes),
        liveDetectionEnabled: typeof raw.liveDetectionEnabled === 'boolean'
            ? raw.liveDetectionEnabled
            : DEFAULT_CONFIG.liveDetectionEnabled,
        liveStatusBatchSize: Math.floor(toNumber(raw.liveStatusBatchSize, DEFAULT_CONFIG.liveStatusBatchSize, 1)),
        maxDynamicPerPoll: Math.floor(toNumber(raw.maxDynamicPerPoll, DEFAULT_CONFIG.maxDynamicPerPoll, 1)),
        maxPushPerPoll: Math.floor(toNumber(raw.maxPushPerPoll, DEFAULT_CONFIG.maxPushPerPoll, 1)),
        shortUrlResolveTimeoutSeconds: toNumber(
            raw.shortUrlResolveTimeoutSeconds,
            DEFAULT_CONFIG.shortUrlResolveTimeoutSeconds,
            0.1,
        ),
        requestBlockCooldownMinutes: toNumber(raw.requestBlockCooldownMinutes, DEFAULT_CONFIG.requestBlockCooldownMinutes),
        cookie: typeof raw.cookie === 'string' ? raw.cookie.trim() : DEFAULT_CONFIG.cookie,
        userAgent: typeof raw.userAgent === 'string' && raw.userAgent.trim()
            ? raw.userAgent.trim()
            : DEFAULT_CONFIG.userAgent,
        groupConfigs: sanitizeGroupConfigs(raw.groupConfigs),
    };
}

function sanitizeSubscription(raw: unknown): BiliSubscription | null {
    // 订阅记录只保留执行轮询和推送真正需要的字段。
    if (!isObject(raw)) return null;
    const uid = typeof raw.uid === 'string' ? raw.uid.trim() : String(raw.uid ?? '').trim();
    const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : String(raw.groupId ?? '').trim();
    if (!uid || !groupId) return null;
    return {
        uid,
        groupId,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : uid,
        face: typeof raw.face === 'string' ? raw.face : undefined,
        createdAt: toNumber(raw.createdAt, Date.now()),
        createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : undefined,
        lastDynamicId: typeof raw.lastDynamicId === 'string' ? raw.lastDynamicId : undefined,
        lastDynamicTimestamp: typeof raw.lastDynamicTimestamp === 'number' ? raw.lastDynamicTimestamp : undefined,
        liveStatus: raw.liveStatus === 'open' || raw.liveStatus === 'round' || raw.liveStatus === 'close'
            ? raw.liveStatus
            : undefined,
        liveRoomId: typeof raw.liveRoomId === 'string' ? raw.liveRoomId : undefined,
        lastLiveTitle: typeof raw.lastLiveTitle === 'string' ? raw.lastLiveTitle : undefined,
    };
}

class PluginState {
    private _ctx: NapCatPluginContext | null = null;

    // 配置、订阅、统计和定时器都集中在这一个单例里，便于所有模块共享。
    config: PluginConfig = { ...DEFAULT_CONFIG, groupConfigs: {} };
    subscriptions: BiliSubscription[] = [];
    startTime = 0;
    selfId = '';
    timers = new Map<string, ReturnType<typeof setInterval>>();
    stats: RuntimeStats = {
        processed: 0,
        todayProcessed: 0,
        pushedDynamics: 0,
        pushedLives: 0,
        failedRequests: 0,
        lastUpdateDay: new Date().toDateString(),
    };

    get ctx(): NapCatPluginContext {
        if (!this._ctx) throw new Error('PluginState is not initialized');
        return this._ctx;
    }

    get logger(): PluginLogger {
        return this.ctx.logger;
    }

    // 初始化顺序固定：绑定 ctx、准备数据目录、加载配置和订阅、再异步拉取 bot 自身信息。
    init(ctx: NapCatPluginContext): void {
        this._ctx = ctx;
        this.startTime = Date.now();
        this.ensureDataDir();
        this.loadConfig();
        this.loadSubscriptions();
        void this.fetchSelfId();
    }

    // 退出时清空定时器并把当前内存状态写回磁盘。
    cleanup(): void {
        for (const timer of this.timers.values()) {
            clearInterval(timer);
        }
        this.timers.clear();
        this.saveConfig();
        this.saveSubscriptions();
        this._ctx = null;
    }

    // 统一日志入口，debug 级别会受配置开关控制。
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, error?: unknown): void {
        if (level === 'debug' && !this.config.debug) return;
        const logger = this.logger as unknown as Record<string, (...args: unknown[]) => void>;
        logger[level]?.(message, error);
    }

    private async fetchSelfId(): Promise<void> {
        try {
            // 通过登录信息接口获取机器人自身 QQ，供后续消息构造使用。
            const res = await this.callApi<{ user_id?: number | string }>('get_login_info', {});
            if (res?.user_id) this.selfId = String(res.user_id);
        } catch (error) {
            this.log('warn', 'Failed to fetch bot login info', error);
        }
    }

    private ensureDataDir(): void {
        // 插件数据目录不存在时按需创建。
        const dataPath = this.ctx.dataPath;
        if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
    }

    getDataFilePath(filename: string): string {
        return path.join(this.ctx.dataPath, filename);
    }

    loadConfig(): void {
        try {
            // 配置文件存在时读取并恢复运行时统计；否则回退到默认值。
            if (this.ctx.configPath && fs.existsSync(this.ctx.configPath)) {
                const raw = JSON.parse(fs.readFileSync(this.ctx.configPath, 'utf-8'));
                this.config = sanitizeConfig(raw);
                if (isObject(raw) && isObject(raw.stats)) {
                    this.stats = { ...this.stats, ...raw.stats };
                }
                return;
            }
        } catch (error) {
            this.ctx.logger.error('Failed to load config, using defaults', error);
        }
        this.config = { ...DEFAULT_CONFIG, groupConfigs: {} };
        this.saveConfig();
    }

    saveConfig(): void {
        if (!this._ctx?.configPath) return;
        // 配置和运行统计放在同一个文件里，便于 UI 一次性读取。
        const configPath = this._ctx.configPath;
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ ...this.config, stats: this.stats }, null, 2), 'utf-8');
    }

    updateConfig(partial: Partial<PluginConfig>): void {
        // 局部更新时仍然走 sanitize，防止前端传入非法字段。
        this.config = sanitizeConfig({ ...this.config, ...partial });
        this.saveConfig();
    }

    replaceConfig(config: PluginConfig): void {
        this.config = sanitizeConfig(config);
        this.saveConfig();
    }

    updateGroupConfig(groupId: string, config: Partial<GroupConfig>): void {
        // 群开关是按群维度单独存储的，只有目标群会被覆盖。
        this.config.groupConfigs[groupId] = {
            ...this.config.groupConfigs[groupId],
            ...config,
        };
        this.saveConfig();
    }

    isGroupEnabled(groupId: string): boolean {
        // 未显式关闭时默认启用，减少新群接入时的配置成本。
        return this.config.groupConfigs[groupId]?.enabled !== false;
    }

    loadSubscriptions(): void {
        // 订阅列表单独落盘，便于轮询任务独立维护。
        const store = this.loadDataFile<SubscriptionStore>(STORE_FILE, { version: 1, subscriptions: [] });
        this.subscriptions = Array.isArray(store.subscriptions)
            ? store.subscriptions.map(sanitizeSubscription).filter((item): item is BiliSubscription => item !== null)
            : [];
    }

    saveSubscriptions(): void {
        this.saveDataFile<SubscriptionStore>(STORE_FILE, {
            version: 1,
            subscriptions: this.subscriptions,
        });
    }

    upsertSubscription(next: BiliSubscription): void {
        // 同一个群同一个 UID 视为同一条订阅，做覆盖式更新。
        const index = this.subscriptions.findIndex((item) => item.groupId === next.groupId && item.uid === next.uid);
        if (index >= 0) {
            this.subscriptions[index] = { ...this.subscriptions[index], ...next };
        } else {
            this.subscriptions.push(next);
        }
        this.saveSubscriptions();
    }

    removeSubscription(groupId: string, uid: string): boolean {
        // 删除后根据数组长度判断是否真的移除了订阅。
        const before = this.subscriptions.length;
        this.subscriptions = this.subscriptions.filter((item) => !(item.groupId === groupId && item.uid === uid));
        const removed = this.subscriptions.length !== before;
        if (removed) this.saveSubscriptions();
        return removed;
    }

    loadDataFile<T>(filename: string, defaultValue: T): T {
        // 通用 JSON 读取：文件不存在或解析失败时回退到默认值。
        const filePath = this.getDataFilePath(filename);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
            }
        } catch (error) {
            this.log('warn', `Failed to read data file ${filename}`, error);
        }
        return defaultValue;
    }

    saveDataFile<T>(filename: string, data: T): void {
        // 所有业务数据都走统一的格式化写回，保持磁盘结构稳定。
        const filePath = this.getDataFilePath(filename);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    async callApi<T>(action: string, params: Record<string, unknown>): Promise<T> {
        // 统一封装 NapCat Action 调用，避免各处重复拼接 adapter/config 参数。
        return this.ctx.actions.call(
            action as never,
            params as never,
            this.ctx.adapterName,
            this.ctx.pluginManager.config,
        ) as Promise<T>;
    }

    incrementProcessed(): void {
        // 任意一次成功处理都要刷新“今日统计”的日期边界。
        this.bumpDay();
        this.stats.todayProcessed++;
        this.stats.processed++;
    }

    incrementPushedDynamics(count = 1): void {
        this.bumpDay();
        this.stats.pushedDynamics += count;
    }

    incrementPushedLives(count = 1): void {
        this.bumpDay();
        this.stats.pushedLives += count;
    }

    markRequestFailure(error: unknown): void {
        // 请求失败既计数，也记录最近错误，便于 WebUI 显示和风控判断。
        this.stats.failedRequests++;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        const cooldownMs = this.config.requestBlockCooldownMinutes * 60 * 1000;
        if (cooldownMs > 0 && this.isLikelyBlocked(error)) {
            this.stats.pausedUntil = Date.now() + cooldownMs;
        }
        this.saveConfig();
    }

    markRequestSuccess(): void {
        // 登录校验或接口恢复成功后，主动清掉最近错误和暂停状态。
        this.stats.lastError = undefined;
        this.stats.pausedUntil = undefined;
        this.saveConfig();
    }

    clearRequestPause(): void {
        this.stats.lastError = undefined;
        if (this.stats.pausedUntil && this.stats.pausedUntil <= Date.now()) {
            this.stats.pausedUntil = undefined;
        }
    }

    getUptime(): number {
        // 运行时长以启动时间为基准动态计算，不需要额外维护计时器。
        return Date.now() - this.startTime;
    }

    getUptimeFormatted(): string {
        // 给 WebUI 和命令行输出一个更适合阅读的时长字符串。
        const seconds = Math.floor(this.getUptime() / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    private bumpDay(): void {
        // 跨天后清空今日计数，保证“今日处理量”只统计当天。
        const today = new Date().toDateString();
        if (this.stats.lastUpdateDay !== today) {
            this.stats.todayProcessed = 0;
            this.stats.lastUpdateDay = today;
        }
    }

    private isLikelyBlocked(error: unknown): boolean {
        // 这里用关键词做轻量风控识别，命中后会触发暂停轮询。
        const message = error instanceof Error ? error.message : String(error);
        return /csrf|cookie|login|风控|拦截|blocked|forbidden|unauthorized|412|403/i.test(message);
    }
}

export const pluginState = new PluginState();
