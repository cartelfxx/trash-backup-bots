import { Client, Guild, GuildMember, ChannelType, PermissionFlagsBits, GuildChannel, Role, GuildEmoji, GuildStickerManager, Webhook, GuildBan, Invite } from 'discord.js';
import { Logger } from '../utils/logger';
import { DatabaseManager } from '../database/DatabaseManager';
import { ElasticsearchManager } from '../database/ElasticsearchManager';
import { AuditManager } from '../audit/AuditManager';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

export interface BackupData {
  id: string;
  guildId: string;
  timestamp: Date;
  version: string;
  data: BackupDataStructure;
  metadata: BackupMetadata;
}

export interface BackupMetadata {
  createdBy: string;
  description: string;
  size: number;
  checksum: string;
}

export interface BackupDataStructure {
  guild: BackupGuildData;
  channels: BackupChannelData[];
  roles: BackupRoleData[];
  emojis: BackupEmojiData[];
  stickers: BackupStickerData[];
  members: BackupMemberData[];
  bans: BackupBanData[];
  invites: BackupInviteData[];
  webhooks: BackupWebhookData[];
}

export interface BackupChannelData {
  id: string;
  name: string;
  type: number;
  position?: number;
  permissionOverwrites?: Array<{
    id: string;
    type: number;
    allow: string[];
    deny: string[];
  }>;
  parentId?: string;
  topic?: string;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  lastMessageId?: string;
  bitrate?: number;
  userLimit?: number;
  rtcRegion?: string;
  availableTags?: any[];
  defaultReactionEmoji?: any;
  defaultThreadRateLimitPerUser?: number;
  defaultSortOrder?: number;
  defaultForumLayout?: number;
}

export interface BackupRoleData {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string[];
  managed: boolean;
  mentionable: boolean;
  icon?: string;
  unicodeEmoji?: string;
  tags?: {
    botId?: string;
    integrationId?: string;
    premiumSubscriberRole?: boolean;
    subscriptionListingId?: string;
    availableForPurchase?: boolean;
    guildConnections?: boolean;
  };
}

export interface BackupEmojiData {
  id: string;
  name: string;
  animated: boolean;
  url: string;
  identifier: string;
  createdAt: Date;
  managed: boolean;
  available: boolean;
  roles: string[];
}

export interface BackupStickerData {
  id: string;
  name: string;
  description: string;
  tags: string;
  type: number;
  format: number;
  available: boolean;
  guildId: string;
  sortValue: number;
}

export interface BackupMemberData {
  id: string;
  user: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    system: boolean;
    banner: string | null;
    accentColor: number | null;
    flags: number;
    avatarDecoration: string | null;
    globalName: string | null;
    displayName: string;
    hexAccentColor: string | null;
    tag: string;
  };
  nickname: string | null;
  avatar: string | null;
  roles: string[];
  joinedAt: Date | null;
  premiumSince: Date | null;
  pending: boolean;
  communicationDisabledUntil: Date | null;
  permissions: string[];
  voice?: {
    channelId: string | null;
    sessionId: string | null;
    selfDeaf: boolean;
    selfMute: boolean;
    serverDeaf: boolean;
    serverMute: boolean;
    streaming: boolean;
    requestToSpeakTimestamp: Date | null;
    suppress: boolean;
  };
  presence?: {
    status: string;
    activities: any[];
    clientStatus: any;
  };
}

export interface BackupBanData {
  user: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    system: boolean;
    banner: string | null;
    accentColor: number | null;
    flags: number;
    avatarDecoration: string | null;
    globalName: string | null;
    displayName: string;
    hexAccentColor: string | null;
    tag: string;
  };
  reason: string | null;
}

export interface BackupInviteData {
  code: string;
  channelId: string;
  createdAt: Date;
  createdTimestamp: number;
  expiresAt: Date | null;
  expiresTimestamp: number | null;
  inviter?: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    system: boolean;
    banner: string | null;
    accentColor: number | null;
    flags: number;
    avatarDecoration: string | null;
    globalName: string | null;
    displayName: string;
    hexAccentColor: string | null;
    tag: string;
  };
  maxAge: number;
  maxUses: number;
  memberCount: number;
  presenceCount: number;
  targetApplication?: any;
  targetType?: number;
  targetUser?: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    system: boolean;
    banner: string | null;
    accentColor: number | null;
    flags: number;
    avatarDecoration: string | null;
    globalName: string | null;
    displayName: string;
    hexAccentColor: string | null;
    tag: string;
  };
  temporary: boolean;
  uses: number;
  url: string;
}

export interface BackupWebhookData {
  id: string;
  type: number;
  guildId: string;
  channelId: string;
  owner?: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
    bot: boolean;
    system: boolean;
    banner: string | null;
    flags: number;
  };
  name: string;
  avatar: string | null;
  token: string;
  applicationId: string | null;
  sourceGuild?: any;
  sourceChannel?: any;
  url: string;
}

