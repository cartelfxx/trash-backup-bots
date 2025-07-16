import { Client, Guild, GuildAuditLogsEntry, AuditLogEvent, User, GuildMember, Role } from 'discord.js';
import { Logger } from '../utils/logger';
import { DatabaseManager } from '../database/DatabaseManager';
import { ElasticsearchManager } from '../database/ElasticsearchManager';
import { AuditEvent, AuditActionType, AuditChange } from '../utils/types';
import { v4 as uuidv4 } from 'uuid';

export class AuditManager {
  private client: Client;
  private databaseManager: DatabaseManager;
  private elasticsearchManager: ElasticsearchManager;
  private logger: Logger;
  private targetGuildId: string;
  private isRunning: boolean = false;
  private debounceMap: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_DELAY = 1000;

  constructor(client: Client, databaseManager: DatabaseManager, elasticsearchManager: ElasticsearchManager, targetGuildId: string) {
    this.client = client;
    this.databaseManager = databaseManager;
    this.elasticsearchManager = elasticsearchManager;
    this.logger = Logger.getInstance();
    this.targetGuildId = targetGuildId;
  }

  public async start(): Promise<void> {
    this.logger.success('Denetim yöneticisi başlatıldı');
    this.setupEventHandlers();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    
    for (const timeout of this.debounceMap.values()) {
      clearTimeout(timeout);
    }
    this.debounceMap.clear();
    
    this.logger.info('Denetim yöneticisi durduruldu');
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
        this.handleMemberUpdate(oldMember as GuildMember, newMember as GuildMember);
      }
    });

    this.client.on('guildMemberRemove', (member) => {
      if (member.guild.id === this.targetGuildId && !member.partial) {
        this.handleMemberLeave(member as GuildMember);
      }
    });


    this.client.on('messageDelete', (message) => {
      if (message.guild?.id === this.targetGuildId) {
        this.handleMessageDelete(message);
      }
    });

    this.client.on('messageDeleteBulk', (messages) => {
      if (messages.first()?.guild?.id === this.targetGuildId) {
        this.handleMessageBulkDelete(messages);
      }
    });

    this.client.on('messageUpdate', (oldMessage, newMessage) => {
      if (newMessage.guild?.id === this.targetGuildId) {
        this.handleMessageUpdate(oldMessage, newMessage);
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


  private async handleGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
    try {
      const changes = this.detectChanges(oldGuild, newGuild);
      if (changes.length > 0) {
        const auditLog = await this.getAuditLog(newGuild, AuditLogEvent.GuildUpdate);
        await this.createAuditEvent(
          newGuild,
          AuditActionType.GUILD_UPDATE,
          auditLog?.executor?.id,
          newGuild.id,
          'guild',
          changes,
          auditLog?.reason ?? undefined
        );
      }
    } catch (error) {
      this.logger.error('Sunucu güncelleme işlenirken hata:', error);
    }
  }

  private async handleGuildDelete(guild: Guild): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(guild, AuditLogEvent.GuildUpdate);
      await this.createAuditEvent(
        guild,
        AuditActionType.GUILD_DELETE,
        auditLog?.executor?.id,
        guild.id,
        'guild',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Sunucu silme işlenirken hata:', error);
    }
  }


  private async handleChannelCreate(channel: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(channel.guild, AuditLogEvent.ChannelCreate);
      await this.createAuditEvent(
        channel.guild,
        AuditActionType.CHANNEL_CREATE,
        auditLog?.executor?.id,
        channel.id,
        'channel',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Kanal oluşturma işlenirken hata:', error);
    }
  }

  private async handleChannelUpdate(oldChannel: any, newChannel: any): Promise<void> {
    try {
      const changes = this.detectChanges(oldChannel, newChannel);
      if (changes.length > 0) {
        const auditLog = await this.getAuditLog(newChannel.guild, AuditLogEvent.ChannelUpdate);
        await this.createAuditEvent(
          newChannel.guild,
          AuditActionType.CHANNEL_UPDATE,
          auditLog?.executor?.id,
          newChannel.id,
          'channel',
          changes,
          auditLog?.reason ?? undefined
        );
      }
    } catch (error) {
      this.logger.error('Kanal güncelleme işlenirken hata:', error);
    }
  }

  private async handleChannelDelete(channel: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(channel.guild, AuditLogEvent.ChannelDelete);
      await this.createAuditEvent(
        channel.guild,
        AuditActionType.CHANNEL_DELETE,
        auditLog?.executor?.id,
        channel.id,
        'channel',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Kanal silme işlenirken hata:', error);
    }
  }


  private async handleRoleCreate(role: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(role.guild, AuditLogEvent.RoleCreate);
      await this.createAuditEvent(
        role.guild,
        AuditActionType.ROLE_CREATE,
        auditLog?.executor?.id,
        role.id,
        'role',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Rol oluşturma işlenirken hata:', error);
    }
  }

  private async handleRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
    if (oldRole.guild.id !== this.targetGuildId) return;

    try {
      const changes: AuditChange[] = [];
      
      if (oldRole.name !== newRole.name) {
        changes.push({
          key: 'name',
          oldValue: oldRole.name,
          newValue: newRole.name
        });
      }
      
      if (oldRole.color !== newRole.color) {
        changes.push({
          key: 'color',
          oldValue: oldRole.color,
          newValue: newRole.color
        });
      }
      
      if (oldRole.hoist !== newRole.hoist) {
        changes.push({
          key: 'hoist',
          oldValue: oldRole.hoist,
          newValue: newRole.hoist
        });
      }
      
      if (oldRole.mentionable !== newRole.mentionable) {
        changes.push({
          key: 'mentionable',
          oldValue: oldRole.mentionable,
          newValue: newRole.mentionable
        });
      }
      
      if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
        changes.push({
          key: 'permissions',
          oldValue: oldRole.permissions.bitfield.toString(),
          newValue: newRole.permissions.bitfield.toString()
        });
      }

      if (changes.length > 0) {
        await this.createAuditEvent(
          newRole.guild,
          AuditActionType.ROLE_UPDATE,
          undefined,
          newRole.id,
          'role',
          changes,
          undefined
        );
      }
    } catch (error) {
      this.logger.error('Rol güncelleme işlenirken hata:', error);
    }
  }

  private async handleRoleDelete(role: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(role.guild, AuditLogEvent.RoleDelete);
      await this.createAuditEvent(
        role.guild,
        AuditActionType.ROLE_DELETE,
        auditLog?.executor?.id,
        role.id,
        'role',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Rol silme işlenirken hata:', error);
    }
  }


  private async handleMemberJoin(member: GuildMember): Promise<void> {
    try {
      await this.createAuditEvent(
        member.guild,
        AuditActionType.MEMBER_JOIN,
        member.id,
        member.id,
        'member',
        [],
        'Üye sunucuya katıldı'
      );
    } catch (error) {
      this.logger.error('Üye katılma işlenirken hata:', error);
    }
  }

  private async handleMemberUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
    try {
      const changes = this.detectMemberChanges(oldMember, newMember);
      if (changes.length > 0) {
        const auditLog = await this.getAuditLog(newMember.guild, AuditLogEvent.MemberUpdate);
        await this.createAuditEvent(
          newMember.guild,
          AuditActionType.MEMBER_UPDATE,
          auditLog?.executor?.id,
          newMember.id,
          'member',
          changes,
          auditLog?.reason ?? undefined
        );
      }
    } catch (error) {
      this.logger.error('Üye güncelleme işlenirken hata:', error);
    }
  }

  private async handleMemberLeave(member: GuildMember): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(member.guild, AuditLogEvent.MemberKick);
      await this.createAuditEvent(
        member.guild,
        AuditActionType.MEMBER_LEAVE,
        auditLog?.executor?.id || member.id,
        member.id,
        'member',
        [],
        auditLog?.reason ?? 'Üye sunucudan ayrıldı'
      );
    } catch (error) {
      this.logger.error('Üye ayrılma işlenirken hata:', error);
    }
  }


  private async handleMessageDelete(message: any): Promise<void> {
    try {
      if (!message.guild) return;
      
      const auditLog = await this.getAuditLog(message.guild, AuditLogEvent.MessageDelete);
      await this.createAuditEvent(
        message.guild,
        AuditActionType.MESSAGE_DELETE,
        auditLog?.executor?.id || message.author?.id,
        message.id,
        'message',
        [],
        auditLog?.reason ?? 'Mesaj silindi'
      );
    } catch (error) {
      this.logger.error('Mesaj silme işlenirken hata:', error);
    }
  }

  private async handleMessageBulkDelete(messages: any): Promise<void> {
    try {
      const guild = messages.first()?.guild;
      if (!guild) return;

      const auditLog = await this.getAuditLog(guild, AuditLogEvent.MessageBulkDelete);
      await this.createAuditEvent(
        guild,
        AuditActionType.MESSAGE_BULK_DELETE,
        auditLog?.executor?.id,
        'bulk',
        'message',
        [{ key: 'messageCount', newValue: messages.size }],
        auditLog?.reason ?? 'Toplu mesaj silme'
      );
    } catch (error) {
      this.logger.error('Toplu mesaj silme işlenirken hata:', error);
    }
  }

  private async handleMessageUpdate(oldMessage: any, newMessage: any): Promise<void> {
    try {
      if (!newMessage.guild) return;

      const changes = this.detectMessageChanges(oldMessage, newMessage);
      if (changes.length > 0) {
        await this.createAuditEvent(
          newMessage.guild,
          AuditActionType.MESSAGE_UPDATE,
          newMessage.author?.id,
          newMessage.id,
          'message',
          changes,
          'Mesaj düzenlendi'
        );
      }
    } catch (error) {
      this.logger.error('Mesaj güncelleme işlenirken hata:', error);
    }
  }


  private async handleEmojiCreate(emoji: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(emoji.guild, AuditLogEvent.EmojiCreate);
      await this.createAuditEvent(
        emoji.guild,
        AuditActionType.EMOJI_CREATE,
        auditLog?.executor?.id,
        emoji.id,
        'emoji',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Emoji oluşturma işlenirken hata:', error);
    }
  }

  private async handleEmojiUpdate(oldEmoji: any, newEmoji: any): Promise<void> {
    try {
      const changes = this.detectChanges(oldEmoji, newEmoji);
      if (changes.length > 0) {
        const auditLog = await this.getAuditLog(newEmoji.guild, AuditLogEvent.EmojiUpdate);
        await this.createAuditEvent(
          newEmoji.guild,
          AuditActionType.EMOJI_UPDATE,
          auditLog?.executor?.id,
          newEmoji.id,
          'emoji',
          changes,
          auditLog?.reason ?? undefined
        );
      }
    } catch (error) {
      this.logger.error('Emoji güncelleme işlenirken hata:', error);
    }
  }

  private async handleEmojiDelete(emoji: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(emoji.guild, AuditLogEvent.EmojiDelete);
      await this.createAuditEvent(
        emoji.guild,
        AuditActionType.EMOJI_DELETE,
        auditLog?.executor?.id,
        emoji.id,
        'emoji',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Emoji silme işlenirken hata:', error);
    }
  }


  private async handleStickerCreate(sticker: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(sticker.guild, AuditLogEvent.StickerCreate);
      await this.createAuditEvent(
        sticker.guild,
        AuditActionType.STICKER_CREATE,
        auditLog?.executor?.id,
        sticker.id,
        'sticker',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Sticker oluşturma işlenirken hata:', error);
    }
  }

  private async handleStickerUpdate(oldSticker: any, newSticker: any): Promise<void> {
    try {
      const changes = this.detectChanges(oldSticker, newSticker);
      if (changes.length > 0) {
        const auditLog = await this.getAuditLog(newSticker.guild, AuditLogEvent.StickerUpdate);
        await this.createAuditEvent(
          newSticker.guild,
          AuditActionType.STICKER_UPDATE,
          auditLog?.executor?.id,
          newSticker.id,
          'sticker',
          changes,
          auditLog?.reason ?? undefined
        );
      }
    } catch (error) {
      this.logger.error('Sticker güncelleme işlenirken hata:', error);
    }
  }

  private async handleStickerDelete(sticker: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(sticker.guild, AuditLogEvent.StickerDelete);
      await this.createAuditEvent(
        sticker.guild,
        AuditActionType.STICKER_DELETE,
        auditLog?.executor?.id,
        sticker.id,
        'sticker',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Sticker silme işlenirken hata:', error);
    }
  }


  private async handleWebhookUpdate(channel: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(channel.guild, AuditLogEvent.WebhookCreate);
      await this.createAuditEvent(
        channel.guild,
        AuditActionType.WEBHOOK_UPDATE,
        auditLog?.executor?.id,
        channel.id,
        'webhook',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Webhook güncelleme işlenirken hata:', error);
    }
  }


  private async handleInviteCreate(invite: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(invite.guild, AuditLogEvent.InviteCreate);
      await this.createAuditEvent(
        invite.guild,
        AuditActionType.INVITE_CREATE,
        auditLog?.executor?.id,
        invite.code,
        'invite',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Davet oluşturma işlenirken hata:', error);
    }
  }

  private async handleInviteDelete(invite: any): Promise<void> {
    try {
      const auditLog = await this.getAuditLog(invite.guild, AuditLogEvent.InviteDelete);
      await this.createAuditEvent(
        invite.guild,
        AuditActionType.INVITE_DELETE,
        auditLog?.executor?.id,
        invite.code,
        'invite',
        [],
        auditLog?.reason ?? undefined
      );
    } catch (error) {
      this.logger.error('Davet silme işlenirken hata:', error);
    }
  }


  private async getAuditLog(guild: Guild, action: AuditLogEvent): Promise<GuildAuditLogsEntry | null> {
    try {
      const auditLogs = await guild.fetchAuditLogs({
        type: action,
        limit: 1
      });

      return auditLogs.entries.first() || null;
    } catch (error) {
      this.logger.error('Denetim kaydı alınırken hata:', error);
      return null;
    }
  }

  private detectChanges(oldObj: any, newObj: any): AuditChange[] {
    const changes: AuditChange[] = [];
    
    if (!oldObj || !newObj) return changes;

    const properties = Object.keys(newObj);
    for (const prop of properties) {
      if (oldObj[prop] !== newObj[prop]) {
        changes.push({
          key: prop,
          oldValue: oldObj[prop],
          newValue: newObj[prop]
        });
      }
    }

    return changes;
  }

  private detectMemberChanges(oldMember: GuildMember, newMember: GuildMember): AuditChange[] {
    const changes: AuditChange[] = [];

    if (oldMember.nickname !== newMember.nickname) {
      changes.push({
        key: 'nickname',
        oldValue: oldMember.nickname,
        newValue: newMember.nickname
      });
    }

    const oldRoles = oldMember.roles.cache.map(role => role.id);
    const newRoles = newMember.roles.cache.map(role => role.id);
    
    if (JSON.stringify(oldRoles) !== JSON.stringify(newRoles)) {
      changes.push({
        key: 'roles',
        oldValue: oldRoles,
        newValue: newRoles
      });
    }

    return changes;
  }

  private detectMessageChanges(oldMessage: any, newMessage: any): AuditChange[] {
    const changes: AuditChange[] = [];

    if (oldMessage.content !== newMessage.content) {
      changes.push({
        key: 'content',
        oldValue: oldMessage.content,
        newValue: newMessage.content
      });
    }

    return changes;
  }

  private async createAuditEvent(
    guild: Guild,
    actionType: AuditActionType,
    executorId: string | undefined,
    targetId: string | undefined,
    targetType: string | undefined,
    changes: AuditChange[],
    reason: string | undefined
  ): Promise<void> {
    const changesHash = JSON.stringify(changes.map(c => ({ key: c.key, oldValue: c.oldValue, newValue: c.newValue })));
    const debounceKey = `${guild.id}-${actionType}-${targetId}-${executorId}-${changesHash}`;

    if (this.debounceMap.has(debounceKey)) {
      clearTimeout(this.debounceMap.get(debounceKey)!);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const event: AuditEvent = {
          id: uuidv4(),
          guildId: guild.id,
          actionType,
          executorId: executorId || 'unknown',
          targetId: targetId || undefined,
          targetType: targetType || undefined,
          changes,
          reason: reason || undefined,
          timestamp: new Date(),
          metadata: {
            ipAddress: undefined,
            userAgent: undefined,
            sessionId: undefined
          }
        };

        await this.databaseManager.saveAuditEvent(event);
        await this.elasticsearchManager.indexAuditEvent(event);

        this.logger.audit(`Denetim olayı oluşturuldu: ${actionType} - ${guild.name}`, {
          guildId: guild.id,
          executorId: event.executorId,
          targetId: event.targetId
        });
      } catch (error) {
        this.logger.error('Denetim olayı oluşturulurken hata:', error);
      } finally {
        this.debounceMap.delete(debounceKey);
      }
    }, this.DEBOUNCE_DELAY);
    
    this.debounceMap.set(debounceKey, timeout);
  }


  public async getAuditEvents(guildId: string, limit: number = 50): Promise<AuditEvent[]> {
    return await this.databaseManager.getAuditEvents(guildId, limit);
  }

  public async searchAuditEvents(query: any): Promise<any> {
    return await this.elasticsearchManager.searchAuditEvents(query);
  }

  public async getAuditAnalytics(guildId: string, timeRange: string): Promise<any> {
    return await this.elasticsearchManager.getAuditAnalytics(guildId, timeRange);
  }
} 