import { Client, Guild, GuildMember, TextChannel, EmbedBuilder, PermissionsBitField, AuditLogEvent } from 'discord.js';
import { Logger } from '../utils/logger';
import { DatabaseManager } from '../database/DatabaseManager';
import { RedisManager } from '../database/RedisManager';
import { ElasticsearchManager } from '../database/ElasticsearchManager';
import { AuditManager } from '../audit/AuditManager';
import { BackupManager } from '../backup/BackupManager';
import { GuardConfig, GuardAction, AuditActionType } from '../utils/types';
import { v4 as uuidv4 } from 'uuid';

export class GuardManager {
  private client: Client;
  private logger: Logger;
  private databaseManager: DatabaseManager;
  private redisManager: RedisManager;
  private elasticsearchManager: ElasticsearchManager;
  private auditManager: AuditManager;
  private backupManager: BackupManager;
  private configs: Map<string, GuardConfig> = new Map();
  private violationCounts: Map<string, Map<string, number>> = new Map();
  private isRunning: boolean = false;
  private targetGuildId: string;
  
  private selfActions: Set<string> = new Set();
  private readonly SELF_ACTION_TIMEOUT = 10000;
  private restorationInProgress: Set<string> = new Set();
  private whitelistCache: Map<string, { result: boolean, timestamp: number }> = new Map();
  private readonly WHITELIST_CACHE_TTL = 30000;
  private recentRoleChanges?: Map<string, { timestamp: number, executorId: string }>;

  constructor(
    client: Client,
    databaseManager: DatabaseManager,
    redisManager: RedisManager,
    elasticsearchManager: ElasticsearchManager,
    auditManager: AuditManager,
    backupManager: BackupManager
  ) {
    this.client = client;
    this.logger = Logger.getInstance();
    this.databaseManager = databaseManager;
    this.redisManager = redisManager;
    this.elasticsearchManager = elasticsearchManager;
    this.auditManager = auditManager;
    this.backupManager = backupManager;
    
    this.targetGuildId = process.env.DISCORD_GUILD_ID || '';
    if (!this.targetGuildId) {
      this.logger.error('DISCORD_GUILD_ID environment variable is required');
      process.exit(1);
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.logger.info('Guard Manager başlatıldı');

    await this.loadConfigurations();
    this.setupEventHandlers();
    this.startMonitoring();

    this.logger.info('Guard Manager artık sunucuları koruyor');
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    await this.performFullCleanup();
    this.logger.info('Guard Manager durduruldu');
  }

  private async loadConfigurations(): Promise<void> {
    try {
      const config = await this.databaseManager.getGuardConfig(this.targetGuildId);
      if (config) {
        this.configs.set(this.targetGuildId, config);
        this.logger.guard(`Hedef sunucu için guard yapılandırması yüklendi: ${this.targetGuildId}`);
      } else {
        const defaultConfig = this.createDefaultConfig(this.targetGuildId);
        await this.databaseManager.saveGuardConfig(this.targetGuildId, defaultConfig);
        this.configs.set(this.targetGuildId, defaultConfig);
        this.logger.guard(`Hedef sunucu için varsayılan guard yapılandırması oluşturuldu: ${this.targetGuildId}`);
      }
    } catch (error) {
      this.logger.error('Guard yapılandırmaları yüklenirken hata:', error);
    }
  }

  private createDefaultConfig(guildId: string): GuardConfig {
    return {
      enabled: true,
      logChannelId: undefined,
      backupOnDelete: true,
      backupOnUpdate: true,
      autoRestore: true,
      whitelist: {
        users: [],
        roles: [],
        channels: [],
        permissions: [],
        actions: [],
        enabled: true,
        bypassAll: false
      },
      guildId,
      auditChannelId: undefined,
      webhookUrl: undefined,
      protection: {
        channels: true,
        roles: true,
        emojis: true,
        stickers: true,
        webhooks: true,
        invites: true,
        members: true,
        guild: true
      },
      limits: {
        maxRoleDeletions: 3,
        maxChannelDeletions: 2,
        maxEmojiDeletions: 5,
        maxStickerDeletions: 3,
        maxWebhookCreations: 2,
        maxInviteCreations: 10,
        timeWindow: 300000
      },
      actions: {
        onViolation: [GuardAction.LOG, GuardAction.NOTIFY, GuardAction.RESTORE],
        onSuspiciousActivity: [GuardAction.LOG, GuardAction.NOTIFY]
      }
    };
  }

  private setupEventHandlers(): void {

    this.client.on('guildUpdate', (oldGuild, newGuild) => {
      if (newGuild.id === this.targetGuildId) {
        this.handleGuildUpdate(oldGuild, newGuild);
      }
    });

    this.client.on('guildDelete', (guild) => {
      if (guild.id === this.targetGuildId) {
        this.handleGuildDelete(guild);
      }
    });


    this.client.on('channelCreate', (channel) => {
      if ('guild' in channel && channel.guild?.id === this.targetGuildId) {
        this.handleChannelCreate(channel);
      }
    });

    this.client.on('channelUpdate', (oldChannel, newChannel) => {
      if ('guild' in newChannel && newChannel.guild?.id === this.targetGuildId) {
        this.handleChannelUpdate(oldChannel, newChannel);
      }
    });

    this.client.on('channelDelete', (channel) => {
      if ('guild' in channel && channel.guild?.id === this.targetGuildId) {
        this.handleChannelDelete(channel);
      }
    });


    this.client.on('roleCreate', (role) => {
      if (role.guild.id === this.targetGuildId) {
        this.handleRoleCreate(role);
      }
    });

    this.client.on('roleUpdate', (oldRole, newRole) => {
      if (newRole.guild.id === this.targetGuildId) {
        this.handleRoleUpdate(oldRole, newRole);
      }
    });

    this.client.on('roleDelete', (role) => {
      if (role.guild.id === this.targetGuildId) {
        this.handleRoleDelete(role);
      }
    });


    this.client.on('guildMemberAdd', (member) => {
      if (member.guild.id === this.targetGuildId) {
        this.handleMemberJoin(member);
      }
    });

    this.client.on('guildMemberUpdate', (oldMember, newMember) => {
      if (newMember.guild.id === this.targetGuildId && !oldMember.partial && !newMember.partial) {
        this.handleMemberUpdate(oldMember, newMember);
      }
    });

    this.client.on('guildMemberRemove', (member) => {
      if (member.guild.id === this.targetGuildId && !member.partial) {
        this.handleMemberLeave(member);
      }
    });


    this.client.on('emojiCreate', (emoji) => {
      if (emoji.guild.id === this.targetGuildId) {
        this.handleEmojiCreate(emoji);
      }
    });

    this.client.on('emojiUpdate', (oldEmoji, newEmoji) => {
      if (newEmoji.guild.id === this.targetGuildId) {
        this.handleEmojiUpdate(oldEmoji, newEmoji);
      }
    });

    this.client.on('emojiDelete', (emoji) => {
      if (emoji.guild.id === this.targetGuildId) {
        this.handleEmojiDelete(emoji);
      }
    });


    this.client.on('stickerCreate', (sticker) => {
      if (sticker.guild?.id === this.targetGuildId) {
        this.handleStickerCreate(sticker);
      }
    });

    this.client.on('stickerUpdate', (oldSticker, newSticker) => {
      if (newSticker.guild?.id === this.targetGuildId) {
        this.handleStickerUpdate(oldSticker, newSticker);
      }
    });

    this.client.on('stickerDelete', (sticker) => {
      if (sticker.guild?.id === this.targetGuildId) {
        this.handleStickerDelete(sticker);
      }
    });


    this.client.on('webhookUpdate', (channel) => {
      if ('guild' in channel && channel.guild?.id === this.targetGuildId) {
        this.handleWebhookUpdate(channel);
      }
    });


    this.client.on('inviteCreate', (invite) => {
      if (invite.guild?.id === this.targetGuildId) {
        this.handleInviteCreate(invite);
      }
    });

    this.client.on('inviteDelete', (invite) => {
      if (invite.guild?.id === this.targetGuildId) {
        this.handleInviteDelete(invite);
      }
    });
  }

  private startMonitoring(): void {
    setInterval(() => {
      this.monitorSuspiciousActivity();
    }, 60000);

    setInterval(() => {
      this.cleanupViolationCounts();
    }, 30000);

    setInterval(() => {
      this.cleanupWhitelistCache();
    }, 60000);

    setInterval(() => {
      this.performFullCleanup();
    }, 300000);
  }


  private async handleGenericEvent(
    guild: Guild,
    targetId: string,
    eventType: string,
    auditEvent: AuditLogEvent,
    action: () => Promise<void>
  ): Promise<void> {
    const config = this.configs.get(guild.id);
    if (!config || !config.enabled) return;

    if (this.isSelfAction(guild.id, targetId)) {
      this.logger.guard(`Kendi eylemi atlanıyor: ${eventType}`);
      return;
    }

    const auditLog = await this.getAuditLog(guild, auditEvent);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) {
      this.logger.guard(`Bot eylemi atlanıyor: ${eventType}`);
      return;
    }

    if (this.isWhitelisted(auditLog.executor?.id || '', guild.id)) return;

    try {
      await action();
    } catch (error) {
      this.logger.error(`${eventType} işlenirken hata:`, error);
    }
  }

