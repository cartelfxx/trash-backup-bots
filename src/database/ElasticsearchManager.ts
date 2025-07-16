import { Client } from '@elastic/elasticsearch';
import { Logger } from '../utils/logger';
import { ElasticsearchConfig, AuditEvent, BackupData } from '../utils/types';

export class ElasticsearchManager {
  private client: Client | null = null;
  private logger: Logger;
  private config: ElasticsearchConfig;

  constructor() {
    this.logger = Logger.getInstance();
    const protocol = process.env.ELASTICSEARCH_PROTOCOL || 'http';
    const host = process.env.ELASTICSEARCH_HOST || 'localhost';
    const port = process.env.ELASTICSEARCH_PORT || '9200';
    
    this.config = {
      node: `${protocol}://${host}:${port}`,
      username: process.env.ELASTICSEARCH_USERNAME,
      password: process.env.ELASTICSEARCH_PASSWORD,
      indexPrefix: process.env.ELASTICSEARCH_INDEX_PREFIX || 'discord_guard',
      numberOfShards: 1,
      numberOfReplicas: 0
    };
  }

  public async connect(): Promise<void> {
    try {
      this.client = new Client({
        node: this.config.node,
        auth: this.config.username && this.config.password ? {
          username: this.config.username,
          password: this.config.password
        } : undefined,
        tls: {
          rejectUnauthorized: false
        }
      });

      await this.client.ping();
      this.logger.info('Elasticsearch başarıyla bağlandı');
      await this.initializeIndices();
    } catch (error) {
      this.logger.error('Elasticsearch bağlantı hatası:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }
      this.logger.info('Elasticsearch bağlantısı kesildi');
    } catch (error) {
      this.logger.error('Elasticsearch çıkış hatası:', error);
    }
  }

  private async initializeIndices(): Promise<void> {
    const indices = [
      this.createAuditEventsIndex(),
      this.createBackupsIndex(),
      this.createGuardViolationsIndex(),
      this.createGuildDataIndex(),
      this.createChannelDataIndex(),
      this.createRoleDataIndex(),
      this.createEmojiDataIndex(),
      this.createStickerDataIndex(),
      this.createMemberDataIndex(),
      this.createBanDataIndex(),
      this.createInviteDataIndex(),
      this.createWebhookDataIndex()
    ];

    for (const indexConfig of indices) {
      try {
        if (indexConfig.name === `${this.config.indexPrefix}-audit-events`) {
          try {
            await this.client!.indices.delete({ index: indexConfig.name });
          } catch (deleteError) {

          }
        }
        
        await this.createIndex(indexConfig.name, indexConfig.mapping);
      } catch (error) {
        this.logger.error(`${indexConfig.name} indeksi oluşturma hatası:`, error);
      }
    }
  }

  public async forceRecreateIndices(): Promise<void> {
    try {
      this.logger.info('Tüm Elasticsearch indeksleri yeniden oluşturuluyor...');
      
      const indices = [
        this.createAuditEventsIndex(),
        this.createBackupsIndex(),
        this.createGuardViolationsIndex(),
        this.createGuildDataIndex(),
        this.createChannelDataIndex(),
        this.createRoleDataIndex(),
        this.createEmojiDataIndex(),
        this.createStickerDataIndex(),
        this.createMemberDataIndex(),
        this.createBanDataIndex(),
        this.createInviteDataIndex(),
        this.createWebhookDataIndex()
      ];

      for (const indexConfig of indices) {
        try {
          try {
            await this.client!.indices.delete({ index: indexConfig.name });
          } catch (deleteError) {

          }
          
          await this.client!.indices.create({
            index: indexConfig.name,
            body: indexConfig.mapping
          });
        } catch (error) {
          this.logger.error(`${indexConfig.name} indeksi yeniden oluşturma hatası:`, error);
        }
      }
      
      this.logger.info('Tüm indeksler başarıyla yeniden oluşturuldu');
    } catch (error) {
      this.logger.error('İndeks yeniden oluşturma hatası:', error);
      throw error;
    }
  }


  private createBaseIndex(name: string, properties: any) {
    return {
      name: `${this.config.indexPrefix}-${name}`,
      mapping: {
        mappings: { properties },
        settings: {
          number_of_shards: this.config.numberOfShards,
          number_of_replicas: this.config.numberOfReplicas
        }
      }
    };
  }

  private createAuditEventsIndex() {
    return this.createBaseIndex('audit-events', {
      id: { type: 'keyword' as const },
      guildId: { type: 'keyword' as const },
      actionType: { type: 'keyword' as const },
      executorId: { type: 'keyword' as const },
      targetId: { type: 'keyword' as const },
      targetType: { type: 'keyword' as const },
      changes: { 
        type: 'nested' as const,
        properties: {
          key: { type: 'keyword' as const },
          oldValue: { type: 'text' as const },
          newValue: { type: 'text' as const }
        }
      },
      reason: { type: 'text' as const, analyzer: 'standard' },
      timestamp: { type: 'date' as const },
      metadata: { type: 'object' as const, dynamic: true },
      severity: { type: 'keyword' as const },
      ipAddress: { type: 'ip' as const },
      userAgent: { type: 'text' as const },
      sessionId: { type: 'keyword' as const }
    });
  }

  private createBackupsIndex() {
    return this.createBaseIndex('backups', {
      id: { type: 'keyword' as const },
      guildId: { type: 'keyword' as const },
      timestamp: { type: 'date' as const },
      version: { type: 'keyword' as const },
      size: { type: 'long' as const },
      checksum: { type: 'keyword' as const },
      createdBy: { type: 'keyword' as const },
      description: { type: 'text' as const, analyzer: 'standard' },
      status: { type: 'keyword' as const },
      compression: { type: 'boolean' as const },
      encryption: { type: 'boolean' as const },
      storageType: { type: 'keyword' as const },
      metadata: { type: 'object' as const, dynamic: true }
    });
  }

  private createGuardViolationsIndex() {
    return this.createBaseIndex('guard-violations', {
      id: { type: 'keyword' as const },
      guildId: { type: 'keyword' as const },
      userId: { type: 'keyword' as const },
      violationType: { type: 'keyword' as const },
      description: { type: 'text' as const, analyzer: 'standard' },
      severity: { type: 'keyword' as const },
      actionTaken: { type: 'object' as const, dynamic: true },
      timestamp: { type: 'date' as const },
      ipAddress: { type: 'ip' as const },
      userAgent: { type: 'text' as const },
      sessionId: { type: 'keyword' as const }
    });
  }

  private createGuildDataIndex() {
    return this.createBaseIndex('guild-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      name: { type: 'text' as const, analyzer: 'standard' },
      description: { type: 'text' as const, analyzer: 'standard' },
      icon: { type: 'keyword' as const },
      banner: { type: 'keyword' as const },
      splash: { type: 'keyword' as const },
      discoverySplash: { type: 'keyword' as const },
      features: { type: 'keyword' as const },
      verificationLevel: { type: 'integer' as const },
      explicitContentFilter: { type: 'integer' as const },
      defaultMessageNotifications: { type: 'integer' as const },
      systemChannelId: { type: 'keyword' as const },
      systemChannelFlags: { type: 'integer' as const },
      rulesChannelId: { type: 'keyword' as const },
      publicUpdatesChannelId: { type: 'keyword' as const },
      preferredLocale: { type: 'keyword' as const },
      premiumTier: { type: 'integer' as const },
      premiumSubscriptionCount: { type: 'integer' as const },
      vanityURLCode: { type: 'keyword' as const },
      maxMembers: { type: 'integer' as const },
      maxPresences: { type: 'integer' as const },
      approximateMemberCount: { type: 'integer' as const },
      approximatePresenceCount: { type: 'integer' as const },
      maxVideoChannelUsers: { type: 'integer' as const },
      maxStageVideoChannelUsers: { type: 'integer' as const },
      welcomeScreen: { type: 'object' as const, dynamic: true },
      nsfwLevel: { type: 'integer' as const },
      stickers: { type: 'object' as const, dynamic: true },
      premiumProgressBarEnabled: { type: 'boolean' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private createChannelDataIndex() {
    return this.createBaseIndex('channel-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      type: { type: 'integer' as const },
      name: { type: 'text' as const, analyzer: 'standard' },
      position: { type: 'integer' as const },
      parentId: { type: 'keyword' as const },
      topic: { type: 'text' as const, analyzer: 'standard' },
      nsfw: { type: 'boolean' as const },
      lastMessageId: { type: 'keyword' as const },
      bitrate: { type: 'integer' as const },
      userLimit: { type: 'integer' as const },
      rateLimitPerUser: { type: 'integer' as const },
      rtcRegion: { type: 'keyword' as const },
      videoQualityMode: { type: 'integer' as const },
      messageCount: { type: 'integer' as const },
      memberCount: { type: 'integer' as const },
      threadMetadata: { type: 'object' as const, dynamic: true },
      member: { type: 'object' as const, dynamic: true },
      defaultAutoArchiveDuration: { type: 'integer' as const },
      permissions: { type: 'object' as const, dynamic: true },
      flags: { type: 'integer' as const },
      availableTags: { type: 'object' as const, dynamic: true },
      appliedTags: { type: 'keyword' as const },
      defaultReactionEmoji: { type: 'object' as const, dynamic: true },
      defaultThreadRateLimitPerUser: { type: 'integer' as const },
      defaultSortOrder: { type: 'integer' as const },
      defaultForumLayout: { type: 'integer' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private createRoleDataIndex() {
    return this.createBaseIndex('role-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      name: { type: 'text' as const, analyzer: 'standard' },
      color: { type: 'integer' as const },
      hoist: { type: 'boolean' as const },
      icon: { type: 'keyword' as const },
      unicodeEmoji: { type: 'keyword' as const },
      position: { type: 'integer' as const },
      permissions: { type: 'keyword' as const },
      managed: { type: 'boolean' as const },
      mentionable: { type: 'boolean' as const },
      tags: { type: 'object' as const, dynamic: true },
      timestamp: { type: 'date' as const }
    });
  }

  private createEmojiDataIndex() {
    return this.createBaseIndex('emoji-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      name: { type: 'text' as const, analyzer: 'standard' },
      roles: { type: 'keyword' as const },
      user: { type: 'object' as const, dynamic: true },
      requireColons: { type: 'boolean' as const },
      managed: { type: 'boolean' as const },
      animated: { type: 'boolean' as const },
      available: { type: 'boolean' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private createStickerDataIndex() {
    return this.createBaseIndex('sticker-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      packId: { type: 'keyword' as const },
      name: { type: 'text' as const, analyzer: 'standard' },
      description: { type: 'text' as const, analyzer: 'standard' },
      tags: { type: 'text' as const, analyzer: 'standard' },
      asset: { type: 'keyword' as const },
      previewAsset: { type: 'keyword' as const },
      formatType: { type: 'integer' as const },
      available: { type: 'boolean' as const },
      guildId: { type: 'keyword' as const },
      user: { type: 'object' as const, dynamic: true },
      sortValue: { type: 'integer' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private createMemberDataIndex() {
    return this.createBaseIndex('member-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      guildId: { type: 'keyword' as const },
      nick: { type: 'text' as const, analyzer: 'standard' },
      avatar: { type: 'keyword' as const },
      roles: { type: 'keyword' as const },
      joinedAt: { type: 'date' as const },
      premiumSince: { type: 'date' as const },
      deaf: { type: 'boolean' as const },
      mute: { type: 'boolean' as const },
      pending: { type: 'boolean' as const },
      permissions: { type: 'keyword' as const },
      communicationDisabledUntil: { type: 'date' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private createBanDataIndex() {
    return this.createBaseIndex('ban-data', {
      userId: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      reason: { type: 'text' as const, analyzer: 'standard' },
      moderatorId: { type: 'keyword' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private createInviteDataIndex() {
    return this.createBaseIndex('invite-data', {
      code: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      channelId: { type: 'keyword' as const },
      inviterId: { type: 'keyword' as const },
      maxAge: { type: 'integer' as const },
      maxUses: { type: 'integer' as const },
      uses: { type: 'integer' as const },
      temporary: { type: 'boolean' as const },
      createdAt: { type: 'date' as const },
      expiresAt: { type: 'date' as const }
    });
  }

  private createWebhookDataIndex() {
    return this.createBaseIndex('webhook-data', {
      id: { type: 'keyword' as const },
      backupId: { type: 'keyword' as const },
      type: { type: 'integer' as const },
      channelId: { type: 'keyword' as const },
      name: { type: 'text' as const, analyzer: 'standard' },
      avatar: { type: 'keyword' as const },
      token: { type: 'keyword' as const },
      applicationId: { type: 'keyword' as const },
      sourceGuild: { type: 'object' as const, dynamic: true },
      sourceChannel: { type: 'object' as const, dynamic: true },
      url: { type: 'keyword' as const },
      timestamp: { type: 'date' as const }
    });
  }

  private async createIndex(indexName: string, mapping: any): Promise<void> {
    try {
      const exists = await this.client!.indices.exists({ index: indexName });
      if (!exists) {
        await this.client!.indices.create({
          index: indexName,
          body: mapping
        });
      }
    } catch (error) {
      this.logger.error(`${indexName} indeksi oluşturma hatası:`, error);
      throw error;
    }
  }

  public async recreateIndex(): Promise<void> {
    try {
      const indexName = `${this.config.indexPrefix}-audit-events`;
      
      try {
        await this.client!.indices.delete({ index: indexName });
      } catch (error) {

      }
      
      const indexConfig = this.createAuditEventsIndex();
      await this.client!.indices.create({
        index: indexName,
        body: indexConfig.mapping
      });
    } catch (error) {
      this.logger.error('İndeks yeniden oluşturma hatası:', error);
      throw error;
    }
  }


  private async indexDocument(indexName: string, id: string, document: any): Promise<void> {
    try {
      await this.client!.index({
        index: `${this.config.indexPrefix}-${indexName}`,
        id: id,
        body: document
      });
    } catch (error) {
      this.logger.error(`${indexName} indeksleme hatası:`, error);
      throw error;
    }
  }


  private async searchDocuments(indexName: string, query: any): Promise<any> {
    try {
      const result = await this.client!.search({
        index: `${this.config.indexPrefix}-${indexName}`,
        body: query
      });
      return result;
    } catch (error) {
      this.logger.error(`${indexName} arama hatası:`, error);
      throw error;
    }
  }

  public async indexAuditEvent(event: AuditEvent): Promise<void> {
    try {
      const sanitizedChanges = event.changes.map(change => ({
        key: change.key,
        oldValue: change.oldValue !== undefined && change.oldValue !== null ? String(change.oldValue) : null,
        newValue: change.newValue !== undefined && change.newValue !== null ? String(change.newValue) : null
      }));

      await this.indexDocument('audit-events', event.id, {
        id: event.id,
        guildId: event.guildId,
        actionType: event.actionType,
        executorId: event.executorId,
        targetId: event.targetId,
        targetType: event.targetType,
        changes: sanitizedChanges,
        reason: event.reason,
        timestamp: event.timestamp,
        metadata: event.metadata,
        severity: this.calculateSeverity(event.actionType),
        ipAddress: event.metadata.ipAddress,
        userAgent: event.metadata.userAgent,
        sessionId: event.metadata.sessionId
      });
    } catch (error) {
      if (error instanceof Error && error.message && error.message.includes('mapper') && error.message.includes('cannot be changed')) {
        this.logger.warn('Elasticsearch mapping çakışması tespit edildi, indeks yeniden oluşturuluyor...');
        try {
          await this.recreateIndex();
          await this.indexAuditEvent(event);
          return;
        } catch (recreateError) {
          this.logger.error('İndeks yeniden oluşturma hatası:', recreateError);
        }
      }
      this.logger.error('Denetim olayı indeksleme hatası:', error);
      throw error;
    }
  }

  public async searchAuditEvents(query: any): Promise<any> {
    return await this.searchDocuments('audit-events', query);
  }

  public async indexBackup(backup: BackupData): Promise<void> {
    await this.indexDocument('backups', backup.id, {
      id: backup.id,
      guildId: backup.guildId,
      timestamp: backup.timestamp,
      version: backup.version,
      size: backup.metadata.size,
      checksum: backup.metadata.checksum,
      createdBy: backup.metadata.createdBy,
      description: backup.metadata.description,
      status: 'completed',
      compression: false,
      encryption: false,
      storageType: 'local',
      metadata: backup.metadata
    });
  }

  public async searchBackups(query: any): Promise<any> {
    return await this.searchDocuments('backups', query);
  }

  public async indexGuardViolation(violation: any): Promise<void> {
    await this.indexDocument('guard-violations', violation.id, {
      id: violation.id,
      guildId: violation.guildId,
      userId: violation.userId,
      violationType: violation.violationType,
      description: violation.description,
      severity: violation.severity,
      actionTaken: violation.actionTaken,
      timestamp: violation.timestamp,
      ipAddress: violation.ipAddress,
      userAgent: violation.userAgent,
      sessionId: violation.sessionId
    });
  }

  public async searchGuardViolations(query: any): Promise<any> {
    return await this.searchDocuments('guard-violations', query);
  }


  private createAnalyticsQuery(guildId: string, timeRange: string, aggregations: any) {
    return {
      query: {
        bool: {
          must: [
            { term: { guildId: guildId } },
            {
              range: {
                timestamp: {
                  gte: `now-${timeRange}`,
                  lte: 'now'
                }
              }
            }
          ]
        }
      },
      aggs: aggregations
    };
  }

  public async getAuditAnalytics(guildId: string, timeRange: string): Promise<any> {
    try {
      const query = this.createAnalyticsQuery(guildId, timeRange, {
        action_types: {
          terms: { field: 'actionType' }
        },
        severity_distribution: {
          terms: { field: 'severity' }
        },
        hourly_distribution: {
          date_histogram: {
            field: 'timestamp',
            calendar_interval: 'hour'
          }
        },
        top_executors: {
          terms: { field: 'executorId', size: 10 }
        },
        top_targets: {
          terms: { field: 'targetId', size: 10 }
        }
      });

      const result = await this.searchAuditEvents(query);
      return result.body;
    } catch (error) {
      this.logger.error('Denetim analitikleri alma hatası:', error);
      throw error;
    }
  }

  public async getGuardViolationAnalytics(guildId: string, timeRange: string): Promise<any> {
    try {
      const query = this.createAnalyticsQuery(guildId, timeRange, {
        violation_types: {
          terms: { field: 'violationType' }
        },
        severity_distribution: {
          terms: { field: 'severity' }
        },
        hourly_distribution: {
          date_histogram: {
            field: 'timestamp',
            calendar_interval: 'hour'
          }
        },
        top_violators: {
          terms: { field: 'userId', size: 10 }
        }
      });

      const result = await this.searchGuardViolations(query);
      return result.body;
    } catch (error) {
      this.logger.error('Koruma ihlali analitikleri alma hatası:', error);
      throw error;
    }
  }

  private calculateSeverity(actionType: string): string {
    const criticalActions = [
      'guild_delete', 'channel_delete', 'role_delete', 'member_ban', 'webhook_create'
    ];

    const highActions = [
      'guild_update', 'channel_update', 'role_update', 'member_leave', 'emoji_delete', 'sticker_delete'
    ];

    if (criticalActions.includes(actionType)) {
      return 'critical';
    } else if (highActions.includes(actionType)) {
      return 'high';
    } else {
      return 'medium';
    }
  }

  public async ping(): Promise<boolean> {
    try {
      await this.client!.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  public async getClusterInfo(): Promise<any> {
    try {
      const info = await this.client!.info();
      return info;
    } catch (error) {
      this.logger.error('Küme bilgisi alma hatası:', error);
      throw error;
    }
  }

  public async getIndexStats(): Promise<any> {
    try {
      const stats = await this.client!.indices.stats({
        index: `${this.config.indexPrefix}-*`
      });
      return stats;
    } catch (error) {
      this.logger.error('İndeks istatistikleri alma hatası:', error);
      throw error;
    }
  }
}