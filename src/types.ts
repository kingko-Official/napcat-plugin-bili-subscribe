export type LiveStatus = 'open' | 'round' | 'close' | 'unknown';

// 插件主配置，后端和 WebUI 共用同一套字段定义。
export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    commandPrefix: string;
    cooldownSeconds: number;
    pollingIntervalSeconds: number;
    requestIntervalSeconds: number;
    replayWindowMinutes: number;
    liveDetectionEnabled: boolean;
    liveStatusBatchSize: number;
    maxDynamicPerPoll: number;
    maxPushPerPoll: number;
    shortUrlResolveTimeoutSeconds: number;
    requestBlockCooldownMinutes: number;
    cookie: string;
    userAgent: string;
    groupConfigs: Record<string, GroupConfig>;
}

// Bilibili 登录状态用于 WebUI 展示和 Cookie 校验结果返回。
export interface BiliLoginState {
    loggedIn: boolean;
    message: string;
    cookiePresent: boolean;
    account?: BiliLoginAccount;
}

// 登录态里会带上当前账号的基础信息，方便确认 Cookie 对应的是不是目标号。
export interface BiliLoginAccount {
    userId?: string;
    name?: string;
    avatar?: string;
}

// 二维码登录状态用于轮询反馈和前端展示。
export enum QrCodeLoginStatus {
    WAITING = 86101,
    SCANNED = 86090,
    EXPIRED = 86038,
    SUCCESS = 0,
}

// 生成二维码后返回二维码地址和轮询密钥。
export interface QrCodeGenerateResult {
    url: string;
    qrcode_key: string;
}

// 二维码轮询结果只保留前端展示和登录写回所需字段。
export interface QrCodePollResult {
    status: QrCodeLoginStatus;
    message: string;
    statusText?: string;
    isSuccess?: boolean;
    isExpired?: boolean;
    isScanned?: boolean;
    login?: BiliLoginState;
}

// 群级配置目前只保留启用开关，后续可以继续扩展。
export interface GroupConfig {
    enabled?: boolean;
}

// 单条订阅记录就是“某群订阅某 UP”的最小业务单元。
export interface BiliSubscription {
    uid: string;
    name: string;
    face?: string;
    groupId: string;
    createdAt: number;
    createdBy?: string;
    lastDynamicId?: string;
    lastDynamicTimestamp?: number;
    liveStatus?: LiveStatus;
    liveRoomId?: string;
    lastLiveTitle?: string;
}

// 持久化订阅文件的最外层结构，保留版本号方便未来迁移。
export interface SubscriptionStore {
    version: 1;
    subscriptions: BiliSubscription[];
}

// UP 主基础信息，用于订阅解析和 WebUI 搜索结果展示。
export interface BiliPublisher {
    uid: string;
    name: string;
    face?: string;
}

// 动态信息在轮询时会被压缩成这个结构，便于统一推送格式。
export interface BiliDynamicItem {
    id: string;
    uid: string;
    authorName: string;
    timestamp: number;
    type: string;
    text: string;
    title?: string;
    url: string;
    images: string[];
    cover?: string;
    badge?: string;
}

// 直播状态信息用于检测开播和下播。
export interface BiliLiveInfo {
    uid: string;
    roomId: string;
    status: LiveStatus;
    title: string;
    area?: string;
    cover?: string;
    startedAt?: number;
}

// 运行时统计数据会展示在状态页，也会一起写回配置文件。
export interface RuntimeStats {
    processed: number;
    todayProcessed: number;
    pushedDynamics: number;
    pushedLives: number;
    failedRequests: number;
    lastUpdateDay: string;
    lastPollAt?: number;
    nextPollAt?: number;
    pausedUntil?: number;
    lastError?: string;
}

// 所有 API 返回都统一包裹成 code/message/data，便于前端处理。
export interface ApiResponse<T = unknown> {
    code: number;
    message?: string;
    data?: T;
}