  private async handleRoleCreate(role: any): Promise<void> {
    await this.handleGenericEvent(
      role.guild,
      role.id,
      'role_create',
      AuditLogEvent.RoleCreate,
      async () => {
        await role.delete('Guard: Yetkisiz rol oluşturma');
        this.logger.guard(`Yetkisiz rol "${role.name}" otomatik olarak silindi`);
        
        await this.handleViolation(
          role.guild,
          'unknown',
          'role_create_blocked',
          `Yetkisiz rol "${role.name}" oluşturuldu ve otomatik olarak silindi`,
          'medium',
          role.id
        );
      }
    );
  }

  private async handleRoleUpdate(oldRole: any, newRole: any): Promise<void> {
    const config = this.configs.get(newRole.guild.id);
    if (!config || !config.enabled || !config.protection.roles) return;

    if (this.isSelfAction(newRole.guild.id, newRole.id)) return;

    const restorationKey = `${newRole.guild.id}:${newRole.id}:restoration`;
    if (this.restorationInProgress.has(restorationKey)) return;

    const recentRestoreKey = `${newRole.guild.id}:${newRole.id}:recent_restore`;
    if (this.selfActions.has(recentRestoreKey)) return;

    const auditLog = await this.getAuditLog(newRole.guild, AuditLogEvent.RoleUpdate);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) return;

    const executorId = auditLog.executor?.id || '';
    
    const syncWhitelisted = this.isWhitelisted(executorId, newRole.guild.id);
    if (syncWhitelisted) return;
    
    const isDbWhitelisted = await this.checkWhitelist(newRole.guild.id, executorId, 'role_update');
    if (isDbWhitelisted) return;

    const roleChanged = 
      oldRole.name !== newRole.name ||
      oldRole.color !== newRole.color ||
      oldRole.hoist !== newRole.hoist ||
      oldRole.mentionable !== newRole.mentionable ||
      oldRole.permissions !== newRole.permissions;

    if (!roleChanged) return;

    const auditLogTargetId = auditLog.targetId;
    if (auditLogTargetId && auditLogTargetId !== newRole.id) return;

    const changeKey = `${newRole.guild.id}:${newRole.id}:${executorId}`;
    const recentChange = this.recentRoleChanges?.get(changeKey);
    if (recentChange && Date.now() - recentChange.timestamp < 5000) return;

    if (!this.recentRoleChanges) {
      this.recentRoleChanges = new Map();
    }
    this.recentRoleChanges.set(changeKey, { timestamp: Date.now(), executorId });

    this.logger.guard(`❌ Yetkisiz rol güncellemesi tespit edildi: ${newRole.name} kullanıcı ${executorId} tarafından`);

