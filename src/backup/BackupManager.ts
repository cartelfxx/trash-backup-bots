import { Client, Guild, GuildMember, ChannelType, PermissionFlagsBits } from 'discord.js';
import { Logger } from '../utils/logger';
import { DatabaseManager } from '../database/DatabaseManager';
import { ElasticsearchManager } from '../database/ElasticsearchManager';
import { AuditManager } from '../audit/AuditManager';
import { BackupData, BackupConfig } from '../utils/types';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

export class BackupManager {
  private client: Client;
  private logger: Logger;
  private databaseManager: DatabaseManager;
  private elasticsearchManager: ElasticsearchManager;
  private auditManager: AuditManager;
  private targetGuildId: string;
  private configs: Map<string, BackupConfig> = new Map();
  private isRunning: boolean = false;
  private backupIntervals: Map<string, NodeJS.Timeout> = new Map();
  private backupQueue: Map<string, Promise<BackupData | null>> = new Map();

  constructor(
    client: Client,
    databaseManager: DatabaseManager,
    elasticsearchManager: ElasticsearchManager,
    auditManager: AuditManager,
    targetGuildId: string
  ) {
    this.client = client;
    this.logger = Logger.getInstance();
    this.databaseManager = databaseManager;
    this.elasticsearchManager = elasticsearchManager;
    this.auditManager = auditManager;
    this.targetGuildId = targetGuildId;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.logger.info('Yedekleme Yöneticisi başlatıldı');

    await this.loadConfiguration();
    await this.createInitialBackup();
    this.startScheduledBackup();
    this.setupEventHandlers();

    this.logger.info('Yedekleme Yöneticisi çalışıyor');
  }

  public async stop(): Promise<void> {
    this.isRunning = false;

    for (const interval of this.backupIntervals.values()) {
      clearInterval(interval);
    }
    this.backupIntervals.clear();

    const ongoingBackups = Array.from(this.backupQueue.values());
    if (ongoingBackups.length > 0) {
      this.logger.info(`${ongoingBackups.length} devam eden yedekleme tamamlanması bekleniyor...`);
      await Promise.all(ongoingBackups);
    }

    this.logger.info('Yedekleme Yöneticisi durduruldu');
  }

  private async loadConfiguration(): Promise<void> {
    try {
      const guild = this.client.guilds.cache.get(this.targetGuildId);
      if (!guild) {
        this.logger.error(`Hedef sunucu ${this.targetGuildId} bulunamadı`);
        return;
      }

      const config = await this.databaseManager.getBackupConfig(this.targetGuildId);
      if (config) {
        this.configs.set(this.targetGuildId, config);
        this.logger.backup(`Sunucu için yedekleme yapılandırması yüklendi: ${guild.name}`);
      } else {
        const defaultConfig = this.createDefaultConfig(this.targetGuildId);
        await this.databaseManager.saveBackupConfig(this.targetGuildId, defaultConfig);
        this.configs.set(this.targetGuildId, defaultConfig);
        this.logger.backup(`Sunucu için varsayılan yedekleme yapılandırması oluşturuldu: ${guild.name}`);
      }
    } catch (error) {
      this.logger.error('Yedekleme yapılandırması yüklenirken hata:', error);
    }
  }

  private createDefaultConfig(guildId: string): BackupConfig {
    return {
      enabled: true,
      interval: parseInt(process.env.BACKUP_INTERVAL || '3600000'),
      retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30'),
      maxSize: parseInt(process.env.MAX_BACKUP_SIZE || '1000000000'),
      compression: true,
      encryption: false,
      encryptionKey: undefined,
      storage: {
        type: 'local',
        path: './backups'
      },
      include: {
        channels: true,
        roles: true,
        emojis: true,
        stickers: true,
        members: true,
        bans: true,
        invites: true,
        webhooks: true,
        guild: true
      }
    };
  }

  private startScheduledBackup(): void {
    const config = this.configs.get(this.targetGuildId);
    if (!config?.enabled) return;

    const interval = setInterval(async () => {
      await this.createBackup(this.targetGuildId);
    }, config.interval);

    this.backupIntervals.set(this.targetGuildId, interval);
    this.logger.backup(`Sunucu ${this.targetGuildId} için yedekleme her ${config.interval / 1000 / 60} dakikada bir planlandı`);
  }

  private setupEventHandlers(): void {
    this.client.on('guildUpdate', (oldGuild, newGuild) => {
      if (newGuild.id === this.targetGuildId) {
        this.handleSignificantChange(newGuild.id, 'guild_update');
      }
    });

    this.client.on('channelDelete', (channel) => {
      if ('guild' in channel && channel.guild && channel.guild.id === this.targetGuildId) {
        this.handleSignificantChange(channel.guild.id, 'channel_delete');
      }
    });

    this.client.on('roleDelete', (role) => {
      if (role.guild.id === this.targetGuildId) {
        this.handleSignificantChange(role.guild.id, 'role_delete');
      }
    });
  }

  private async handleSignificantChange(guildId: string, changeType: string): Promise<void> {
    if (guildId !== this.targetGuildId) return;
    
    const config = this.configs.get(guildId);
    if (!config?.enabled) return;

    this.logger.backup(`Anlamlı değişiklik tespit edildi (${changeType}), acil yedekleme oluşturuluyor: ${guildId}`);
    await this.createBackup(guildId, true);
  }

