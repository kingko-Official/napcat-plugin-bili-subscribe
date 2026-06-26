export type LiveStatus = 'open' | 'round' | 'close' | 'unknown'

export interface PluginStatus {
  pluginName: string
  uptime: number
  uptimeFormatted: string
  config: PluginConfig
  stats: RuntimeStats
  subscriptions: BiliSubscription[]
}

export interface RuntimeStats {
  processed: number
  todayProcessed: number
  pushedDynamics: number
  pushedLives: number
  failedRequests: number
  lastUpdateDay: string
  lastPollAt?: number
  nextPollAt?: number
  pausedUntil?: number
  lastError?: string
}

export interface PluginConfig {
  enabled: boolean
  debug: boolean
  commandPrefix: string
  cooldownSeconds: number
  pollingIntervalSeconds: number
  requestIntervalSeconds: number
  replayWindowMinutes: number
  liveDetectionEnabled: boolean
  liveStatusBatchSize: number
  maxDynamicPerPoll: number
  maxPushPerPoll: number
  shortUrlResolveTimeoutSeconds: number
  requestBlockCooldownMinutes: number
  cookie: string
  userAgent: string
  groupConfigs?: Record<string, GroupConfig>
}

export interface GroupConfig {
  enabled?: boolean
}

export interface BiliSubscription {
  uid: string
  name: string
  face?: string
  groupId: string
  createdAt: number
  createdBy?: string
  lastDynamicId?: string
  lastDynamicTimestamp?: number
  liveStatus?: LiveStatus
  liveRoomId?: string
  lastLiveTitle?: string
}

export interface GroupInfo {
  group_id: number
  group_name: string
  member_count: number
  max_member_count: number
  enabled: boolean
  subscriptionCount?: number
}

export interface ApiResponse<T = unknown> {
  code: number
  data?: T
  message?: string
}