    try {
      this.restorationInProgress.add(restorationKey);
      this.selfActions.add(recentRestoreKey);
      
      setTimeout(() => {
        this.selfActions.delete(recentRestoreKey);
      }, 30000);

      await this.restoreRoleFromBackup(newRole.guild, newRole.id, oldRole);
      this.logger.guard(`Rol ${newRole.name} başarıyla geri yüklendi`);
      
      await this.handleViolation(
        newRole.guild,
        executorId,
        'role_update_blocked',
        `Yetkisiz rol "${newRole.name}" değiştirildi ve otomatik olarak geri yüklendi`,
        'medium',
        newRole.id
      );
    } catch (error) {
      this.logger.error('Rol yedekten geri yüklenirken hata:', error);
    } finally {
      setTimeout(() => {
        this.restorationInProgress.delete(restorationKey);
      }, 5000);
    }
  }

  private async handleRoleDelete(role: any): Promise<void> {
    if (role.guild.id !== this.targetGuildId) return;

    try {
      if (this.isSelfAction(role.guild.id, role.id)) {
        this.logger.guard(`Kendi eylemi rol silme göz ardı ediliyor: ${role.name} (${role.id})`);
        return;
      }

      const auditLog = await this.getAuditLog(role.guild, AuditLogEvent.RoleDelete);
      const executorId = auditLog?.executor?.id;
      
      if (executorId) {
        const isWhitelisted = await this.checkWhitelist(role.guild.id, executorId, 'role_delete');
        if (isWhitelisted) return;
      }

      this.logger.guard(`🚨 ROL SİLME TESPİT EDİLDİ: ${role.name} (${role.id}) ${role.guild.name} sunucusunda`);

      this.logger.guard(`📸 ROL VERİLERİ KAYDEDİLİYOR: ${role.name} için rol verileri geri yükleme öncesi kaydediliyor`);
      
      const roleData = {
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        position: role.position,
        permissions: role.permissions,
        mentionable: role.mentionable,
        icon: role.icon,
        unicodeEmoji: role.unicodeEmoji,
        managed: role.managed,
        tags: role.tags
      };

      const membersWithRole = role.members.map((member: any) => ({
        userId: member.id,
        username: member.user.tag
      }));

      this.logger.guard(`📸 ROL VERİLERİ KAYDEDİLDİ: ${role.name} ${membersWithRole.length} üye ile`);

      this.logger.guard(`⚡ ULTRA-HIZLI YENİDEN OLUŞTURMA: ${role.name} rolü hemen yeniden oluşturuluyor`);
      
      this.markSelfAction(role.guild.id, role.id);

      const recentDeletionKey = `${role.guild.id}:${role.id}:recent_deletion`;
      this.selfActions.add(recentDeletionKey);
      
      setTimeout(() => {
        this.selfActions.delete(recentDeletionKey);
      }, 15000);

      const recreateStartTime = Date.now();
      
      try {
        const recreatedRole = await role.guild.roles.create({
          name: roleData.name,
          color: roleData.color,
          hoist: roleData.hoist,
          permissions: roleData.permissions,
          mentionable: roleData.mentionable,
          reason: 'Guard: Yetkisiz silme sonrası rol geri yükleme'
        });

        const recreateTime = Date.now() - recreateStartTime;
        this.logger.guard(`✅ ULTRA-HIZLI YENİDEN OLUŞTURMA TAMAMLANDI: ${role.name} rolü ${recreateTime}ms içinde yeniden oluşturuldu`);

        this.logger.guard(`👥 ROL DAĞITIMI: ${role.name} için rol atamaları geri yükleniyor`);
        await this.distributeRoleToMembersFromData(role.guild, recreatedRole.id, membersWithRole);
        
        this.logger.guard(`💾 YEDEK OLUŞTURMA: Başarılı geri yükleme sonrası yedek alınıyor`);
        const backupId = await this.backupManager.createBackup(role.guild.id, true);
        
        await this.sendRestoreNotification(role.guild, 'role', recreatedRole.id, true);
        
      } catch (error) {
        this.logger.error(`❌ ULTRA-HIZLI YENİDEN OLUŞTURMA BAŞARISIZ: ${role.name} rolü`, error);
        await this.sendRestoreNotification(role.guild, 'role', role.id, false);
      }

      await this.handleViolation(
        role.guild,
        executorId || 'unknown',
        'role_delete_blocked',
        `Rol "${role.name}" silindi ve otomatik olarak geri yüklendi`,
        'high',
        role.id
      );

    } catch (error) {
      this.logger.error('Rol silme işlenirken hata:', error);
    }
  }

  private async handleChannelCreate(channel: any): Promise<void> {
    await this.handleGenericEvent(
      channel.guild,
      channel.id,
      'channel_create',
      AuditLogEvent.ChannelCreate,
      async () => {
        await channel.delete('Guard: Yetkisiz kanal oluşturma');
        this.logger.guard(`Yetkisiz kanal "${channel.name}" otomatik olarak silindi`);
        await this.handleViolation(
          channel.guild,
          'unknown',
          'channel_create_blocked',
          `Yetkisiz kanal "${channel.name}" oluşturuldu ve otomatik olarak silindi`,
          'medium',
          channel.id
        );
      }
    );
  }

  private async handleChannelUpdate(oldChannel: any, newChannel: any): Promise<void> {
    if (this.isSelfAction(newChannel.guild.id, newChannel.id)) return;
    const auditLog = await this.getAuditLog(newChannel.guild, AuditLogEvent.ChannelUpdate);
    if (!auditLog) return;
    if (this.isBotAction(auditLog.executor?.id || '')) return;
    if (this.isWhitelisted(auditLog.executor?.id || '', newChannel.guild.id)) return;

    const changed = (
      oldChannel.name !== newChannel.name ||
      oldChannel.topic !== newChannel.topic ||
      oldChannel.nsfw !== newChannel.nsfw ||
      oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser
    );
    if (!changed) return;

    if (auditLog.targetId && auditLog.targetId !== newChannel.id) return;

    const changeKey = `${newChannel.guild.id}:${newChannel.id}:update`;
    if (!this.recentRoleChanges) this.recentRoleChanges = new Map();
    const recentChange = this.recentRoleChanges.get(changeKey);
    if (recentChange && Date.now() - recentChange.timestamp < 5000) return;
    this.recentRoleChanges.set(changeKey, { timestamp: Date.now(), executorId: auditLog.executor?.id || '' });
    
    try {
      await this.restoreChannelFromBackup(newChannel.guild, newChannel.id, oldChannel);
      this.logger.guard(`Yetkisiz kanal "${newChannel.name}" otomatik olarak geri yüklendi`);
      await this.handleViolation(
        newChannel.guild,
        auditLog.executor?.id || 'unknown',
        'channel_update_blocked',
        `Yetkisiz kanal "${newChannel.name}" değiştirildi ve otomatik olarak geri yüklendi`,
        'medium',
        newChannel.id
      );
    } catch (error) {
      this.logger.error('Kanal geri yüklenirken hata:', error);
    }
  }

  private async handleChannelDelete(channel: any): Promise<void> {
    if (!channel || !channel.guild) {
      this.logger.error('handleChannelDelete: channel veya channel.guild undefined!');
      return;
    }
    if (this.isSelfAction(channel.guild.id, channel.id)) return;
    const restorationKey = `${channel.guild.id}:${channel.id}:restoration`;
    if (this.restorationInProgress.has(restorationKey)) return;
    this.restorationInProgress.add(restorationKey);
    
    try {
      const auditLog = await this.getAuditLog(channel.guild, AuditLogEvent.ChannelDelete);
      if (!auditLog) { this.restorationInProgress.delete(restorationKey); return; }
      if (this.isBotAction(auditLog.executor?.id || '')) { this.restorationInProgress.delete(restorationKey); return; }
      if (this.isWhitelisted(auditLog.executor?.id || '', channel.guild.id)) { this.restorationInProgress.delete(restorationKey); return; }

      if (auditLog.targetId && auditLog.targetId !== channel.id) { this.restorationInProgress.delete(restorationKey); return; }

      const changeKey = `${channel.guild.id}:${channel.id}:delete`;
      if (!this.recentRoleChanges) this.recentRoleChanges = new Map();
      const recentChange = this.recentRoleChanges.get(changeKey);
      if (recentChange && Date.now() - recentChange.timestamp < 5000) { this.restorationInProgress.delete(restorationKey); return; }
      this.recentRoleChanges.set(changeKey, { timestamp: Date.now(), executorId: auditLog.executor?.id || '' });

      await this.restoreDeletedChannel(channel.guild, null, { targetId: channel.id, violationType: 'channel_delete' });
      this.logger.guard(`Silinen kanal "${channel.name}" otomatik olarak geri yüklendi`);
      await this.handleViolation(
        channel.guild,
        auditLog.executor?.id || 'unknown',
        'channel_delete_blocked',
        `Kanal "${channel.name}" silindi ve otomatik olarak geri yüklendi`,
        'high',
        channel.id
      );
    } catch (error) {
      this.logger.error('Silinen kanal geri yüklenirken hata:', error);
    } finally {
      setTimeout(() => {
        this.restorationInProgress.delete(restorationKey);
      }, 5000);
    }
  }


  private async handleEmojiCreate(emoji: any): Promise<void> {
    await this.handleGenericEvent(
      emoji.guild,
      emoji.id,
      'emoji_create',
      AuditLogEvent.EmojiCreate,
      async () => {
        await emoji.delete('Guard: Yetkisiz emoji oluşturma');
        this.logger.guard(`Yetkisiz emoji "${emoji.name}" otomatik olarak silindi`);
        await this.handleViolation(
          emoji.guild,
          'unknown',
          'emoji_create_blocked',
          `Yetkisiz emoji "${emoji.name}" oluşturuldu ve otomatik olarak silindi`,
          'medium',
          emoji.id
        );
      }
    );
  }

  private async handleEmojiUpdate(oldEmoji: any, newEmoji: any): Promise<void> {
    await this.handleGenericEvent(
      newEmoji.guild,
      newEmoji.id,
      'emoji_update',
      AuditLogEvent.EmojiUpdate,
      async () => {
        await this.restoreEmojiFromBackup(newEmoji.guild, newEmoji.id, oldEmoji);
        this.logger.guard(`Yetkisiz emoji "${newEmoji.name}" otomatik olarak geri yüklendi`);
        await this.handleViolation(
          newEmoji.guild,
          'unknown',
          'emoji_update_blocked',
          `Yetkisiz emoji "${newEmoji.name}" değiştirildi ve otomatik olarak geri yüklendi`,
          'medium',
          newEmoji.id
        );
      }
    );
  }

  private async handleEmojiDelete(emoji: any): Promise<void> {
    await this.handleGenericEvent(
      emoji.guild,
      emoji.id,
      'emoji_delete',
      AuditLogEvent.EmojiDelete,
      async () => {
        await this.restoreDeletedEmoji(emoji.guild, null, { targetId: emoji.id, violationType: 'emoji_delete' });
        this.logger.guard(`Silinen emoji "${emoji.name}" otomatik olarak geri yüklendi`);
        await this.handleViolation(
          emoji.guild,
          'unknown',
          'emoji_delete_blocked',
          `Emoji "${emoji.name}" silindi ve otomatik olarak geri yüklendi`,
          'high',
          emoji.id
        );
      }
    );
  }

  private async handleStickerCreate(sticker: any): Promise<void> {
    await this.handleGenericEvent(
      sticker.guild,
      sticker.id,
      'sticker_create',
      AuditLogEvent.StickerCreate,
      async () => {
        await sticker.delete('Guard: Yetkisiz sticker oluşturma');
        this.logger.guard(`Yetkisiz sticker "${sticker.name}" otomatik olarak silindi`);
        await this.handleViolation(
          sticker.guild,
          'unknown',
          'sticker_create_blocked',
          `Yetkisiz sticker "${sticker.name}" oluşturuldu ve otomatik olarak silindi`,
          'medium',
          sticker.id
        );
      }
    );
  }

  private async handleStickerUpdate(oldSticker: any, newSticker: any): Promise<void> {
    await this.handleGenericEvent(
      newSticker.guild,
      newSticker.id,
      'sticker_update',
      AuditLogEvent.StickerUpdate,
      async () => {
        await this.restoreStickerFromBackup(newSticker.guild, newSticker.id, oldSticker);
        this.logger.guard(`Yetkisiz sticker "${newSticker.name}" otomatik olarak geri yüklendi`);
        await this.handleViolation(
          newSticker.guild,
          'unknown',
          'sticker_update_blocked',
          `Yetkisiz sticker "${newSticker.name}" değiştirildi ve otomatik olarak geri yüklendi`,
          'medium',
          newSticker.id
        );
      }
    );
  }

  private async handleStickerDelete(sticker: any): Promise<void> {
    await this.handleGenericEvent(
      sticker.guild,
      sticker.id,
      'sticker_delete',
      AuditLogEvent.StickerDelete,
      async () => {
        await this.restoreDeletedSticker(sticker.guild, null, { targetId: sticker.id, violationType: 'sticker_delete' });
        this.logger.guard(`Silinen sticker "${sticker.name}" otomatik olarak geri yüklendi`);
        await this.handleViolation(
          sticker.guild,
          'unknown',
          'sticker_delete_blocked',
          `Sticker "${sticker.name}" silindi ve otomatik olarak geri yüklendi`,
          'high',
          sticker.id
        );
      }
    );
  }

  private async handleWebhookUpdate(channel: any): Promise<void> {
    const config = this.configs.get(channel.guild.id);
    if (!config || !config.enabled || !config.protection.webhooks) return;

    const auditLog = await this.getAuditLog(channel.guild, AuditLogEvent.WebhookCreate);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) {
      this.logger.guard(`Bot eylemi webhook güncellemesi atlanıyor: ${channel.name}`);
      return;
    }

    if (this.isWhitelisted(auditLog.executor?.id || '', channel.guild.id)) return;

    try {
      const webhooks = await channel.fetchWebhooks();
      for (const [webhookId, webhook] of webhooks) {
        if (webhook.owner?.id === auditLog.executor?.id) {
          await webhook.delete('Guard: Yetkisiz webhook oluşturma');
          this.logger.guard(`Yetkisiz webhook otomatik olarak silindi`);
        }
      }
      
      await this.handleViolation(
        channel.guild,
        auditLog.executor?.id || 'unknown',
        'webhook_create_blocked',
        `Yetkisiz webhook oluşturuldu ve otomatik olarak silindi`,
        'medium'
      );
    } catch (error) {
      this.logger.error('Yetkisiz webhook silinirken hata:', error);
    }
  }

  private async handleGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
    const config = this.configs.get(newGuild.id);
    if (!config || !config.enabled || !config.protection.guild) return;

    const auditLog = await this.getAuditLog(newGuild, AuditLogEvent.GuildUpdate);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) {
      this.logger.guard(`Bot eylemi sunucu güncellemesi atlanıyor: ${newGuild.name}`);
      return;
    }

    if (this.isWhitelisted(auditLog.executor?.id || '', newGuild.id)) return;

    try {
      await this.restoreGuildSettings(newGuild, oldGuild);
      this.logger.guard(`Sunucu ayarları otomatik olarak geri yüklendi`);
      
      await this.handleViolation(
        newGuild,
        auditLog.executor?.id || 'unknown',
        'guild_update_blocked',
        `Sunucu ayarları değiştirildi ve otomatik olarak geri yüklendi`,
        'high'
      );
    } catch (error) {
      this.logger.error('Sunucu ayarları geri yüklenirken hata:', error);
    }
  }

  private async handleGuildDelete(guild: Guild): Promise<void> {
    const config = this.configs.get(guild.id);
    if (!config || !config.enabled || !config.protection.guild) return;

    const auditLog = await this.getAuditLog(guild, AuditLogEvent.GuildUpdate);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) {
      this.logger.guard(`Bot eylemi sunucu silme atlanıyor: ${guild.name}`);
      return;
    }

    if (this.isWhitelisted(auditLog.executor?.id || '', guild.id)) return;

    await this.handleViolation(
      guild,
      auditLog.executor?.id || 'unknown',
      'guild_delete',
      'Sunucu silindi',
      'critical'
    );
  }

  private async handleMemberJoin(member: GuildMember): Promise<void> {
    const config = this.configs.get(member.guild.id);
    if (!config || !config.enabled || !config.protection.members) return;

    const accountAge = Date.now() - member.user.createdTimestamp;
    const suspiciousAge = 24 * 60 * 60 * 1000;

    if (accountAge < suspiciousAge) {
      await this.handleViolation(
        member.guild,
        member.id,
        'suspicious_member_join',
        `Şüpheli üye katıldı: ${member.user.tag} (hesap yaşı: ${Math.floor(accountAge / (60 * 60 * 1000))}s)`,
        'medium'
      );
    }
  }

  private async handleMemberUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
    const config = this.configs.get(newMember.guild.id);
    if (!config || !config.enabled || !config.protection.members) return;

    const auditLog = await this.getAuditLog(newMember.guild, AuditLogEvent.MemberUpdate);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) {
      this.logger.guard(`Bot eylemi üye güncellemesi atlanıyor: ${newMember.guild.name}`);
      return;
    }

    if (this.isWhitelisted(auditLog.executor?.id || '', newMember.guild.id)) return;

    const oldRoles = oldMember.roles.cache.map(role => role.id);
    const newRoles = newMember.roles.cache.map(role => role.id);
    const addedRoles = newRoles.filter(roleId => !oldRoles.includes(roleId));

    if (addedRoles.length > 0) {
      const addedRoleNames = addedRoles.map(roleId => newMember.guild.roles.cache.get(roleId)?.name).filter(Boolean);
      await this.handleViolation(
        newMember.guild,
        auditLog.executor?.id || 'unknown',
        'role_addition',
        `${newMember.user.tag} kullanıcısına rol eklendi: ${addedRoleNames.join(', ')}`,
        'medium'
      );
    }
  }

  private async handleMemberLeave(member: GuildMember): Promise<void> {
    const config = this.configs.get(member.guild.id);
    if (!config || !config.enabled || !config.protection.members) return;

    const auditLog = await this.getAuditLog(member.guild, AuditLogEvent.MemberKick);
    if (auditLog && !this.isWhitelisted(auditLog.executor?.id || '', member.guild.id)) {
      await this.handleViolation(
        member.guild,
        auditLog.executor?.id || 'unknown',
        'member_kick',
        `${member.user.tag} üyesi atıldı`,
        'medium'
      );
    }
  }

  private async handleInviteCreate(invite: any): Promise<void> {
    const config = this.configs.get(invite.guild.id);
    if (!config || !config.enabled || !config.protection.invites) return;

    const auditLog = await this.getAuditLog(invite.guild, AuditLogEvent.InviteCreate);
    if (!auditLog) return;

    if (this.isBotAction(auditLog.executor?.id || '')) {
      this.logger.guard(`Bot eylemi davet oluşturma atlanıyor: ${invite.guild.name}`);
      return;
    }

    if (this.isWhitelisted(auditLog.executor?.id || '', invite.guild.id)) return;

    const violationCount = await this.getViolationCount(auditLog.executor?.id || 'unknown', invite.guild.id, 'invite_create');
    
    if (violationCount >= config.limits.maxInviteCreations) {
      await this.handleViolation(
        invite.guild,
        auditLog.executor?.id || 'unknown',
        'invite_create_limit_exceeded',
        `Davet oluşturuldu (limit aşıldı)`,
        'high'
      );
    } else {
      await this.incrementViolationCount(auditLog.executor?.id || 'unknown', invite.guild.id, 'invite_create');
    }
  }

  private async handleInviteDelete(invite: any): Promise<void> {
    this.logger.guard(`${invite.guild.name} sunucusunda davet silindi`);
  }


  private async getAuditLog(guild: Guild, action: AuditLogEvent): Promise<any> {
    try {
      const auditLogs = await guild.fetchAuditLogs({
        type: action,
        limit: 1
      });
      return auditLogs.entries.first();
    } catch (error) {
      this.logger.error('Denetim günlüğü alınırken hata:', error);
      return null;
    }
  }

  private isWhitelisted(userId: string, guildId: string): boolean {
    const config = this.configs.get(guildId);
    if (!config) return false;

    const configWhitelisted = config.whitelist.users.includes(userId) ||
           config.whitelist.roles.some(roleId => {
             const guild = this.client.guilds.cache.get(guildId);
             const member = guild?.members.cache.get(userId);
             return member?.roles.cache.has(roleId);
           });

    if (configWhitelisted) return true;
    return false;
  }

  private async isUserWhitelisted(guildId: string, userId: string): Promise<boolean> {
    const cacheKey = `user:${guildId}:${userId}`;
    const cached = this.whitelistCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.WHITELIST_CACHE_TTL) {
      return cached.result;
    }

    try {
      const result = await this.databaseManager.isWhitelisted(guildId, 'user', userId);
      this.whitelistCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      this.logger.error('Kullanıcı whitelist kontrolü sırasında hata:', error);
      return false;
    }
  }

  private async isRoleWhitelisted(guildId: string, roleId: string): Promise<boolean> {
    const cacheKey = `role:${guildId}:${roleId}`;
    const cached = this.whitelistCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.WHITELIST_CACHE_TTL) {
      return cached.result;
    }

    try {
      const result = await this.databaseManager.isWhitelisted(guildId, 'role', roleId);
      this.whitelistCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      this.logger.error('Rol whitelist kontrolü sırasında hata:', error);
      return false;
    }
  }

  private async isActionWhitelisted(guildId: string, action: string): Promise<boolean> {
    const cacheKey = `action:${guildId}:${action}`;
    const cached = this.whitelistCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.WHITELIST_CACHE_TTL) {
      return cached.result;
    }

    try {
      const result = await this.databaseManager.isWhitelisted(guildId, 'action', action);
      this.whitelistCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      this.logger.error('Eylem whitelist kontrolü sırasında hata:', error);
      return false;
    }
  }

  private async checkWhitelist(guildId: string, executorId: string, action: string): Promise<boolean> {
    try {
      const userWhitelisted = await this.isUserWhitelisted(guildId, executorId);
      if (userWhitelisted) return true;

      const actionWhitelisted = await this.isActionWhitelisted(guildId, action);
      if (actionWhitelisted) return true;

      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        const member = await guild.members.fetch(executorId).catch(() => null);
        if (member) {
          for (const roleId of member.roles.cache.keys()) {
            const roleWhitelisted = await this.isRoleWhitelisted(guildId, roleId);
            if (roleWhitelisted) return true;
          }
        }
      }

      return false;
    } catch (error) {
      this.logger.error('Whitelist kontrolü sırasında hata:', error);
      return false;
    }
  }

  private async getViolationCount(userId: string, guildId: string, action: string): Promise<number> {
    return await this.redisManager.getUserViolationCount(userId, guildId);
  }

  private async incrementViolationCount(userId: string, guildId: string, action: string): Promise<number> {
    return await this.redisManager.incrementUserViolationCount(userId, guildId);
  }

  private async handleViolation(
    guild: Guild,
    userId: string,
    violationType: string,
    description: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    targetId?: string
  ): Promise<void> {
    try {
      const config = this.configs.get(guild.id);
      if (!config) return;

      this.logger.guard(`Guard ihlali tespit edildi: ${violationType} ${guild.name} sunucusunda`, {
        guildId: guild.id,
        userId,
        violationType,
        description,
        severity,
        targetId
      });

      const violation = {
        id: uuidv4(),
        guildId: guild.id,
        userId,
        violationType,
        description,
        severity,
        targetId,
        actionTaken: [],
        timestamp: new Date(),
        ipAddress: undefined,
        userAgent: undefined,
        sessionId: undefined
      };

      const actions = severity === 'critical' ? config.actions.onViolation : config.actions.onSuspiciousActivity;
      
      for (const action of actions) {
        await this.executeAction(action, guild, userId, violation);
      }

      await this.sendNotification(guild, userId, violationType, description, severity);

    } catch (error) {
      this.logger.error('Error handling violation:', error);
    }
  }

  private async executeAction(
    action: GuardAction,
    guild: Guild,
    userId: string,
    violation: any
  ): Promise<void> {
    try {
      switch (action) {
        case GuardAction.LOG:
          break;
        case GuardAction.NOTIFY:
          await this.sendNotification(guild, userId, violation.violationType, violation.description, violation.severity);
          break;
        case GuardAction.KICK:
          await this.kickUser(guild, userId, violation.description);
          break;
        case GuardAction.BAN:
          await this.banUser(guild, userId, violation.description);
          break;
        case GuardAction.REMOVE_ROLE:
          await this.removeRoles(guild, userId);
          break;
        case GuardAction.TIMEOUT:
          await this.timeoutUser(guild, userId, violation.description);
          break;
        case GuardAction.RESTORE:
          await this.restoreChanges(guild, violation);
          break;
        case GuardAction.LOCKDOWN:
          await this.lockdownGuild(guild);
          break;
      }
    } catch (error) {
      this.logger.error(`Error executing action ${action}:`, error);
    }
  }

  private async kickUser(guild: Guild, userId: string, reason: string): Promise<void> {
    try {
      const member = await guild.members.fetch(userId);
      await member.kick(`Guard ihlali: ${reason}`);
      this.logger.guard(`${member.user.tag} kullanıcısı ${guild.name} sunucusundan atıldı`);
    } catch (error) {
      this.logger.error('Kullanıcı atılırken hata:', error);
    }
  }

  private async banUser(guild: Guild, userId: string, reason: string): Promise<void> {
    try {
      const member = await guild.members.fetch(userId);
      await guild.members.ban(userId, { reason: `Guard ihlali: ${reason}` });
      this.logger.guard(`${member.user.tag} kullanıcısı ${guild.name} sunucusundan yasaklandı`);
    } catch (error) {
      this.logger.error('Kullanıcı yasaklanırken hata:', error);
    }
  }

  private async removeRoles(guild: Guild, userId: string): Promise<void> {
    try {
      const member = await guild.members.fetch(userId);
      const rolesToRemove = member.roles.cache.filter(role => role.name !== '@everyone');
      
      for (const [roleId, role] of rolesToRemove) {
        await member.roles.remove(roleId, 'Guard ihlali: Rol kaldırma');
      }
      
      this.logger.guard(`${member.user.tag} kullanıcısının rolleri ${guild.name} sunucusunda kaldırıldı`);
    } catch (error) {
      this.logger.error('Roller kaldırılırken hata:', error);
    }
  }

  private async timeoutUser(guild: Guild, userId: string, reason: string): Promise<void> {
    try {
      const member = await guild.members.fetch(userId);
      const timeoutDuration = 24 * 60 * 60 * 1000;
      await member.timeout(timeoutDuration, `Guard ihlali: ${reason}`);
      this.logger.guard(`${member.user.tag} kullanıcısı ${guild.name} sunucusunda susturuldu`);
    } catch (error) {
      this.logger.error('Kullanıcı susturulurken hata:', error);
    }
  }

  private async restoreChanges(guild: Guild, violation: any): Promise<void> {
    try {
      this.logger.guard(`${guild.name} için geri yükleme eylemi tetiklendi - İhlal: ${violation.violationType}`);
      
      const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
      if (!latestBackup) {
        this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
        return;
      }

      switch (violation.violationType) {
        case 'role_delete_limit_exceeded':
        case 'role_delete':
          await this.restoreDeletedRole(guild, latestBackup.id, violation);
          break;
        case 'channel_delete_limit_exceeded':
        case 'channel_delete':
          await this.restoreDeletedChannel(guild, latestBackup.id, violation);
          break;
        case 'emoji_delete_limit_exceeded':
        case 'emoji_delete':
          await this.restoreDeletedEmoji(guild, latestBackup.id, violation);
          break;
        case 'sticker_delete_limit_exceeded':
        case 'sticker_delete':
          await this.restoreDeletedSticker(guild, latestBackup.id, violation);
          break;
        default:
          this.logger.guard(`${violation.violationType} ihlal türü için özel geri yükleme eylemi yok`);
      }
    } catch (error) {
      this.logger.error('Geri yükleme değişikliklerinde hata:', error);
    }
  }


  private async performRestore(
    guild: Guild,
    backupId: string | null,
    violation: any,
    restoreType: 'role' | 'channel' | 'emoji' | 'sticker',
    extractIdMethod: (violation: any) => string | null,
    restoreMethod: (backupId: string, id: string) => Promise<boolean>
  ): Promise<void> {
    try {
      const targetId = extractIdMethod(violation);
      if (!targetId) {
        this.logger.error(`İhlalden ${restoreType} ID'si çıkarılamadı`);
        return;
      }

      this.markSelfAction(guild.id, targetId);

      let finalBackupId = backupId;
      if (!finalBackupId) {
        const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
        if (!latestBackup) {
          this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
          return;
        }
        finalBackupId = latestBackup.id;
      }

      this.logger.guard(`${restoreType} ${targetId} yedek ${finalBackupId}'den geri yüklenmeye çalışılıyor`);
      
      if (!finalBackupId) {
        this.logger.error('Geri yükleme için yedek ID mevcut değil');
        return;
      }

      const restoreStartTime = Date.now();
      let success = await restoreMethod(finalBackupId, targetId);
      
      if (!success) {
        this.logger.guard(`${restoreType} ${targetId} en son yedek ${finalBackupId}'de bulunamadı, eski yedeklerde aranıyor...`);
        
        const recentBackups = await this.databaseManager.getBackupsByGuild(guild.id, 10);
        
        for (const backup of recentBackups) {
          if (backup.id === finalBackupId) continue;
          
          this.logger.guard(`${restoreType} ${targetId} eski yedek ${backup.id}'den geri yüklenmeye çalışılıyor`);
          success = await restoreMethod(backup.id, targetId);
          
          if (success) {
            this.logger.guard(`${restoreType} ${targetId} eski yedek ${backup.id}'den başarıyla geri yüklendi`);
            break;
          }
        }
      }
      
      const restoreTime = Date.now() - restoreStartTime;
      
      if (success) {
        this.logger.guard(`✅ ULTRA-HIZLI GERİ YÜKLEME TAMAMLANDI: ${restoreType} ${targetId} ${restoreTime}ms içinde geri yüklendi`);
        await this.sendRestoreNotification(guild, restoreType, targetId, true);
      } else {
        this.logger.error(`❌ ULTRA-HIZLI GERİ YÜKLEME BAŞARISIZ: ${restoreType} ${targetId} ${guild.name} sunucusunda ${restoreTime}ms sonra mevcut yedeklerden geri yüklenemedi`);
        await this.sendRestoreNotification(guild, restoreType, targetId, false);
      }
    } catch (error) {
      this.logger.error(`Silinen ${restoreType} geri yüklenirken hata:`, error);
    }
  }

  private async restoreDeletedRole(guild: Guild, backupId: string | null, violation: any): Promise<void> {
    await this.performRestore(
      guild,
      backupId,
      violation,
      'role',
      this.extractRoleIdFromViolation.bind(this),
      this.backupManager.restoreRole.bind(this.backupManager)
    );
  }

  private async restoreRoleFromBackup(guild: Guild, roleId: string, oldRole: any): Promise<void> {
    try {
      this.markSelfAction(guild.id, roleId);

      const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
      if (!latestBackup) {
        this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
        return;
      }

      const roleData = await this.databaseManager.getRoleFromBackup(latestBackup.id, roleId);
      if (!roleData) {
        this.logger.error(`Rol ${roleId} yedekte bulunamadı`);
        return;
      }

      const role = guild.roles.cache.get(roleId);
      if (role) {
        if (!guild.members.me?.permissions.has('ManageRoles')) {
          this.logger.error(`Bot ${guild.name} sunucusunda ManageRoles iznine sahip değil`);
          return;
        }

        const botHighestRole = guild.members.me?.roles.highest;
        if (botHighestRole && role.position >= botHighestRole.position) {
          this.logger.error(`Rol ${role.name} düzenlenemiyor - pozisyon çok yüksek (${role.position} >= ${botHighestRole.position})`);
          return;
        }

        const needsUpdate = 
          role.name !== roleData.name ||
          role.color !== roleData.color ||
          role.hoist !== roleData.hoist ||
          role.mentionable !== roleData.mentionable;

        if (needsUpdate) {
          try {
            await role.edit({
              name: roleData.name,
              color: roleData.color,
              hoist: roleData.hoist,
              permissions: roleData.permissions,
              mentionable: roleData.mentionable,
              reason: 'Guard: Yedekten rol geri yükleme'
            });
            
            this.logger.guard(`Rol ${roleData.name} ${guild.name} sunucusunda başarıyla geri yüklendi`);
          } catch (editError: any) {
            if (editError.code === 50013) {
              this.logger.error(`Rol ${roleData.name} düzenlemek için ${guild.name} sunucusunda izin eksik`);
            } else {
              this.logger.error(`Rol ${roleData.name} düzenlenirken hata:`, editError);
            }
          }
        } else {
          this.logger.guard(`Rol ${roleData.name} zaten yedek verilerle eşleşiyor, güncelleme gerekmiyor`);
        }
      } else {
        this.logger.error(`Rol ${roleId} ${guild.name} sunucusunda bulunamadı`);
      }
    } catch (error) {
      this.logger.error('Yedekten rol geri yüklenirken hata:', error);
    }
  }

  private async restoreDeletedChannel(guild: Guild, backupId: string | null, violation: any): Promise<void> {
    if (!guild) {
      this.logger.error('restoreDeletedChannel: guild undefined!');
      return;
    }
    try {
      const channelId = this.extractChannelIdFromViolation(violation);
      if (!channelId) {
        this.logger.error('İhlalden kanal ID\'si çıkarılamadı');
        return;
      }

      this.markSelfAction(guild.id, channelId);

      let finalBackupId = backupId;
      if (!finalBackupId) {
        const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
        if (!latestBackup) {
          this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
          return;
        }
        finalBackupId = latestBackup.id;
      }

      this.logger.guard(`Kanal ${channelId} yedek ${finalBackupId}'den geri yüklenmeye çalışılıyor`);
      
      if (!finalBackupId) {
        this.logger.error('Geri yükleme için yedek ID mevcut değil');
        return;
      }

      let channelData = await this.databaseManager.getChannelData(finalBackupId, channelId);
      let foundBackupId = finalBackupId;
      
      if (!channelData) {
        this.logger.guard(`Kanal ${channelId} en son yedek ${finalBackupId}'de bulunamadı, eski yedeklerde aranıyor...`);
        
        const recentBackups = await this.databaseManager.getBackupsByGuild(guild.id, 10);
        
        for (const backup of recentBackups) {
          if (backup.id === finalBackupId) continue;
          
          this.logger.guard(`Kanal ${channelId} eski yedek ${backup.id}'de aranıyor`);
          channelData = await this.databaseManager.getChannelData(backup.id, channelId);
          
          if (channelData) {
            foundBackupId = backup.id;
            this.logger.guard(`Kanal ${channelId} eski yedek ${backup.id}'de bulundu`);
            break;
          }
        }
      }

      if (!channelData) {
        this.logger.error(`Kanal verisi ${channelId} için mevcut yedeklerde bulunamadı`);
        await this.sendRestoreNotification(guild, 'channel', channelId, false);
        return;
      }

      let success = false;

      if (channelData.type === 4) {
        this.logger.guard(`Kategori silme tespit edildi: ${channelData.name} (${channelId})`);
        
        try {
          await this.backupManager.restoreCategoryAndChildren(foundBackupId, channelId);
          success = true;
          this.logger.guard(`Kategori ${channelData.name} ve tüm alt kanalları başarıyla geri yüklendi`);
        } catch (error) {
          this.logger.error(`Kategori ${channelData.name} geri yüklenemedi:`, error);
          
          const recentBackups = await this.databaseManager.getBackupsByGuild(guild.id, 10);
          for (const backup of recentBackups) {
            if (backup.id === foundBackupId) continue;
            
            this.logger.guard(`Kategori ${channelData.name} yedek ${backup.id}'den geri yüklenmeye çalışılıyor`);
            try {
              await this.backupManager.restoreCategoryAndChildren(backup.id, channelId);
              success = true;
              this.logger.guard(`Kategori ${channelData.name} yedek ${backup.id}'den başarıyla geri yüklendi`);
              break;
            } catch (backupError) {
              this.logger.error(`Kategori yedek ${backup.id}'den geri yüklenemedi:`, backupError);
            }
          }
        }
      } else {
        const parentId = channelData.parent_id;
        if (parentId) {
          const parentCategory = guild.channels.cache.get(parentId);
          if (!parentCategory) {
            this.logger.guard(`Üst kategori ${parentId} bulunamadı, hem kategori hem kanal geri yükleniyor`);
            
            try {
              await this.backupManager.restoreCategoryAndChildren(foundBackupId, parentId);
              this.logger.guard(`Üst kategori ${parentId} başarıyla geri yüklendi`);
            } catch (categoryError) {
              this.logger.error(`Üst kategori ${parentId} geri yüklenemedi:`, categoryError);
              
              const recentBackups = await this.databaseManager.getBackupsByGuild(guild.id, 10);
              for (const backup of recentBackups) {
                if (backup.id === foundBackupId) continue;
                
                try {
                  await this.backupManager.restoreCategoryAndChildren(backup.id, parentId);
                  this.logger.guard(`Üst kategori ${parentId} yedek ${backup.id}'den başarıyla geri yüklendi`);
                  break;
                } catch (backupError) {
                  this.logger.error(`Üst kategori yedek ${backup.id}'den geri yüklenemedi:`, backupError);
                }
              }
            }
          }
        }
      }
      
      if (success) {
        this.logger.guard(`Successfully restored channel ${channelId} in guild ${guild.name}`);
        await this.sendRestoreNotification(guild, 'channel', channelId, true);
      } else {
        this.logger.error(`Failed to restore channel ${channelId} in guild ${guild.name} from any available backup`);
        await this.sendRestoreNotification(guild, 'channel', channelId, false);
      }
    } catch (error) {
      this.logger.error('Error restoring deleted channel:', error);
    }
  }

  private async restoreChannelFromBackup(guild: Guild, channelId: string, oldChannel: any): Promise<void> {
    if (!guild) {
      this.logger.error('restoreChannelFromBackup: guild tanımsız!');
      return;
    }
    try {
      this.markSelfAction(guild.id, channelId);

      const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
      if (!latestBackup) {
        this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
        return;
      }

      const channelData = await this.databaseManager.getChannelFromBackup(latestBackup.id, channelId);
      if (!channelData) {
        this.logger.error(`Kanal ${channelId} yedekte bulunamadı`);
        return;
      }

      const channel = guild.channels.cache.get(channelId);
      if (channel && channel.isTextBased()) {
        await channel.edit({
          name: channelData.name,
          topic: channelData.topic,
          nsfw: channelData.nsfw,
          rateLimitPerUser: channelData.rateLimitPerUser,
          reason: 'Guard: Kanal yedekten geri yükleniyor'
        });
        
        this.logger.guard(`${guild.name} sunucusunda ${channelData.name} kanalı başarıyla geri yüklendi`);
      }
    } catch (error) {
      this.logger.error('Yedekten kanal geri yüklenirken hata:', error);
    }
  }

  private async restoreDeletedEmoji(guild: Guild, backupId: string | null, violation: any): Promise<void> {
    try {
      const emojiId = this.extractEmojiIdFromViolation(violation);
      if (!emojiId) {
        this.logger.error('İhlalden emoji ID\'si çıkarılamadı');
        return;
      }

      this.markSelfAction(guild.id, emojiId);

      let finalBackupId = backupId;
      if (!finalBackupId) {
        const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
        if (!latestBackup) {
          this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
          return;
        }
        finalBackupId = latestBackup.id;
      }

      this.logger.guard(`${finalBackupId} yedeğinden ${emojiId} emojisi geri yüklenmeye çalışılıyor`);
      
      if (!finalBackupId) {
        this.logger.error('Geri yükleme için yedek ID\'si mevcut değil');
        return;
      }
      const success = await this.backupManager.restoreEmoji(finalBackupId, emojiId);
      
      if (success) {
        this.logger.guard(`${guild.name} sunucusunda ${emojiId} emojisi başarıyla geri yüklendi`);
        await this.sendRestoreNotification(guild, 'emoji', emojiId, true);
      } else {
        this.logger.error(`${guild.name} sunucusunda ${emojiId} emojisi geri yüklenemedi`);
        await this.sendRestoreNotification(guild, 'emoji', emojiId, false);
      }
    } catch (error) {
      this.logger.error('Silinen emoji geri yüklenirken hata:', error);
    }
  }

  private async restoreEmojiFromBackup(guild: Guild, emojiId: string, oldEmoji: any): Promise<void> {
    try {
      this.markSelfAction(guild.id, emojiId);

      const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
      if (!latestBackup) {
        this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
        return;
      }

      const emojiData = await this.databaseManager.getEmojiFromBackup(latestBackup.id, emojiId);
      if (!emojiData) {
        this.logger.error(`Emoji ${emojiId} yedekte bulunamadı`);
        return;
      }

      const emoji = guild.emojis.cache.get(emojiId);
      if (emoji) {
        await emoji.edit({
          name: emojiData.name,
          reason: 'Guard: Emoji yedekten geri yükleniyor'
        });
        
        this.logger.guard(`${guild.name} sunucusunda ${emojiData.name} emojisi başarıyla geri yüklendi`);
      }
    } catch (error) {
      this.logger.error('Yedekten emoji geri yüklenirken hata:', error);
    }
  }

  private async restoreDeletedSticker(guild: Guild, backupId: string | null, violation: any): Promise<void> {
    try {
      const stickerId = this.extractStickerIdFromViolation(violation);
      if (!stickerId) {
        this.logger.error('İhlalden sticker ID\'si çıkarılamadı');
        return;
      }

      this.markSelfAction(guild.id, stickerId);

      let finalBackupId = backupId;
      if (!finalBackupId) {
        const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
        if (!latestBackup) {
          this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
          return;
        }
        finalBackupId = latestBackup.id;
      }

      this.logger.guard(`${finalBackupId} yedeğinden ${stickerId} sticker'ı geri yüklenmeye çalışılıyor`);
      
      if (!finalBackupId) {
        this.logger.error('Geri yükleme için yedek ID\'si mevcut değil');
        return;
      }
      const success = await this.backupManager.restoreSticker(finalBackupId, stickerId);
      
      if (success) {
        this.logger.guard(`${guild.name} sunucusunda ${stickerId} sticker'ı başarıyla geri yüklendi`);
        await this.sendRestoreNotification(guild, 'sticker', stickerId, true);
      } else {
        this.logger.error(`${guild.name} sunucusunda ${stickerId} sticker'ı geri yüklenemedi`);
        await this.sendRestoreNotification(guild, 'sticker', stickerId, false);
      }
    } catch (error) {
      this.logger.error('Silinen sticker geri yüklenirken hata:', error);
    }
  }

  private async restoreStickerFromBackup(guild: Guild, stickerId: string, oldSticker: any): Promise<void> {
    try {
      this.markSelfAction(guild.id, stickerId);

      const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
      if (!latestBackup) {
        this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
        return;
      }

      const stickerData = await this.databaseManager.getStickerFromBackup(latestBackup.id, stickerId);
      if (!stickerData) {
        this.logger.error(`Sticker ${stickerId} yedekte bulunamadı`);
        return;
      }

      const sticker = guild.stickers.cache.get(stickerId);
      if (sticker) {
        await sticker.edit({
          name: stickerData.name,
          description: stickerData.description,
          tags: stickerData.tags,
          reason: 'Guard: Sticker yedekten geri yükleniyor'
        });
        
        this.logger.guard(`${guild.name} sunucusunda ${stickerData.name} sticker'ı başarıyla geri yüklendi`);
      }
    } catch (error) {
      this.logger.error('Yedekten sticker geri yüklenirken hata:', error);
    }
  }

  private async restoreGuildSettings(guild: Guild, oldGuild: any): Promise<void> {
    try {
      this.markSelfAction(guild.id, 'guild_settings');

      const latestBackup = await this.databaseManager.getLatestBackup(guild.id);
      if (!latestBackup) {
        this.logger.error(`${guild.name} sunucusu için yedek bulunamadı`);
        return;
      }

      const guildData = await this.databaseManager.getGuildFromBackup(latestBackup.id);
      if (!guildData) {
        this.logger.error('Yedekte sunucu verisi bulunamadı');
        return;
      }

      await guild.edit({
        name: guildData.name,
        description: guildData.description,
        verificationLevel: guildData.verificationLevel,
        explicitContentFilter: guildData.explicitContentFilter,
        defaultMessageNotifications: guildData.defaultMessageNotifications,
        reason: 'Guard: Sunucu ayarları yedekten geri yükleniyor'
      });
      
      this.logger.guard(`${guild.name} sunucusunda ayarlar başarıyla geri yüklendi`);
    } catch (error) {
      this.logger.error('Sunucu ayarları geri yüklenirken hata:', error);
    }
  }

  private extractRoleIdFromViolation(violation: any): string | null {
    if (violation.targetId) return violation.targetId;
    
    const description = violation.description || '';
    const roleMatch = description.match(/Role "([^"]+)" was deleted/);
    if (roleMatch) {
      return null;
    }
    
    return null;
  }

  private extractChannelIdFromViolation(violation: any): string | null {
    if (violation.targetId) return violation.targetId;
    
    const description = violation.description || '';
    const channelMatch = description.match(/Channel "([^"]+)" was deleted/);
    if (channelMatch) {
      return null;
    }
    
    return null;
  }

  private extractEmojiIdFromViolation(violation: any): string | null {
    if (violation.targetId) return violation.targetId;
    
    const description = violation.description || '';
    const emojiMatch = description.match(/Emoji "([^"]+)" was deleted/);
    if (emojiMatch) {
      return null;
    }
    
    return null;
  }

  private extractStickerIdFromViolation(violation: any): string | null {
    if (violation.targetId) return violation.targetId;
    
    const description = violation.description || '';
    const stickerMatch = description.match(/Sticker "([^"]+)" was deleted/);
    if (stickerMatch) {
      return null;
    }
    
    return null;
  }

  private async sendRestoreNotification(guild: Guild, type: string, id: string, success: boolean): Promise<void> {
    try {
      const config = this.configs.get(guild.id);
      if (!config?.auditChannelId) return;

      const channel = guild.channels.cache.get(config.auditChannelId) as TextChannel;
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setTitle(success ? '✅ Geri Yükleme Başarılı' : '❌ Geri Yükleme Başarısız')
        .setDescription(`${type.charAt(0).toUpperCase() + type.slice(1)} geri yükleme ${success ? 'tamamlandı' : 'başarısız oldu'}`)
        .addFields(
          { name: 'Tür', value: type, inline: true },
          { name: 'ID', value: id, inline: true },
          { name: 'Durum', value: success ? 'Başarılı' : 'Başarısız', inline: true },
          { name: 'Zaman', value: new Date().toISOString(), inline: true }
        )
        .setColor(success ? 0x00FF00 : 0xFF0000)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Geri yükleme bildirimi gönderilirken hata:', error);
    }
  }

  private async lockdownGuild(guild: Guild): Promise<void> {
    try {
      await guild.setVerificationLevel(4, 'Guard ihlali: Sunucu kilitleme');
      
      const channels = guild.channels.cache.filter(channel => 
        channel.type === 0 && channel.permissionsFor(guild.members.me!)?.has(PermissionsBitField.Flags.ManageChannels)
      );
      
      for (const [channelId, channel] of channels) {
        await (channel as any).permissionOverwrites.edit(guild.roles.everyone, {
          SendMessages: false,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false
        });
      }
      
      this.logger.guard(`${guild.name} sunucusu kilitlendi`);
    } catch (error) {
      this.logger.error('Sunucu kilitleme hatası:', error);
    }
  }

  private async sendNotification(
    guild: Guild,
    userId: string,
    violationType: string,
    description: string,
    severity: string
  ): Promise<void> {
    try {
      const config = this.configs.get(guild.id);
      if (!config?.auditChannelId) return;

      const channel = guild.channels.cache.get(config.auditChannelId) as TextChannel;
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setTitle('🚨 Guard İhlali Tespit Edildi')
        .setDescription(description)
        .addFields(
          { name: 'Kullanıcı', value: `<@${userId}>`, inline: true },
          { name: 'Tür', value: violationType, inline: true },
          { name: 'Önem', value: severity.toUpperCase(), inline: true },
          { name: 'Zaman', value: new Date().toISOString(), inline: true }
        )
        .setColor(this.getSeverityColor(severity))
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Bildirim gönderilirken hata:', error);
    }
  }

  private getSeverityColor(severity: string): number {
    switch (severity) {
      case 'critical': return 0xFF0000;
      case 'high': return 0xFF6600;
      case 'medium': return 0xFFFF00;
      case 'low': return 0x00FF00;
      default: return 0x808080;
    }
  }

  private async monitorSuspiciousActivity(): Promise<void> {
    const config = this.configs.get(this.targetGuildId);
    if (!config || !config.enabled) return;

    const guild = this.client.guilds.cache.get(this.targetGuildId);
    if (!guild) return;

    const recentAuditEvents = await this.auditManager.getAuditEvents(this.targetGuildId, 10);
    const recentChanges = recentAuditEvents.filter(event => 
      Date.now() - event.timestamp.getTime() < config.limits.timeWindow
    );

    if (recentChanges.length > 5) {
      await this.handleViolation(
        guild,
        'unknown',
        'rapid_changes',
        `Hızlı değişiklikler tespit edildi: ${config.limits.timeWindow / 1000}s içinde ${recentChanges.length} değişiklik`,
        'high'
      );
    }
  }

  private async cleanupViolationCounts(): Promise<void> {
    try {
      for (const [guildId, userCounts] of this.violationCounts) {
        for (const [userId, count] of userCounts) {
          if (count > 0) {
            userCounts.set(userId, 0);
          }
        }
      }
    } catch (error) {
      this.logger.error('İhlal sayıları temizlenirken hata:', error);
    }
  }

  private cleanupWhitelistCache(): void {
    try {
      const now = Date.now();
      for (const [key, entry] of this.whitelistCache) {
        if (now - entry.timestamp > this.WHITELIST_CACHE_TTL) {
          this.whitelistCache.delete(key);
        }
      }
    } catch (error) {
      this.logger.error('Whitelist önbelleği temizlenirken hata:', error);
    }
  }

  private async performFullCleanup(): Promise<void> {
    try {
      this.violationCounts.clear();
      this.selfActions.clear();
      this.restorationInProgress.clear();
      this.whitelistCache.clear();
      
      this.logger.guard('Kendi eylemleri ve geri yükleme takibi tamamen temizlendi');
    } catch (error) {
      this.logger.error('Tam temizlik sırasında hata:', error);
    }
  }

  private isSelfAction(guildId: string, targetId: string): boolean {
    const key = `${guildId}:${targetId}`;
    return this.selfActions.has(key);
  }

  private markSelfAction(guildId: string, targetId: string): void {
    const key = `${guildId}:${targetId}`;
    this.selfActions.add(key);
    
    setTimeout(() => {
      this.selfActions.delete(key);
    }, this.SELF_ACTION_TIMEOUT);
  }

  private isBotAction(executorId: string): boolean {
    return executorId === this.client.user?.id;
  }

  public async updateConfig(guildId: string, config: GuardConfig): Promise<void> {
    await this.databaseManager.saveGuardConfig(guildId, config);
    this.configs.set(guildId, config);
    this.logger.guard(`Guard config updated for guild: ${guildId}`);
  }

  public async getConfig(guildId: string): Promise<GuardConfig | null> {
    return this.configs.get(guildId) || null;
  }

  public async addToWhitelist(guildId: string, userId: string): Promise<void> {
    const config = this.configs.get(guildId);
    if (!config) return;

    config.whitelist.users.push(userId);
    await this.updateConfig(guildId, config);
    await this.redisManager.addToWhitelist(userId, guildId);
  }

  public async removeFromWhitelist(guildId: string, userId: string): Promise<void> {
    const config = this.configs.get(guildId);
    if (!config) return;

    config.whitelist.users = config.whitelist.users.filter(id => id !== userId);
    await this.updateConfig(guildId, config);
    await this.redisManager.removeFromWhitelist(userId, guildId);
  }

  private async distributeRoleToMembers(guild: Guild, roleId: string, backupId: string): Promise<void> {
    try {
      this.logger.guard(`👥 ROL DAĞITIMI: ${roleId} rolü için rol dağıtımı başlatılıyor`);
      
      const memberData = await this.databaseManager.getMembersData(backupId);
      if (!memberData || memberData.length === 0) {
        this.logger.guard(`${backupId} yedeğinde üye verisi bulunamadı`);
        return;
      }

      const membersWithRole = memberData.filter(member => 
        member.roles && member.roles.includes(roleId)
      );

      if (membersWithRole.length === 0) {
        this.logger.guard(`Yedekte ${roleId} rolüne sahip üye bulunamadı`);
        return;
      }

      this.logger.guard(`Yedekte ${roleId} rolüne sahip ${membersWithRole.length} üye bulundu`);

      let successCount = 0;
      let failCount = 0;

      for (const memberData of membersWithRole) {
        try {
          const member = await guild.members.fetch(memberData.user_id);
          
          if (!member.roles.cache.has(roleId)) {
            await member.roles.add(roleId, 'Guard: Silme sonrası rol geri yükleme');
            successCount++;
          }
        } catch (error) {
          this.logger.error(`${memberData.user_id} üyesine ${roleId} rolü geri yüklenemedi:`, error);
          failCount++;
        }
      }

      this.logger.guard(`✅ ROL DAĞITIMI TAMAMLANDI: ${roleId} rolü için ${successCount} üye geri yüklendi, ${failCount} başarısız`);
      
    } catch (error) {
      this.logger.error('Üyelere rol dağıtılırken hata:', error);
    }
  }

  private async distributeRoleToMembersFromData(guild: Guild, roleId: string, members: { userId: string, username: string }[]): Promise<void> {
    try {
      this.logger.guard(`👥 ROL DAĞITIMI: ${roleId} rolü için rol dağıtımı başlatılıyor`);
      
      let successCount = 0;
      let failCount = 0;

      for (const memberData of members) {
        try {
          const member = await guild.members.fetch(memberData.userId);
          
          if (!member.roles.cache.has(roleId)) {
            await member.roles.add(roleId, 'Guard: Yetkisiz silme sonrası rol geri yükleme');
            successCount++;
          }
        } catch (error) {
          this.logger.error(`${memberData.userId} üyesine ${roleId} rolü geri yüklenemedi:`, error);
          failCount++;
        }
      }

      this.logger.guard(`✅ ROL DAĞITIMI TAMAMLANDI: ${roleId} rolü için ${successCount} üye geri yüklendi, ${failCount} başarısız`);
      
    } catch (error) {
      this.logger.error('Üyelere rol dağıtılırken hata:', error);
    }
  }
}