  public async createBackup(guildId: string, immediate: boolean = false): Promise<BackupData | null> {
    try {
      if (this.backupQueue.has(guildId)) {
        this.logger.backup(`Sunucu ${guildId} için yedekleme zaten devam ediyor, atlanıyor`);
        return null;
      }

      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.logger.error(`Sunucu ${guildId} bulunamadı`);
        return null;
      }

      const config = this.configs.get(guildId);
      if (!config?.enabled) {
        this.logger.backup(`Sunucu ${guild.name} için yedekleme devre dışı, atlanıyor`);
        return null;
      }

      const backupPromise = this.performBackup(guild, config, immediate);
      this.backupQueue.set(guildId, backupPromise);

      try {
        const backup = await backupPromise;
        this.logger.backup(`Sunucu ${guild.name} için yedekleme tamamlandı`);
        return backup;
      } finally {
        this.backupQueue.delete(guildId);
      }
    } catch (error) {
      this.logger.error('Yedekleme oluşturma hatası:', error);
      return null;
    }
  }

  private async performBackup(guild: Guild, config: BackupConfig, immediate: boolean): Promise<BackupData> {
    const backupId = uuidv4();
    const timestamp = new Date();
    const version = '1.0.0';

    this.logger.backup(`Sunucu ${guild.name} için yedekleme başlatılıyor (${backupId})`);

    const backupData: any = {
      guild: {
        id: guild.id,
        name: guild.name,
        description: guild.description,
        icon: guild.icon,
        banner: guild.banner,
        splash: guild.splash,
        discoverySplash: guild.discoverySplash,
        memberCount: guild.memberCount || 0,
        memberCounts: guild.approximateMemberCount ? {
          approximate: guild.approximateMemberCount,
          online: guild.approximatePresenceCount
        } : null,
        createdAt: guild.createdAt,
        features: guild.features,
        verificationLevel: guild.verificationLevel,
        explicitContentFilter: guild.explicitContentFilter,
        defaultMessageNotifications: guild.defaultMessageNotifications,
        systemChannelId: guild.systemChannelId,
        systemChannelFlags: guild.systemChannelFlags,
        rulesChannelId: guild.rulesChannelId,
        publicUpdatesChannelId: guild.publicUpdatesChannelId,
        premiumTier: guild.premiumTier,
        premiumSubscriptionCount: guild.premiumSubscriptionCount,
        preferredLocale: guild.preferredLocale,
        vanityURLCode: guild.vanityURLCode,
        maxVideoChannelUsers: guild.maxVideoChannelUsers,
        afkChannelId: guild.afkChannelId,
        afkTimeout: guild.afkTimeout,
        widgetEnabled: guild.widgetEnabled,
        widgetChannelId: guild.widgetChannelId,
        mfaLevel: guild.mfaLevel,
        applicationId: guild.applicationId,
        ownerId: guild.ownerId,
        large: guild.large
      },
      channels: [],
      roles: [],
      emojis: [],
      stickers: [],
      members: [],
      bans: [],
      invites: [],
      webhooks: []
    };

    if (config.include.channels) {
      this.logger.backup(`Sunucu ${guild.name} için kanallar toplanıyor`);
      const channels = guild.channels.cache.map(channel => {
        const parentId = (channel as any).parentId ?? null;
        
        const baseChannel = {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          guildId: guild.id,
          parent_id: parentId,
        };

        if ('position' in channel) {
          (baseChannel as any).position = channel.position;
        }
        if ('permissionOverwrites' in channel) {
          (baseChannel as any).permissionOverwrites = channel.permissionOverwrites?.cache.map((perm: any) => ({
            id: perm.id,
            type: perm.type,
            allow: perm.allow.toArray(),
            deny: perm.deny.toArray()
          })) || [];
        }

        if ('parentId' in channel) {
          (baseChannel as any).parentId = channel.parentId;
        }

        switch (channel.type) {
          case ChannelType.GuildText:
            return {
              ...baseChannel,
              topic: (channel as any).topic,
              nsfw: (channel as any).nsfw,
              rateLimitPerUser: (channel as any).rateLimitPerUser,
              lastMessageId: (channel as any).lastMessageId,
              guildId: guild.id
            };
          case ChannelType.GuildVoice:
            return {
              ...baseChannel,
              bitrate: (channel as any).bitrate,
              userLimit: (channel as any).userLimit,
              rtcRegion: (channel as any).rtcRegion,
              guildId: guild.id
            };
          case ChannelType.GuildCategory:
            return {
              ...baseChannel,
              guildId: guild.id
            };
          case ChannelType.GuildAnnouncement:
            return {
              ...baseChannel,
              topic: (channel as any).topic,
              nsfw: (channel as any).nsfw,
              lastMessageId: (channel as any).lastMessageId,
              guildId: guild.id
            };
          case ChannelType.GuildStageVoice:
            return {
              ...baseChannel,
              topic: (channel as any).topic,
              nsfw: (channel as any).nsfw,
              bitrate: (channel as any).bitrate,
              userLimit: (channel as any).userLimit,
              rtcRegion: (channel as any).rtcRegion,
              guildId: guild.id
            };
          case ChannelType.GuildForum:
            return {
              ...baseChannel,
              topic: (channel as any).topic,
              nsfw: (channel as any).nsfw,
              rateLimitPerUser: (channel as any).rateLimitPerUser,
              lastMessageId: (channel as any).lastMessageId,
              availableTags: (channel as any).availableTags,
              defaultReactionEmoji: (channel as any).defaultReactionEmoji,
              defaultThreadRateLimitPerUser: (channel as any).defaultThreadRateLimitPerUser,
              defaultSortOrder: (channel as any).defaultSortOrder,
              defaultForumLayout: (channel as any).defaultForumLayout,
              guildId: guild.id
            };
          default:
            return {
              ...baseChannel,
              guildId: guild.id
            };
        }
      });
      backupData.channels = channels;
    }

    if (config.include.roles) {
      this.logger.backup(`Sunucu ${guild.name} için roller toplanıyor`);
      const roles = guild.roles.cache.map(role => ({
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        position: role.position,
        permissions: role.permissions.toArray(),
        managed: role.managed,
        mentionable: role.mentionable,
        icon: role.icon,
        unicodeEmoji: role.unicodeEmoji,
        tags: role.tags ? {
          botId: role.tags.botId,
          integrationId: role.tags.integrationId,
          premiumSubscriberRole: role.tags.premiumSubscriberRole,
          subscriptionListingId: role.tags.subscriptionListingId,
          availableForPurchase: role.tags.availableForPurchase,
          guildConnections: role.tags.guildConnections
        } : null
      }));
      backupData.roles = roles;
    }

    if (config.include.emojis) {
      this.logger.backup(`Sunucu ${guild.name} için emojiler toplanıyor`);
      const emojis = guild.emojis.cache.map(emoji => ({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        url: emoji.imageURL(),
        identifier: emoji.identifier,
        createdAt: emoji.createdAt,
        managed: emoji.managed,
        available: emoji.available,
        roles: emoji.roles?.cache.map(role => role.id) || []
      }));
      backupData.emojis = emojis;
    }

    if (config.include.stickers) {
      this.logger.backup(`Sunucu ${guild.name} için stikerler toplanıyor`);
      const stickers = guild.stickers.cache.map(sticker => ({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
        type: sticker.type,
        format: sticker.format,
        available: sticker.available,
        guildId: sticker.guildId,
        sortValue: sticker.sortValue
      }));
      backupData.stickers = stickers;
    }

    if (config.include.members) {
      this.logger.backup(`Sunucu ${guild.name} için üyeler toplanıyor`);
      const members = guild.members.cache.map(member => ({
        id: member.id,
        user: {
          id: member.user.id,
          username: member.user.username,
          discriminator: member.user.discriminator,
          avatar: member.user.avatar,
          bot: member.user.bot,
          system: member.user.system,
          banner: member.user.banner,
          accentColor: member.user.accentColor,
          flags: member.user.flags,
          avatarDecoration: member.user.avatarDecoration,
          globalName: member.user.globalName,
          displayName: member.user.displayName,
          hexAccentColor: member.user.hexAccentColor,
          tag: member.user.tag
        },
        nickname: member.nickname,
        avatar: member.avatar,
        roles: member.roles.cache.map(role => role.id),
        joinedAt: member.joinedAt,
        premiumSince: member.premiumSince,
        pending: member.pending,
        communicationDisabledUntil: member.communicationDisabledUntil,
        permissions: member.permissions.toArray(),
        voice: member.voice ? {
          channelId: member.voice.channelId,
          sessionId: member.voice.sessionId,
          selfDeaf: member.voice.selfDeaf,
          selfMute: member.voice.selfMute,
          serverDeaf: member.voice.serverDeaf,
          serverMute: member.voice.serverMute,
          streaming: member.voice.streaming,
          requestToSpeakTimestamp: member.voice.requestToSpeakTimestamp,
          suppress: member.voice.suppress
        } : null,
        presence: member.presence ? {
          status: member.presence.status,
          activities: member.presence.activities,
          clientStatus: member.presence.clientStatus
        } : null
      }));
      backupData.members = members;
    }

    if (config.include.bans) {
      this.logger.backup(`Sunucu ${guild.name} için banlar toplanıyor`);
      try {
        const bans = await guild.bans.fetch();
        backupData.bans = bans.map(ban => ({
          user: {
            id: ban.user.id,
            username: ban.user.username,
            discriminator: ban.user.discriminator,
            avatar: ban.user.avatar,
            bot: ban.user.bot,
            system: ban.user.system,
            banner: ban.user.banner,
            accentColor: ban.user.accentColor,
            flags: ban.user.flags,
            avatarDecoration: ban.user.avatarDecoration,
            globalName: ban.user.globalName,
            displayName: ban.user.displayName,
            hexAccentColor: ban.user.hexAccentColor,
            tag: ban.user.tag
          },
          reason: ban.reason
        }));
      } catch (error) {
        this.logger.error(`Sunucu ${guild.name} için banlar toplanamadı:`, error);
        backupData.bans = [];
      }
    }

    if (config.include.invites) {
      this.logger.backup(`Sunucu ${guild.name} için davetler toplanıyor`);
      try {
        const invites = await guild.invites.fetch();
        backupData.invites = invites.map(invite => ({
          code: invite.code,
          channelId: invite.channelId,
          createdAt: invite.createdAt,
          createdTimestamp: invite.createdTimestamp,
          expiresAt: invite.expiresAt,
          expiresTimestamp: invite.expiresTimestamp,
          inviter: invite.inviter ? {
            id: invite.inviter.id,
            username: invite.inviter.username,
            discriminator: invite.inviter.discriminator,
            avatar: invite.inviter.avatar,
            bot: invite.inviter.bot,
            system: invite.inviter.system,
            banner: invite.inviter.banner,
            accentColor: invite.inviter.accentColor,
            flags: invite.inviter.flags,
            avatarDecoration: invite.inviter.avatarDecoration,
            globalName: invite.inviter.globalName,
            displayName: invite.inviter.displayName,
            hexAccentColor: invite.inviter.hexAccentColor,
            tag: invite.inviter.tag
          } : null,
          maxAge: invite.maxAge,
          maxUses: invite.maxUses,
          memberCount: invite.memberCount,
          presenceCount: invite.presenceCount,
          targetApplication: invite.targetApplication,
          targetType: invite.targetType,
          targetUser: invite.targetUser ? {
            id: invite.targetUser.id,
            username: invite.targetUser.username,
            discriminator: invite.targetUser.discriminator,
            avatar: invite.targetUser.avatar,
            bot: invite.targetUser.bot,
            system: invite.targetUser.system,
            banner: invite.targetUser.banner,
            accentColor: invite.targetUser.accentColor,
            flags: invite.targetUser.flags,
            avatarDecoration: invite.targetUser.avatarDecoration,
            globalName: invite.targetUser.globalName,
            displayName: invite.targetUser.displayName,
            hexAccentColor: invite.targetUser.hexAccentColor,
            tag: invite.targetUser.tag
          } : null,
          temporary: invite.temporary,
          uses: invite.uses,
          url: invite.url
        }));
      } catch (error) {
        this.logger.error(`Sunucu ${guild.name} için davetler toplanamadı:`, error);
        backupData.invites = [];
      }
    }

    if (config.include.webhooks) {
      this.logger.backup(`Sunucu ${guild.name} için webhookler toplanıyor`);
      try {
        const webhooks = await guild.fetchWebhooks();
        backupData.webhooks = webhooks.map(webhook => ({
          id: webhook.id,
          type: webhook.type,
          guildId: webhook.guildId,
          channelId: webhook.channelId,
          owner: webhook.owner ? {
            id: webhook.owner.id,
            username: webhook.owner.username,
            discriminator: webhook.owner.discriminator,
            avatar: webhook.owner.avatar,
            bot: webhook.owner.bot,
            system: webhook.owner.system,
            banner: webhook.owner.banner,
            flags: webhook.owner.flags
          } : null,
          name: webhook.name,
          avatar: webhook.avatar,
          token: webhook.token,
          applicationId: webhook.applicationId,
          sourceGuild: webhook.sourceGuild,
          sourceChannel: webhook.sourceChannel,
          url: webhook.url
        }));
      } catch (error) {
        this.logger.error(`Sunucu ${guild.name} için webhookler toplanamadı:`, error);
        backupData.webhooks = [];
      }
    }

    const backup: BackupData = {
      id: backupId,
      guildId: guild.id,
      timestamp,
      version,
      data: backupData,
      metadata: {
        createdBy: this.client.user?.id || 'system',
        description: immediate ? 'Acil yedekleme' : 'Zamanlanmış yedekleme',
        size: 0,
        checksum: ''
      }
    };

    const backupString = JSON.stringify(backup);
    backup.metadata.size = Buffer.byteLength(backupString, 'utf8');
    backup.metadata.checksum = crypto.createHash('sha256').update(backupString).digest('hex');

    await this.databaseManager.saveBackup(backup);
    await this.elasticsearchManager.indexBackup(backup);
    await this.cleanupOldBackups(guild.id, config);

    this.logger.backup(`Sunucu ${guild.name} için yedekleme tamamlandı`);
    return backup;
  }

  private async cleanupOldBackups(guildId: string, config: BackupConfig): Promise<void> {
    try {
      const backups = await this.databaseManager.getBackupsByGuild(guildId, 1000);
      const cutoffDate = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);

      for (const backup of backups) {
        if (backup.timestamp < cutoffDate) {
          await this.deleteBackup(backup.id);
          this.logger.backup(`Eski yedek temizlendi: ${backup.id}`);
        }
      }
    } catch (error) {
      this.logger.error('Eski yedeklerin temizlenmesi hatası:', error);
    }
  }

  public async getBackup(backupId: string): Promise<BackupData | null> {
    return await this.databaseManager.getBackup(backupId);
  }

  public async getBackupsByGuild(guildId: string, limit: number = 10): Promise<BackupData[]> {
    return await this.databaseManager.getBackupsByGuild(guildId, limit);
  }

  public async deleteBackup(backupId: string): Promise<void> {
    try {
      await this.databaseManager.deleteBackup(backupId);
      this.logger.backup(`Yedek silindi: ${backupId}`);
    } catch (error) {
      this.logger.error('Yedek silme hatası:', error);
      throw error;
    }
  }

  public async updateConfig(guildId: string, config: BackupConfig): Promise<void> {
    await this.databaseManager.saveBackupConfig(guildId, config);
    this.configs.set(guildId, config);
  }

  public async getConfig(guildId: string): Promise<BackupConfig | null> {
    return await this.databaseManager.getBackupConfig(guildId);
  }

  public async restoreBackup(backupId: string, guildId: string): Promise<void> {
    this.logger.backup(`Yedek geri yükleme özelliği henüz uygulanmadı: ${backupId}`);
  }

  private async createInitialBackup(): Promise<void> {
    try {
      this.logger.info('Hedef sunucu için ilk yedekleme oluşturuluyor...');
      
      const guild = this.client.guilds.cache.get(this.targetGuildId);
      if (!guild) {
        this.logger.error(`İlk yedekleme için hedef sunucu ${this.targetGuildId} bulunamadı.`);
        return;
      }

      const config = this.configs.get(this.targetGuildId);
      if (config?.enabled) {
        this.logger.backup(`Sunucu için ilk yedekleme oluşturuluyor: ${guild.name}`);
        await this.createBackup(this.targetGuildId, true)
          .then(backup => {
            if (backup) {
              this.logger.backup(`${guild.name} için ilk yedekleme tamamlandı`);
            }
          })
          .catch(error => {
            this.logger.error(`${guild.name} için ilk yedekleme başarısız:`, error);
          });
      }
    } catch (error) {
      this.logger.error('İlk yedekleme oluşturulurken hata:', error);
    }
  }

  public async restoreFullGuild(backupId: string): Promise<boolean> {
    try {
      this.logger.backup(`Tam sunucu geri yükleme başlatıldı, yedek: ${backupId}`);
      
      await this.restoreGuildSettings(backupId);
      await this.restoreRoles(backupId);
      await this.restoreChannels(backupId);
      await this.restoreEmojis(backupId);
      await this.restoreStickers(backupId);
      await this.restoreWebhooks(backupId);
      await this.restoreMemberRoles(backupId);
      
      this.logger.backup(`Tam sunucu geri yükleme tamamlandı: ${backupId}`);
      return true;
    } catch (error) {
      this.logger.error('Tam sunucu geri yükleme hatası:', error);
      return false;
    }
  }

  private async restoreGuildSettings(backupId: string): Promise<void> {
    const guildData = await this.databaseManager.getGuildData(backupId);
    if (!guildData) return;

    const guild = this.client.guilds.cache.get(guildData.id);
    if (!guild) return;

    try {
      await guild.edit({
        name: guildData.name,
        description: guildData.description,
        icon: guildData.icon,
        banner: guildData.banner,
        splash: guildData.splash,
        discoverySplash: guildData.discovery_splash,
        verificationLevel: guildData.verification_level,
        explicitContentFilter: guildData.explicit_content_filter,
        defaultMessageNotifications: guildData.default_message_notifications,
        systemChannel: guildData.system_channel_id ? guild.channels.cache.get(guildData.system_channel_id) as any : null,
        rulesChannel: guildData.rules_channel_id ? guild.channels.cache.get(guildData.rules_channel_id) as any : null,
        publicUpdatesChannel: guildData.public_updates_channel_id ? guild.channels.cache.get(guildData.public_updates_channel_id) as any : null,
        preferredLocale: guildData.preferred_locale,
        reason: `Sunucu ayarları yedekten geri yüklendi: ${backupId}`
      });
      this.logger.backup(`Sunucu ayarları geri yüklendi: ${guild.name}`);
    } catch (error) {
      this.logger.error('Sunucu ayarları geri yükleme hatası:', error);
    }
  }

  private async restoreRoles(backupId: string): Promise<void> {
    const roles = await this.databaseManager.getRolesData(backupId);
    if (roles.length === 0) return;
    
    const guildId = roles[0].guild_id || roles[0].backup_id;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    for (const roleData of roles) {
      try {
        const fullRoleData = await this.databaseManager.getRoleWithFullData(backupId, roleData.id);
        if (!fullRoleData) continue;

        let existingRole = guild.roles.cache.get(roleData.id);
        
        let permissions;
        if (fullRoleData.permissions_array) {
          const permissionArray = JSON.parse(fullRoleData.permissions_array);
          permissions = permissionArray;
        } else if (fullRoleData.permissions_new) {
          permissions = JSON.parse(fullRoleData.permissions_new);
        } else if (fullRoleData.permissions) {
          permissions = BigInt(fullRoleData.permissions);
        } else {
          permissions = 0n;
        }

        const roleOptions = {
          name: roleData.name,
          color: roleData.color,
          hoist: roleData.hoist,
          position: roleData.position,
          permissions: permissions,
          mentionable: roleData.mentionable,
          icon: roleData.icon || undefined,
          unicodeEmoji: roleData.unicode_emoji || undefined,
          reason: `Rol yedekten geri yüklendi: ${backupId}`
        };

        if (!existingRole) {
          const newRole = await guild.roles.create(roleOptions);
          this.logger.backup(`Rol oluşturuldu: ${roleData.name}`);
        } else {
          await existingRole.edit(roleOptions);
          this.logger.backup(`Rol güncellendi: ${roleData.name}`);
        }
      } catch (error) {
        this.logger.error(`Rol geri yükleme hatası ${roleData.name}:`, error);
      }
    }
  }

  private async restoreChannels(backupId: string): Promise<void> {
    const channels = await this.databaseManager.getChannelsData(backupId);
    if (channels.length === 0) return;
    
    const guild = this.client.guilds.cache.get(channels[0].guildId);
    if (!guild) return;

    const categories = channels.filter(c => c.type === 4);
    for (const categoryData of categories) {
      await this.restoreCategoryAndChildren(backupId, categoryData.id);
    }

    const otherChannels = channels.filter(c => c.type !== 4);
    for (const channelData of otherChannels) {
      await this.restoreChannelUltraFast(backupId, channelData.id);
    }
  }

  private async restoreChannelInternal(guild: Guild, channelData: any, backupId: string): Promise<void> {
    try {
      let channel = guild.channels.cache.get(channelData.id);
      
      const channelOptions: any = {
        name: channelData.name,
        type: channelData.type,
        topic: channelData.topic,
        nsfw: channelData.nsfw,
        bitrate: channelData.bitrate,
        userLimit: channelData.userLimit,
        rateLimitPerUser: channelData.rateLimitPerUser,
        rtcRegion: channelData.rtcRegion,
        parent: channelData.parentId ? guild.channels.cache.get(channelData.parentId) as any : null,
        reason: `Kanal yedekten geri yüklendi: ${backupId}`
      };

      if (!channel) {
        channel = await guild.channels.create(channelOptions);
        this.logger.backup(`Kanal oluşturuldu: ${channelData.name}`);
      } else {
        await channel.edit(channelOptions);
        this.logger.backup(`Kanal güncellendi: ${channelData.name}`);
      }
    } catch (error) {
      this.logger.error(`Kanal geri yükleme hatası ${channelData.name}:`, error);
    }
  }

  private async restoreEmojis(backupId: string): Promise<void> {
    const emojis = await this.databaseManager.getEmojisData(backupId);
    if (emojis.length === 0) return;
    
    const guild = this.client.guilds.cache.get(emojis[0].guildId);
    if (!guild) return;

    for (const emojiData of emojis) {
      try {
        const existingEmoji = guild.emojis.cache.get(emojiData.id);
        if (!existingEmoji) {
          const response = await fetch(emojiData.url);
          const buffer = await response.arrayBuffer();
          
          await guild.emojis.create({
            attachment: Buffer.from(buffer),
            name: emojiData.name,
            reason: `Emoji yedekten geri yüklendi: ${backupId}`
          });
          this.logger.backup(`Emoji oluşturuldu: ${emojiData.name}`);
        }
      } catch (error) {
        this.logger.error(`Emoji geri yükleme hatası ${emojiData.name}:`, error);
      }
    }
  }

  private async restoreStickers(backupId: string): Promise<void> {
    const stickers = await this.databaseManager.getStickersData(backupId);
    if (stickers.length === 0) return;
    
    const guild = this.client.guilds.cache.get(stickers[0].guildId);
    if (!guild) return;

    for (const stickerData of stickers) {
      try {
        const existingSticker = guild.stickers.cache.get(stickerData.id);
        if (!existingSticker) {
          const response = await fetch(stickerData.url);
          const buffer = await response.arrayBuffer();
          
          await guild.stickers.create({
            file: Buffer.from(buffer),
            name: stickerData.name,
            tags: stickerData.tags,
            description: stickerData.description,
            reason: `Stiker yedekten geri yüklendi: ${backupId}`
          });
          this.logger.backup(`Stiker oluşturuldu: ${stickerData.name}`);
        }
      } catch (error) {
        this.logger.error(`Stiker geri yükleme hatası ${stickerData.name}:`, error);
      }
    }
  }

  private async restoreWebhooks(backupId: string): Promise<void> {
    const webhooks = await this.databaseManager.getWebhooksData(backupId);
    if (webhooks.length === 0) return;
    
    const guild = this.client.guilds.cache.get(webhooks[0].guildId);
    if (!guild) return;

    for (const webhookData of webhooks) {
      try {
        const channel = guild.channels.cache.get(webhookData.channelId);
        if (channel && 'createWebhook' in channel) {
          await channel.createWebhook({
            name: webhookData.name,
            avatar: webhookData.avatar,
            reason: `Webhook yedekten geri yüklendi: ${backupId}`
          });
          this.logger.backup(`Webhook oluşturuldu: ${webhookData.name}`);
        }
      } catch (error) {
        this.logger.error(`Webhook geri yükleme hatası ${webhookData.name}:`, error);
      }
    }
  }

  private async restoreMemberRoles(backupId: string): Promise<void> {
    const members = await this.databaseManager.getMembersData(backupId);
    if (members.length === 0) return;
    
    const guild = this.client.guilds.cache.get(members[0].guildId);
    if (!guild) return;

    for (const memberData of members) {
      try {
        const member = await guild.members.fetch(memberData.id);
        const roles = JSON.parse(memberData.roles || '[]');
        
        for (const roleId of roles) {
          const role = guild.roles.cache.get(roleId);
          if (role && !member.roles.cache.has(roleId)) {
            await member.roles.add(role, `Roller yedekten geri yüklendi: ${backupId}`);
          }
        }
        
        this.logger.backup(`Üye rolleri geri yüklendi: ${member.user.tag}`);
      } catch (error) {
        this.logger.error(`Üye rolleri geri yükleme hatası ${memberData.id}:`, error);
      }
    }
  }

  public async restoreRole(backupId: string, roleId: string): Promise<boolean> {
    try {
      this.logger.backup(`Rol geri yükleme başlatılıyor: ${roleId} (yedek: ${backupId})`);
      
      let roleData = await this.databaseManager.getRoleWithFullData(backupId, roleId);
      
      if (!roleData) {
        this.logger.backup(`Rol birleşik verilerde bulunamadı, ayrı tablolarda aranıyor...`);
        roleData = await this.databaseManager.getRoleData(backupId, roleId);
        
        if (!roleData) {
          roleData = await this.databaseManager.getRoleBackupDataById(backupId, roleId);
        }
      }
        
      if (!roleData) {
        this.logger.backup(`Rol ayrı tablolarda bulunamadı, ana yedek verilerinde aranıyor...`);
        const backup = await this.databaseManager.getBackup(backupId);
        if (backup && backup.data && backup.data.roles) {
          const roleFromBackup = backup.data.roles.find((r: any) => r.id === roleId);
          if (roleFromBackup) {
            this.logger.backup(`Rol ana yedek verilerinde bulundu, yedek yöntemi kullanılıyor`);
            return await this.restoreRoleFromBackupData(backupId, roleId, roleFromBackup);
          }
        }
        
        this.logger.backup(`Rol mevcut yedekte bulunamadı, en son yedek deneniyor...`);
        const latestBackup = await this.databaseManager.getLatestBackup(this.targetGuildId);
        if (latestBackup && latestBackup.id !== backupId) {
          this.logger.backup(`En son yedekten geri yüklenmeye çalışılıyor: ${latestBackup.id}`);
          return await this.restoreRole(latestBackup.id, roleId);
        }
        
        this.logger.error(`Rol verisi bulunamadı yedek ${backupId}, rol ${roleId}`);
        return false;
      }

      const guildId = roleData.guild_id || this.targetGuildId;
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.logger.error(`Sunucu bulunamadı: ${guildId}`);
        return false;
      }

      let existingRole = guild.roles.cache.get(roleId);
      
      let permissions;
      if (roleData.permissions_array) {
        const permissionArray = JSON.parse(roleData.permissions_array);
        permissions = permissionArray;
      } else if (roleData.permissions_new) {
        permissions = JSON.parse(roleData.permissions_new);
      } else if (roleData.permissions) {
        permissions = BigInt(roleData.permissions);
      } else {
        permissions = 0n;
      }

      const roleOptions = {
        name: roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        position: roleData.position,
        permissions: permissions,
        mentionable: roleData.mentionable,
        icon: roleData.icon || undefined,
        unicodeEmoji: roleData.unicodeEmoji || undefined,
        reason: `Rol yedekten geri yüklendi: ${backupId}`
      };

      if (!existingRole) {
        const newRole = await guild.roles.create(roleOptions);
        this.logger.backup(`Rol oluşturuldu: ${roleData.name} (${newRole.id})`);
        await this.fastAssignRoleToMembers(guild, newRole, backupId, roleId);
      } else {
        await existingRole.edit(roleOptions);
        this.logger.backup(`Rol güncellendi: ${roleData.name} (${existingRole.id})`);
        await this.fastAssignRoleToMembers(guild, existingRole, backupId, roleId);
      }

      this.logger.backup(`Rol geri yükleme tamamlandı: ${roleData.name}`);
      return true;

    } catch (error) {
      this.logger.error('Rol geri yükleme hatası:', error);
      return false;
    }
  }

  private async restoreRoleFromBackupData(backupId: string, roleId: string, roleData: any): Promise<boolean> {
    try {
      const guild = this.client.guilds.cache.get(this.targetGuildId);
      if (!guild) {
        this.logger.error(`Sunucu bulunamadı: ${this.targetGuildId}`);
        return false;
      }

      let existingRole = guild.roles.cache.get(roleId);
      
      let permissions = 0n;
      if (roleData.permissions && Array.isArray(roleData.permissions)) {
        const { PermissionFlagsBits } = await import('discord.js');
        for (const permName of roleData.permissions) {
          if (PermissionFlagsBits[permName as keyof typeof PermissionFlagsBits]) {
            permissions |= PermissionFlagsBits[permName as keyof typeof PermissionFlagsBits];
          }
        }
      }

      const roleOptions = {
        name: roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        position: roleData.position,
        permissions: permissions,
        mentionable: roleData.mentionable,
        icon: roleData.icon || undefined,
        unicodeEmoji: roleData.unicodeEmoji || undefined,
        reason: `Rol yedekten geri yüklendi: ${backupId} (yedek yöntemi)`
      };

      if (!existingRole) {
        const newRole = await guild.roles.create(roleOptions);
        this.logger.backup(`Rol oluşturuldu (yedek): ${roleData.name} (${newRole.id})`);
        await this.fastAssignRoleToMembers(guild, newRole, backupId, roleId);
      } else {
        await existingRole.edit(roleOptions);
        this.logger.backup(`Rol güncellendi (yedek): ${roleData.name} (${existingRole.id})`);
        await this.fastAssignRoleToMembers(guild, existingRole, backupId, roleId);
      }

      this.logger.backup(`Rol geri yükleme tamamlandı (yedek): ${roleData.name}`);
      return true;

    } catch (error) {
      this.logger.error('Rol geri yükleme hatası (yedek):', error);
      return false;
    }
  }

  private async fastAssignRoleToMembers(guild: Guild, role: any, backupId: string, roleId: string): Promise<void> {
    try {
      const startTime = Date.now();
      
      const membersWithRole = await this.databaseManager.getMembersWithRole(backupId, roleId);
      const memberIdsWithRole = new Set(membersWithRole.map(m => m.id));
      
      this.logger.backup(`Hızlı rol ataması başlatılıyor, ${membersWithRole.length} üyeye rol atanıyor: ${role.name}`);

      await guild.members.fetch();
      
      const membersToAssign = guild.members.cache.filter(member => 
        memberIdsWithRole.has(member.id) && !member.roles.cache.has(role.id)
      );

      this.logger.backup(`Rol atanması gereken ${membersToAssign.size} üye var`);

      if (membersToAssign.size === 0) {
        this.logger.backup(`Tüm üyeler zaten rolüne sahip: ${role.name}`);
        return;
      }

      const memberArray = Array.from(membersToAssign.values());
      
      const BATCH_SIZE = 50;
      const batches = [];
      
      for (let i = 0; i < memberArray.length; i += BATCH_SIZE) {
        batches.push(memberArray.slice(i, i + BATCH_SIZE));
      }

      this.logger.backup(`${batches.length} toplu işlem işleniyor`);

      const CONCURRENT_BATCHES = 5;
      let processedCount = 0;
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
        const currentBatches = batches.slice(i, i + CONCURRENT_BATCHES);
        
        const batchPromises = currentBatches.map(async (batch, batchIndex) => {
          const batchStartTime = Date.now();
          const batchResults = await Promise.allSettled(
            batch.map(async (member) => {
              try {
                await member.roles.add(role, `Hızlı rol ataması yedekten: ${backupId}`);
                return { success: true, memberId: member.id };
              } catch (error) {
                this.logger.error(`Üye ${member.id} rolü atanamadı:`, error);
                return { success: false, memberId: member.id, error };
              }
            })
          );

          const batchSuccessCount = batchResults.filter(r => r.status === 'fulfilled' && r.value.success).length;
          const batchErrorCount = batchResults.length - batchSuccessCount;
          
          successCount += batchSuccessCount;
          errorCount += batchErrorCount;
          processedCount += batch.length;

          const batchTime = Date.now() - batchStartTime;
          const progress = ((processedCount / memberArray.length) * 100).toFixed(1);
          
          this.logger.backup(`Toplu işlem tamamlandı: ${i + batchIndex + 1}/${batches.length} - ${batchSuccessCount}/${batch.length} başarılı (${batchTime}ms) - İlerleme: ${progress}%`);

          return { batchSuccessCount, batchErrorCount, batchTime };
        });

        await Promise.all(batchPromises);

        if (i + CONCURRENT_BATCHES < batches.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const totalTime = Date.now() - startTime;
      const rate = (successCount / (totalTime / 1000)).toFixed(1);
      
      this.logger.backup(`Hızlı rol ataması tamamlandı: ${successCount}/${memberArray.length} başarılı, ${errorCount} hata - Toplam süre: ${totalTime}ms (${rate} kullanıcı/saniye)`);
      
      if (errorCount > 0) {
        this.logger.error(`Rol atama hataları: ${errorCount} başarısız atama`);
      }

    } catch (error) {
      this.logger.error('Hızlı rol ataması hatası:', error);
    }
  }

  public async restoreChannel(backupId: string, channelId: string): Promise<boolean> {
    try {
      this.logger.backup(`Kanal geri yükleme başlatılıyor: ${channelId} (yedek: ${backupId})`);
      
      const channelData = await this.databaseManager.getChannelData(backupId, channelId);
      if (!channelData) {
        this.logger.error(`Kanal verisi bulunamadı: ${backupId}, kanal ${channelId}`);
        return false;
      }

      const guild = this.client.guilds.cache.get(String(channelData.guildId));
      if (!guild) {
        this.logger.error(`Sunucu bulunamadı: ${channelData.guildId} (restoreChannel, backupId: ${backupId}, channelId: ${channelId})`);
        return false;
      }


      let parentId = channelData.parent_id ?? null;
      this.logger.backup(`Kanal ${channelData.name} (${channelId}) parent_id: ${parentId}`);
      
      let parentCategory = null;
      let newParentId = null;
      
      if (parentId) {

        parentCategory = guild.channels.cache.get(parentId);
        this.logger.backup(`Parent kategori aranıyor: ${parentId} sunucu cache'inde...`);
        
        if (!parentCategory) {
          this.logger.backup(`Parent kategori bulunamadı cache'de, önce geri yükleniyor: ${parentId}`);

          newParentId = await this.restoreCategoryAndGetNewId(backupId, parentId);
          
          if (newParentId) {
            this.logger.backup(`Parent kategori başarıyla geri yüklendi: ${parentId} -> ${newParentId}`);
            parentCategory = guild.channels.cache.get(newParentId);
            

            await this.restoreAllChildrenOfCategory(backupId, parentId, newParentId);
          } else {
            this.logger.error(`Parent kategori geri yüklenemedi: ${parentId}`);

            parentId = null;
          }
        } else {
          this.logger.backup(`Parent kategori zaten mevcut cache'de: ${parentId}`);
          newParentId = parentId;
        }
      } else {
        this.logger.backup(`Kanal ${channelData.name} parent_id yok, kategori olmadan oluşturulacak`);
      }


      if (guild.channels.cache.has(channelId)) {
        this.logger.backup(`Kanal zaten mevcut, atlanıyor: ${channelData.name}`);
        return true;
      }

      const channelOptions: any = {
        name: channelData.name,
        type: channelData.type,
        topic: channelData.topic,
        nsfw: channelData.nsfw,
        bitrate: channelData.bitrate,
        userLimit: channelData.userLimit,
        rateLimitPerUser: channelData.rateLimitPerUser,
        rtcRegion: channelData.rtcRegion,
        reason: `Yedekten kanal geri yüklendi: ${backupId}`
      };


      if (parentCategory && newParentId) {
        channelOptions.parent = newParentId;
        this.logger.backup(`Kanal oluşturuluyor: ${channelData.name} kategori altında: ${parentCategory.name} (${newParentId})`);
      } else {
        this.logger.backup(`Kanal oluşturuluyor: ${channelData.name} kategori olmadan`);
      }

      const newChannel = await guild.channels.create(channelOptions);
      this.logger.backup(`Kanal geri yüklendi: ${channelData.name} (${newChannel.id}) kategori: ${newParentId || 'yok'}`);
      return true;

    } catch (error) {
      this.logger.error('Kanal geri yükleme hatası:', error);
      return false;
    }
  }

  public async restoreCategoryAndChildren(backupId: string, categoryId: string): Promise<void> {
    this.logger.backup(`Kategori geri yükleme başlatılıyor: ${categoryId} (yedek: ${backupId})`);
    
    const categoryData = await this.databaseManager.getChannelData(backupId, categoryId);
    if (!categoryData || categoryData.type !== 4) {
      this.logger.error(`Kategori verisi bulunamadı veya geçersiz tip: ${categoryId}`);
      return;
    }

    const guild = this.client.guilds.cache.get(String(categoryData.guildId));
    if (!guild) {
      this.logger.error(`Sunucu bulunamadı: ${categoryId}`);
      return;
    }


    let newCategory = guild.channels.cache.get(categoryId);
    let newCategoryId = categoryId;
    
    if (!newCategory) {
      this.logger.backup(`Kategori oluşturuluyor: ${categoryData.name} (${categoryId})`);
      newCategory = await guild.channels.create({
        name: categoryData.name,
        type: 4,
        position: categoryData.position,
        reason: `Yedekten kategori geri yüklendi: ${backupId}`
      });
      newCategoryId = newCategory.id;
      this.logger.backup(`Kategori geri yüklendi: ${categoryData.name} (${categoryId} -> ${newCategoryId})`);
    } else {
      this.logger.backup(`Kategori zaten mevcut: ${categoryData.name} (${newCategoryId})`);
    }


    const allChannels = await this.databaseManager.getChannelsData(backupId);
    const children = allChannels.filter((c: any) => c.parent_id === categoryId);

    this.logger.backup(`${children.length} alt kanal bulundu kategori için: ${categoryData.name} (${categoryId})`);


    for (const child of children) {
      if (guild.channels.cache.has(child.id)) {
        this.logger.backup(`Kanal zaten mevcut, atlanıyor: ${child.name}`);
        continue;
      }
      
      this.logger.backup(`Kanal oluşturuluyor: ${child.name} kategori altında: ${newCategory.name} (${newCategoryId})`);
      
      try {
        await guild.channels.create({
          name: child.name,
          type: child.type,
          topic: child.topic,
          nsfw: child.nsfw,
          bitrate: child.bitrate,
          userLimit: child.userLimit,
          rateLimitPerUser: child.rateLimitPerUser,
          rtcRegion: child.rtcRegion,
          parent: newCategoryId,
          reason: `Kategori ile birlikte kanal geri yüklendi: ${backupId}`
        });
        this.logger.backup(`Kanal geri yüklendi: ${child.name} (kategori: ${newCategoryId})`);
      } catch (error) {
        this.logger.error(`Kanal oluşturma hatası ${child.name} kategori altında ${newCategory.name}:`, error);
      }
    }
  }



  public async restoreChannelUltraFast(backupId: string, channelId: string): Promise<boolean> {
    try {
      this.logger.backup(`Kanal geri yükleme başlatılıyor: ${channelId} (yedek: ${backupId})`);
      
      const channelData = await this.databaseManager.getChannelData(backupId, channelId);
      if (!channelData) {
        this.logger.error(`Kanal verisi bulunamadı: ${backupId}, kanal ${channelId}`);
        return false;
      }

      const guild = this.client.guilds.cache.get(String(channelData.guildId));
      if (!guild) {
        this.logger.error(`Sunucu bulunamadı: ${channelData.guildId}`);
        return false;
      }


      let parentId = channelData.parent_id ?? null;
      this.logger.backup(`Kanal ${channelData.name} (${channelId}) parent_id: ${parentId}`);
      
      let parentCategory = null;
      let newParentId = null;
      
      if (parentId) {

        parentCategory = guild.channels.cache.get(parentId);
        this.logger.backup(`Parent kategori aranıyor: ${parentId} sunucu cache'inde...`);
        
        if (!parentCategory) {
          this.logger.backup(`Parent kategori bulunamadı cache'de, önce geri yükleniyor: ${parentId}`);

          newParentId = await this.restoreCategoryAndGetNewId(backupId, parentId);
          
          if (newParentId) {
            this.logger.backup(`Parent kategori başarıyla geri yüklendi: ${parentId} -> ${newParentId}`);
            parentCategory = guild.channels.cache.get(newParentId);
            

            await this.restoreAllChildrenOfCategory(backupId, parentId, newParentId);
          } else {
            this.logger.error(`Parent kategori geri yüklenemedi: ${parentId}`);

            parentId = null;
          }
        } else {
          this.logger.backup(`Parent kategori zaten mevcut cache'de: ${parentId}`);
          newParentId = parentId;
        }
      } else {
        this.logger.backup(`Kanal ${channelData.name} parent_id yok, kategori olmadan oluşturulacak`);
      }


      if (guild.channels.cache.has(channelId)) {
        this.logger.backup(`Kanal zaten mevcut, atlanıyor: ${channelData.name}`);
        return true;
      }

      const channelOptions: any = {
        name: channelData.name,
        type: channelData.type,
        topic: channelData.topic,
        nsfw: channelData.nsfw,
        bitrate: channelData.bitrate,
        userLimit: channelData.userLimit,
        rateLimitPerUser: channelData.rateLimitPerUser,
        rtcRegion: channelData.rtcRegion,
        reason: `Yedekten kanal geri yüklendi: ${backupId}`
      };


      if (parentCategory && newParentId) {
        channelOptions.parent = newParentId;
        this.logger.backup(`Kanal oluşturuluyor: ${channelData.name} kategori altında: ${parentCategory.name} (${newParentId})`);
      } else {
        this.logger.backup(`Kanal oluşturuluyor: ${channelData.name} kategori olmadan`);
      }

      const newChannel = await guild.channels.create(channelOptions);
      this.logger.backup(`Kanal geri yüklendi: ${channelData.name} (${newChannel.id}) kategori: ${newParentId || 'yok'}`);
      return true;
    } catch (error) {
      this.logger.error('Kanal geri yükleme hatası:', error);
      return false;
    }
  }


  private async restoreCategoryAndGetNewId(backupId: string, categoryId: string): Promise<string | null> {
    try {
      this.logger.backup(`Kategori geri yükleniyor ve yeni ID alınıyor: ${categoryId}`);
      
      const categoryData = await this.databaseManager.getChannelData(backupId, categoryId);
      if (!categoryData || categoryData.type !== 4) {
        this.logger.error(`Kategori verisi bulunamadı veya geçersiz tip: ${categoryId}`);
        return null;
      }

      const guild = this.client.guilds.cache.get(String(categoryData.guildId));
      if (!guild) {
        this.logger.error(`Sunucu bulunamadı kategori için: ${categoryId}`);
        return null;
      }


      let existingCategory = guild.channels.cache.get(categoryId);
      if (existingCategory) {
        this.logger.backup(`Kategori zaten mevcut: ${categoryData.name} ID: ${existingCategory.id}`);
        return existingCategory.id;
      }


      this.logger.backup(`Yeni kategori oluşturuluyor: ${categoryData.name}`);
      const newCategory = await guild.channels.create({
        name: categoryData.name,
        type: 4,
        position: categoryData.position,
        reason: `Yedekten kategori geri yüklendi: ${backupId}`
      });
      
      this.logger.backup(`Kategori geri yüklendi: ${categoryData.name} (${categoryId} -> ${newCategory.id})`);
      return newCategory.id;
      
    } catch (error) {
      this.logger.error(`Kategori geri yükleme hatası ${categoryId}:`, error);
      return null;
    }
  }


  private async restoreAllChildrenOfCategory(backupId: string, originalParentId: string, newParentId: string): Promise<void> {
    try {
      this.logger.backup(`Kategori altındaki tüm kanallar geri yükleniyor: ${originalParentId} (yeni ID: ${newParentId})`);
      
      const guild = this.client.guilds.cache.get(this.targetGuildId);
      if (!guild) {
        this.logger.error(`Sunucu bulunamadı: ${this.targetGuildId}`);
        return;
      }


      const allChannels = await this.databaseManager.getChannelsData(backupId);
      const children = allChannels.filter((c: any) => c.parent_id === originalParentId && c.type !== 4);

      this.logger.backup(`${children.length} alt kanal bulundu kategori için: ${originalParentId}`);


      for (const child of children) {

        if (guild.channels.cache.has(child.id)) {
          this.logger.backup(`Kanal zaten mevcut, atlanıyor: ${child.name}`);
          continue;
        }

        this.logger.backup(`Alt kanal geri yükleniyor: ${child.name} yeni parent altında: ${newParentId}`);
        
        try {
          const channelOptions: any = {
            name: child.name,
            type: child.type,
            topic: child.topic,
            nsfw: child.nsfw,
            bitrate: child.bitrate,
            userLimit: child.userLimit,
            rateLimitPerUser: child.rateLimitPerUser,
            rtcRegion: child.rtcRegion,
            parent: newParentId,
            reason: `Parent kategori ile birlikte alt kanal geri yüklendi: ${backupId}`
          };

          const newChannel = await guild.channels.create(channelOptions);
          this.logger.backup(`Alt kanal geri yüklendi: ${child.name} (${newChannel.id}) parent altında: ${newParentId}`);
        } catch (error) {
          this.logger.error(`Alt kanal geri yükleme hatası ${child.name}:`, error);
        }
      }
    } catch (error) {
      this.logger.error(`Kategori altındaki kanalları geri yükleme hatası ${originalParentId}:`, error);
    }
  }

  public async restoreEmoji(backupId: string, emojiId: string): Promise<boolean> {
    try {
      const emojiData = await this.databaseManager.getEmojiData(backupId, emojiId);
      if (!emojiData) {
        this.logger.error(`Emoji verisi bulunamadı: ${backupId}, emoji ${emojiId}`);
        return false;
      }

      const guild = this.client.guilds.cache.get(emojiData.guildId);
      if (!guild) {
        this.logger.error(`Guild not found: ${emojiData.guildId}`);
        return false;
      }

      const response = await fetch(emojiData.url);
      const buffer = await response.arrayBuffer();
      
      const newEmoji = await guild.emojis.create({
        attachment: Buffer.from(buffer),
        name: emojiData.name,
        reason: `Emoji yedekten geri yüklendi: ${backupId}`
      });

      this.logger.backup(`Emoji geri yüklendi: ${emojiData.name} (${newEmoji.id})`);
      return true;

    } catch (error) {
      this.logger.error('Emoji geri yükleme hatası:', error);
      return false;
    }
  }

  public async restoreSticker(backupId: string, stickerId: string): Promise<boolean> {
    try {
      const stickerData = await this.databaseManager.getStickerData(backupId, stickerId);
      if (!stickerData) {
        this.logger.error(`Sticker verisi bulunamadı: ${backupId}, sticker ${stickerId}`);
        return false;
      }

      const guild = this.client.guilds.cache.get(stickerData.guildId);
      if (!guild) {
        this.logger.error(`Guild not found: ${stickerData.guildId}`);
        return false;
      }

      const response = await fetch(stickerData.url);
      const buffer = await response.arrayBuffer();
      
      const newSticker = await guild.stickers.create({
        file: Buffer.from(buffer),
        name: stickerData.name,
        tags: stickerData.tags,
        description: stickerData.description,
        reason: `Stiker yedekten geri yüklendi: ${backupId}`
      });

      this.logger.backup(`Stiker geri yüklendi: ${stickerData.name} (${newSticker.id})`);
      return true;

    } catch (error) {
      this.logger.error('Sticker geri yükleme hatası:', error);
      return false;
    }
  }

  public async restoreWebhook(backupId: string, webhookId: string): Promise<boolean> {
    try {
      const webhookData = await this.databaseManager.getWebhookData(backupId, webhookId);
      if (!webhookData) {
        this.logger.error(`Webhook verisi bulunamadı: ${backupId}, webhook ${webhookId}`);
        return false;
      }

      const guild = this.client.guilds.cache.get(webhookData.guildId);
      if (!guild) {
        this.logger.error(`Guild not found: ${webhookData.guildId}`);
        return false;
      }

      const channel = guild.channels.cache.get(webhookData.channelId);
      if (!channel || !('createWebhook' in channel)) {
        this.logger.error(`Channel not found or cannot create webhook: ${webhookData.channelId}`);
        return false;
      }

      const newWebhook = await channel.createWebhook({
        name: webhookData.name,
        avatar: webhookData.avatar,
        reason: `Webhook yedekten geri yüklendi: ${backupId}`
      });

      this.logger.backup(`Webhook geri yüklendi: ${webhookData.name} (${newWebhook.id})`);
      return true;

    } catch (error) {
      this.logger.error('Webhook geri yükleme hatası:', error);
      return false;
    }
  }
} 