export interface BackupGuildData {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  splash: string | null;
  discoverySplash: string | null;
  memberCount: number;
  memberCounts?: {
    approximate: number;
    online: number;
  };
  createdAt: Date;
  features: string[];
  verificationLevel: number;
  explicitContentFilter: number;
  defaultMessageNotifications: number;
  systemChannelId: string | null;
  systemChannelFlags: number;
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  premiumTier: number;
  premiumSubscriptionCount: number;
  preferredLocale: string;
  vanityURLCode: string | null;
  maxVideoChannelUsers: number;
  afkChannelId: string | null;
  afkTimeout: number;
  widgetEnabled: boolean;
  widgetChannelId: string | null;
  mfaLevel: number;
  applicationId: string | null;
  ownerId: string;
  large: boolean;
}

export interface AuditEvent {
  id: string;
  guildId: string;
  actionType: AuditActionType;
  executorId: string;
  targetId?: string;
  targetType?: string;
  changes: AuditChange[];
  reason?: string;
  timestamp: Date;
  metadata: {
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
  };
}

export enum AuditActionType {

  GUILD_UPDATE = 'guild_update',
  GUILD_DELETE = 'guild_delete',
  

  CHANNEL_CREATE = 'channel_create',
  CHANNEL_UPDATE = 'channel_update',
  CHANNEL_DELETE = 'channel_delete',
  

  ROLE_CREATE = 'role_create',
  ROLE_UPDATE = 'role_update',
  ROLE_DELETE = 'role_delete',
  

  MEMBER_JOIN = 'member_join',
  MEMBER_UPDATE = 'member_update',
  MEMBER_LEAVE = 'member_leave',
  MEMBER_BAN = 'member_ban',
  MEMBER_UNBAN = 'member_unban',
  

  MESSAGE_DELETE = 'message_delete',
  MESSAGE_BULK_DELETE = 'message_bulk_delete',
  MESSAGE_UPDATE = 'message_update',
  

  EMOJI_CREATE = 'emoji_create',
  EMOJI_UPDATE = 'emoji_update',
  EMOJI_DELETE = 'emoji_delete',
  

  STICKER_CREATE = 'sticker_create',
  STICKER_UPDATE = 'sticker_update',
  STICKER_DELETE = 'sticker_delete',
  

  WEBHOOK_CREATE = 'webhook_create',
  WEBHOOK_UPDATE = 'webhook_update',
  WEBHOOK_DELETE = 'webhook_delete',
  

  INVITE_CREATE = 'invite_create',
  INVITE_DELETE = 'invite_delete',
  

  INTEGRATION_CREATE = 'integration_create',
  INTEGRATION_UPDATE = 'integration_update',
  INTEGRATION_DELETE = 'integration_delete'
}

export interface AuditChange {
  key: string;
  oldValue?: any;
  newValue?: any;
}

export interface WhitelistConfig {
  users: string[];
  roles: string[];
  channels: string[];
  permissions: string[];
  actions: string[];
  enabled: boolean;
  bypassAll: boolean;
}

export interface GuardConfig {
  enabled: boolean;
  logChannelId?: string;
  backupOnDelete: boolean;
  backupOnUpdate: boolean;
  autoRestore: boolean;
  whitelist: WhitelistConfig;
  guildId: string;
  auditChannelId?: string;
  webhookUrl?: string;
  protection: {
    channels: boolean;
    roles: boolean;
    emojis: boolean;
    stickers: boolean;
    webhooks: boolean;
    invites: boolean;
    members: boolean;
    guild: boolean;
  };
  limits: {
    maxRoleDeletions: number;
    maxChannelDeletions: number;
    maxEmojiDeletions: number;
    maxStickerDeletions: number;
    maxWebhookCreations: number;
    maxInviteCreations: number;
    timeWindow: number;
  };  
  actions: {
    onViolation: GuardAction[];
    onSuspiciousActivity: GuardAction[];
  };
}

export enum GuardAction {
  LOG = 'log',
  NOTIFY = 'notify',
  KICK = 'kick',
  BAN = 'ban',
  REMOVE_ROLE = 'remove_role',
  TIMEOUT = 'timeout',
  RESTORE = 'restore',
  LOCKDOWN = 'lockdown'
}

export interface BackupConfig {
  enabled: boolean;
  interval: number;
  retentionDays: number;
  maxSize: number;
  compression: boolean;
  encryption: boolean;
  encryptionKey?: string;
  storage: {
    type: 'local' | 's3' | 'gcs';
    path?: string;
    bucket?: string;
    region?: string;
  };
  include: {
    channels: boolean;
    roles: boolean;
    emojis: boolean;
    stickers: boolean;
    members: boolean;
    bans: boolean;
    invites: boolean;
    webhooks: boolean;
    guild: boolean;
  };
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  acquireTimeout: number;
  timeout: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  retryDelayOnFailover: number;
  maxRetriesPerRequest: number;
}

export interface ElasticsearchConfig {
  node: string;
  username?: string;
  password?: string;
  indexPrefix: string;
  numberOfShards: number;
  numberOfReplicas: number;
} 