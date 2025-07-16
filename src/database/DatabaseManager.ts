import mysql from 'mysql2/promise';
import { Logger } from '../utils/logger';
import { DatabaseConfig, BackupData, AuditEvent, GuardConfig, BackupConfig } from '../utils/types';
import { PermissionFlagsBits } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';

export class DatabaseManager {
  private connection: mysql.Connection | null = null;
  private pool: mysql.Pool | null = null;
  private logger: Logger;
  private config: DatabaseConfig;

  constructor() {
    this.logger = Logger.getInstance();
    this.config = {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'discord_guard_backup',
      connectionLimit: 10,
      acquireTimeout: 60000,
      timeout: 60000
    };
  }

  public async connect(): Promise<void> {
    try {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionLimit: this.config.connectionLimit,
        charset: 'utf8mb4',
        timezone: '+00:00',
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true
      });

      await this.pool.getConnection();
      this.logger.info('MySQL veritabanına başarıyla bağlandı');
      await this.initializeTables();
    } catch (error) {
      this.logger.error('MySQL veritabanına bağlanma hatası:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }
      this.logger.info('MySQL veritabanı bağlantısı kesildi');
    } catch (error) {
      this.logger.error('MySQL veritabanından çıkış hatası:', error);
    }
  }

  private async initializeTables(): Promise<void> {
    const [existingTables] = await this.pool!.execute(
      "SHOW TABLES LIKE 'whitelist'"
    ) as [any[], any];
    
    const whitelistExists = existingTables.length > 0;
    
    if (whitelistExists) {
      this.logger.info('Whitelist tablosu zaten mevcut, veriler korunuyor');
      await this.createMissingTables();
    } else {
      this.logger.info('Tüm tablolar sıfırdan oluşturuluyor');
      await this.dropAllTables();
      await this.createAllTables();
    }
  }

  private async createMissingTables(): Promise<void> {
    const tables = [
      this.createBackupsTable(),
      this.createAuditEventsTable(),
      this.createGuardConfigsTable(),
      this.createBackupConfigsTable(),
      this.createGuildDataTable(),
      this.createChannelDataTable(),
      this.createRoleDataTable(),
      this.createRoleBackupTable(),
      this.createEmojiDataTable(),
      this.createStickerDataTable(),
      this.createMemberDataTable(),
      this.createBanDataTable(),
      this.createInviteDataTable(),
      this.createWebhookDataTable(),
      this.createGuardViolationsTable(),
      this.createBackupMetadataTable(),
      this.createBackupChunksTable(),
      this.createWhitelistTable()
    ];

    for (const tableQuery of tables) {
      try {
        await this.pool!.execute(tableQuery);
      } catch (error) {
        if (error instanceof Error && !error.message.includes('already exists')) {
          this.logger.error('Tablo oluşturma hatası:', error);
        }
      }
    }
  }

  private async createAllTables(): Promise<void> {
    const tables = [
      this.createBackupsTable(),
      this.createAuditEventsTable(),
      this.createGuardConfigsTable(),
      this.createBackupConfigsTable(),
      this.createGuildDataTable(),
      this.createChannelDataTable(),
      this.createRoleDataTable(),
      this.createRoleBackupTable(),
      this.createEmojiDataTable(),
      this.createStickerDataTable(),
      this.createMemberDataTable(),
      this.createBanDataTable(),
      this.createInviteDataTable(),
      this.createWebhookDataTable(),
      this.createGuardViolationsTable(),
      this.createBackupMetadataTable(),
      this.createBackupChunksTable(),
      this.createWhitelistTable()
    ];

    for (const tableQuery of tables) {
      try {
        await this.pool!.execute(tableQuery);
      } catch (error) {
        this.logger.error('Tablo oluşturma hatası:', error);
      }
    }

    if ((this as any)._whitelistBackup) {
      await this.restoreWhitelistData((this as any)._whitelistBackup);
      delete (this as any)._whitelistBackup;
    }
  }

  private async dropAllTables(): Promise<void> {
    const whitelistData = await this.backupWhitelistData();
    
    const tables = [
      'backup_chunks', 'backup_metadata', 'guard_violations', 'webhook_data',
      'invite_data', 'ban_data', 'member_data', 'sticker_data', 'emoji_data',
      'role_backup', 'role_data', 'channel_data', 'guild_data', 'backup_configs',
      'guard_configs', 'audit_events', 'backups', 'whitelist'
    ];

    for (const table of tables) {
      try {
        await this.pool!.execute(`DROP TABLE IF EXISTS ${table}`);
      } catch (error) {
        this.logger.error(`${table} tablosu silme hatası:`, error);
      }
    }
    this.logger.info('Tüm tablolar başarıyla silindi');

    if (whitelistData.length > 0) {
      this.logger.info(`${whitelistData.length} whitelist kaydı yedeklendi, tablo oluşturulduktan sonra geri yüklenecek`);
      (this as any)._whitelistBackup = whitelistData;
    }
  }

  private createBackupsTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS backups (
        id VARCHAR(36) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        timestamp DATETIME NOT NULL,
        version VARCHAR(20) NOT NULL,
        data JSON NOT NULL, -- Store full backup data
        metadata JSON NOT NULL,
        size BIGINT NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_guild_id (guild_id),
        INDEX idx_timestamp (timestamp),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createAuditEventsTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS audit_events (
        id VARCHAR(36) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        action_type VARCHAR(50) NOT NULL,
        executor_id VARCHAR(20) NOT NULL,
        target_id VARCHAR(20),
        target_type VARCHAR(50),
        changes JSON,
        reason TEXT,
        timestamp DATETIME NOT NULL,
        metadata JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_guild_id (guild_id),
        INDEX idx_action_type (action_type),
        INDEX idx_executor_id (executor_id),
        INDEX idx_timestamp (timestamp),
        INDEX idx_target_id (target_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createGuardConfigsTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS guard_configs (
        id VARCHAR(36) PRIMARY KEY,
        guild_id VARCHAR(20) UNIQUE NOT NULL,
        config JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_guild_id (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createBackupConfigsTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS backup_configs (
        id VARCHAR(36) PRIMARY KEY,
        guild_id VARCHAR(20) UNIQUE NOT NULL,
        config JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_guild_id (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createGuildDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS guild_data (
        backup_id VARCHAR(36) NOT NULL,
        id VARCHAR(20) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        icon VARCHAR(255),
        banner VARCHAR(255),
        splash VARCHAR(255),
        discovery_splash VARCHAR(255),
        features JSON,
        verification_level INT NOT NULL,
        explicit_content_filter INT NOT NULL,
        default_message_notifications INT NOT NULL,
        system_channel_id VARCHAR(20),
        system_channel_flags INT NOT NULL,
        rules_channel_id VARCHAR(20),
        public_updates_channel_id VARCHAR(20),
        preferred_locale VARCHAR(10) NOT NULL,
        premium_tier INT NOT NULL,
        premium_subscription_count INT,
        vanity_url_code VARCHAR(20),
        max_members INT,
        max_presences INT,
        approximate_member_count INT,
        approximate_presence_count INT,
        max_video_channel_users INT,
        max_stage_video_channel_users INT,
        welcome_screen JSON,
        nsfw_level INT NOT NULL,
        stickers JSON,
        premium_progress_bar_enabled BOOLEAN NOT NULL,
        member_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_name (name),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createChannelDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS channel_data (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        type INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        position INT NOT NULL,
        parent_id VARCHAR(20),
        topic TEXT,
        nsfw BOOLEAN NOT NULL,
        last_message_id VARCHAR(20),
        bitrate INT,
        user_limit INT,
        rate_limit_per_user INT NOT NULL,
        rtc_region VARCHAR(20),
        video_quality_mode INT,
        message_count INT,
        member_count INT,
        thread_metadata JSON,
        member JSON,
        default_auto_archive_duration INT,
        permissions JSON,
        flags INT NOT NULL,
        available_tags JSON,
        applied_tags JSON,
        default_reaction_emoji JSON,
        default_thread_rate_limit_per_user INT NOT NULL,
        default_sort_order INT,
        default_forum_layout INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_type (type),
        INDEX idx_parent_id (parent_id),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createRoleDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS role_data (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        name VARCHAR(100) NOT NULL,
        color INT NOT NULL,
        hoist BOOLEAN NOT NULL,
        icon VARCHAR(255),
        unicode_emoji VARCHAR(255),
        position INT NOT NULL,
        permissions BIGINT DEFAULT 0,
        permissions_new VARCHAR(255),
        managed BOOLEAN NOT NULL,
        mentionable BOOLEAN NOT NULL,
        tags JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_position (position),
        INDEX idx_name (name),
        INDEX idx_color (color),
        INDEX idx_managed (managed),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createRoleBackupTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS role_backup (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        guild_id VARCHAR(20),
        name VARCHAR(100) NOT NULL,
        color INT NOT NULL,
        hoist BOOLEAN NOT NULL,
        icon VARCHAR(255),
        unicode_emoji VARCHAR(255),
        position INT NOT NULL,
        permissions BIGINT DEFAULT 0,
        permissions_new VARCHAR(255),
        permissions_array JSON,
        managed BOOLEAN NOT NULL,
        mentionable BOOLEAN NOT NULL,
        tags JSON,
        integration_id VARCHAR(20),
        bot_id VARCHAR(20),
        premium_subscriber BOOLEAN,
        available_for_purchase BOOLEAN,
        guild_connections BOOLEAN,
        created_timestamp BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_guild_id (guild_id),
        INDEX idx_position (position),
        INDEX idx_name (name),
        INDEX idx_color (color),
        INDEX idx_managed (managed),
        INDEX idx_permissions (permissions),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createEmojiDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS emoji_data (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        name VARCHAR(100) NOT NULL,
        roles JSON,
        user JSON,
        require_colons BOOLEAN,
        managed BOOLEAN,
        animated BOOLEAN,
        available BOOLEAN,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_name (name),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createStickerDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS sticker_data (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        pack_id VARCHAR(20),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        tags VARCHAR(255) NOT NULL,
        asset VARCHAR(255),
        preview_asset VARCHAR(255),
        format_type INT NOT NULL,
        available BOOLEAN,
        guild_id VARCHAR(20),
        user JSON,
        sort_value INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_name (name),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createWebhookDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS webhook_data (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        type INT NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        name VARCHAR(100),
        avatar VARCHAR(255),
        token VARCHAR(255),
        application_id VARCHAR(20),
        source_guild JSON,
        source_channel JSON,
        url VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_channel_id (channel_id),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createMemberDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS member_data (
        id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        guild_id VARCHAR(20),
        nick VARCHAR(32),
        avatar VARCHAR(255),
        roles JSON NOT NULL,
        joined_at DATETIME NOT NULL,
        premium_since DATETIME,
        deaf BOOLEAN NOT NULL,
        mute BOOLEAN NOT NULL,
        pending BOOLEAN,
        permissions VARCHAR(20),
        communication_disabled_until DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, backup_id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_guild_id (guild_id),
        INDEX idx_joined_at (joined_at),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createBanDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS ban_data (
        user_id VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        reason TEXT,
        moderator_id VARCHAR(20),
        timestamp DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, backup_id),
        INDEX idx_backup_id (backup_id),
        INDEX idx_timestamp (timestamp),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createInviteDataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS invite_data (
        code VARCHAR(20) NOT NULL,
        backup_id VARCHAR(36) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        inviter_id VARCHAR(20),
        max_age INT NOT NULL,
        max_uses INT NOT NULL,
        uses INT NOT NULL,
        temporary BOOLEAN NOT NULL,
        created_at_invite DATETIME NOT NULL,
        expires_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (backup_id, code),
        INDEX idx_backup_id (backup_id),
        INDEX idx_channel_id (channel_id),
        INDEX idx_inviter_id (inviter_id),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createGuardViolationsTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS guard_violations (
        id VARCHAR(36) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        violation_type VARCHAR(50) NOT NULL,
        description TEXT NOT NULL,
        severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
        action_taken JSON,
        timestamp DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_guild_id (guild_id),
        INDEX idx_user_id (user_id),
        INDEX idx_violation_type (violation_type),
        INDEX idx_timestamp (timestamp),
        INDEX idx_severity (severity)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createWhitelistTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS whitelist (
        id VARCHAR(36) PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        whitelist_type ENUM('user', 'role', 'channel', 'permission', 'action') NOT NULL,
        target_id VARCHAR(100) NOT NULL,
        reason TEXT,
        added_by VARCHAR(20) NOT NULL,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        INDEX idx_guild_id (guild_id),
        INDEX idx_type (whitelist_type),
        INDEX idx_target_id (target_id),
        INDEX idx_added_by (added_by),
        INDEX idx_is_active (is_active),
        UNIQUE KEY unique_whitelist (guild_id, whitelist_type, target_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createBackupMetadataTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS backup_metadata (
        id VARCHAR(36) PRIMARY KEY,
        backup_id VARCHAR(36) NOT NULL,
        key_name VARCHAR(100) NOT NULL,
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_backup_id (backup_id),
        INDEX idx_key_name (key_name),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }

  private createBackupChunksTable(): string {
    return `
      CREATE TABLE IF NOT EXISTS backup_chunks (
        backup_id VARCHAR(36) NOT NULL,
        chunk_index INT NOT NULL,
        chunk_data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_backup_id (backup_id),
        INDEX idx_chunk_index (chunk_index),
        FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;
  }


  public async saveBackup(backup: BackupData): Promise<void> {
    try {
      const backupString = JSON.stringify(backup.data);
      const maxChunkSize = 1 * 1024 * 1024;
      
      if (backupString.length > maxChunkSize) {
        const chunks = this.splitIntoChunks(backupString, maxChunkSize);
        
        await this.pool!.execute(
          'INSERT INTO backups (id, guild_id, timestamp, version, data, metadata, size, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            backup.id, backup.guildId, backup.timestamp, backup.version,
            JSON.stringify({ chunks: chunks.length, totalSize: backupString.length }),
            JSON.stringify(backup.metadata), backup.metadata.size, backup.metadata.checksum
          ]
        );

        for (let i = 0; i < chunks.length; i++) {
          await this.pool!.execute(
            'INSERT INTO backup_chunks (backup_id, chunk_index, chunk_data) VALUES (?, ?, ?)',
            [backup.id, i, chunks[i]]
          );
        }
        
        this.logger.backup(`Yedek ${chunks.length} parçada kaydedildi: ${backup.id}`);
      } else {
        await this.pool!.execute(
          'INSERT INTO backups (id, guild_id, timestamp, version, data, metadata, size, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            backup.id, backup.guildId, backup.timestamp, backup.version,
            JSON.stringify(backup.data), JSON.stringify(backup.metadata),
            backup.metadata.size, backup.metadata.checksum
          ]
        );
      }


      await this.saveDataWithErrorHandling('guild', () => this.saveGuildData(backup.id, backup.data.guild));
      await this.saveDataWithErrorHandling('channels', () => this.saveChannelsData(backup.id, backup.data.channels));
      await this.saveDataWithErrorHandling('roles', () => this.saveRolesData(backup.id, backup.data.roles));
      await this.saveDataWithErrorHandling('emojis', () => this.saveEmojisData(backup.id, backup.data.emojis));
      await this.saveDataWithErrorHandling('stickers', () => this.saveStickersData(backup.id, backup.data.stickers));
      await this.saveDataWithErrorHandling('members', () => this.saveMembersData(backup.id, backup.data.members, backup.guildId));
      await this.saveDataWithErrorHandling('bans', () => this.saveBansData(backup.id, backup.data.bans));
      await this.saveDataWithErrorHandling('invites', () => this.saveInvitesData(backup.id, backup.data.invites));
      await this.saveDataWithErrorHandling('webhooks', () => this.saveWebhooksData(backup.id, backup.data.webhooks));

      this.logger.backup(`Yedek başarıyla kaydedildi: ${backup.id}`);
    } catch (error) {
      this.logger.error('Yedek kaydetme hatası:', error);
      throw error;
    }
  }

  private async saveDataWithErrorHandling(dataType: string, saveFunction: () => Promise<void>): Promise<void> {
    try {
      await saveFunction();
    } catch (error) {
      this.logger.error(`${dataType} verisi kaydetme hatası:`, error);
    }
  }

  private splitIntoChunks(data: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push(data.slice(i, i + chunkSize));
    }
    return chunks;
  }

  public async getBackup(backupId: string): Promise<BackupData | null> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT * FROM backups WHERE id = ?',
        [backupId]
      );

      if (!rows || (rows as any[]).length === 0) {
        return null;
      }

      const row = (rows as any[])[0];
      const dataField = JSON.parse(row.data);
      
      let backupData;
      if (dataField.chunks) {
        const [chunkRows] = await this.pool!.execute(
          'SELECT chunk_data FROM backup_chunks WHERE backup_id = ? ORDER BY chunk_index',
          [backupId]
        );
        
        const chunks = (chunkRows as any[]).map((chunk: any) => chunk.chunk_data);
        const fullData = chunks.join('');
        backupData = JSON.parse(fullData);
      } else {
        backupData = dataField;
      }

      return {
        id: row.id,
        guildId: row.guild_id,
        timestamp: new Date(row.timestamp),
        version: row.version,
        data: backupData,
        metadata: JSON.parse(row.metadata)
      };
    } catch (error) {
      this.logger.error('Yedek alma hatası:', error);
      throw error;
    }
  }

  public async getBackupsByGuild(guildId: string, limit: number = 10): Promise<BackupData[]> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT * FROM backups WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?',
        [guildId, limit]
      );

      return (rows as any[]).map(row => ({
        id: row.id,
        guildId: row.guild_id,
        timestamp: new Date(row.timestamp),
        version: row.version,
        data: JSON.parse(row.data),
        metadata: JSON.parse(row.metadata)
      }));
    } catch (error) {
      this.logger.error('Sunucu yedeklerini alma hatası:', error);
      throw error;
    }
  }

  public async deleteBackup(backupId: string): Promise<void> {
    try {
      await this.pool!.execute('DELETE FROM backups WHERE id = ?', [backupId]);
      this.logger.backup(`Yedek silindi: ${backupId}`);
    } catch (error) {
      this.logger.error('Yedek silme hatası:', error);
      throw error;
    }
  }

  public async saveAuditEvent(event: AuditEvent): Promise<void> {
    try {
      await this.pool!.execute(
        'INSERT INTO audit_events (id, guild_id, action_type, executor_id, target_id, target_type, changes, reason, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          event.id, event.guildId, event.actionType, event.executorId,
          event.targetId || null, event.targetType || null,
          JSON.stringify(event.changes), event.reason || null,
          event.timestamp, JSON.stringify(event.metadata)
        ]
      );
    } catch (error) {
      this.logger.error('Denetim olayı kaydetme hatası:', error);
      throw error;
    }
  }

  public async getAuditEvents(guildId: string, limit: number = 50): Promise<AuditEvent[]> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT * FROM audit_events WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?',
        [guildId, limit]
      );

      return (rows as any[]).map(row => ({
        id: row.id,
        guildId: row.guild_id,
        actionType: row.action_type,
        executorId: row.executor_id,
        targetId: row.target_id,
        targetType: row.target_type,
        changes: JSON.parse(row.changes || '[]'),
        reason: row.reason,
        timestamp: new Date(row.timestamp),
        metadata: JSON.parse(row.metadata || '{}')
      }));
    } catch (error) {
      this.logger.error('Denetim olaylarını alma hatası:', error);
      throw error;
    }
  }

  public async saveGuardConfig(guildId: string, config: GuardConfig): Promise<void> {
    try {
      await this.pool!.execute(
        'INSERT INTO guard_configs (id, guild_id, config) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE config = ?',
        [uuidv4(), guildId, JSON.stringify(config), JSON.stringify(config)]
      );
    } catch (error) {
      this.logger.error('Koruma yapılandırması kaydetme hatası:', error);
      throw error;
    }
  }

  public async getGuardConfig(guildId: string): Promise<GuardConfig | null> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT config FROM guard_configs WHERE guild_id = ?',
        [guildId]
      );

      if (!rows || (rows as any[]).length === 0) {
        return null;
      }

      return JSON.parse((rows as any[])[0].config);
    } catch (error) {
      this.logger.error('Koruma yapılandırması alma hatası:', error);
      throw error;
    }
  }

  public async saveBackupConfig(guildId: string, config: BackupConfig): Promise<void> {
    try {
      await this.pool!.execute(
        'INSERT INTO backup_configs (id, guild_id, config) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE config = ?',
        [uuidv4(), guildId, JSON.stringify(config), JSON.stringify(config)]
      );
    } catch (error) {
      this.logger.error('Yedekleme yapılandırması kaydetme hatası:', error);
      throw error;
    }
  }

  public async getBackupConfig(guildId: string): Promise<BackupConfig | null> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT config FROM backup_configs WHERE guild_id = ?',
        [guildId]
      );

      if (!rows || (rows as any[]).length === 0) {
        return null;
      }

      return JSON.parse((rows as any[])[0].config);
    } catch (error) {
      this.logger.error('Yedekleme yapılandırması alma hatası:', error);
      throw error;
    }
  }

  async saveGuildData(backupId: string, guild: any): Promise<void> {
    try {
      await this.pool!.execute(
        `INSERT INTO guild_data (
          backup_id, id, name, description, icon, banner, splash, discovery_splash, features, verification_level, explicit_content_filter, default_message_notifications, system_channel_id, system_channel_flags, rules_channel_id, public_updates_channel_id, preferred_locale, premium_tier, premium_subscription_count, vanity_url_code, max_members, max_presences, approximate_member_count, approximate_presence_count, max_video_channel_users, max_stage_video_channel_users, welcome_screen, nsfw_level, stickers, premium_progress_bar_enabled, member_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          backupId, guild.id, guild.name ?? null, guild.description ?? null,
          guild.icon ?? null, guild.banner ?? null, guild.splash ?? null,
          guild.discoverySplash ?? null, guild.features ? JSON.stringify(guild.features) : null,
          guild.verificationLevel ?? 0, guild.explicitContentFilter ?? 0,
          guild.defaultMessageNotifications ?? 0, guild.systemChannelId ?? null,
          (guild.systemChannelFlags && typeof guild.systemChannelFlags === 'object')
            ? guild.systemChannelFlags.bitfield : guild.systemChannelFlags ?? 0,
          guild.rulesChannelId ?? null, guild.publicUpdatesChannelId ?? null,
          guild.preferredLocale ?? 'en-US', guild.premiumTier ?? 0,
          guild.premiumSubscriptionCount ?? null, guild.vanityURLCode ?? null,
          guild.maxMembers ?? null, guild.maxPresences ?? null,
          guild.approximateMemberCount ?? null, guild.approximatePresenceCount ?? null,
          guild.maxVideoChannelUsers ?? null, guild.maxStageVideoChannelUsers ?? null,
          guild.welcomeScreen ? JSON.stringify(guild.welcomeScreen) : null,
          guild.nsfwLevel ?? 0, guild.stickers ? JSON.stringify(guild.stickers) : null,
          guild.premiumProgressBarEnabled ?? false, guild.memberCount ?? 0
        ]
      );
    } catch (error) {
      this.logger.error(`Sunucu ${guild.id} için veri kaydetme hatası:`, error);
      throw error;
    }
  }

  async saveRolesData(backupId: string, roles: any[]): Promise<void> {
    for (const role of roles) {
      try {
        const { permissionsBigInt, permissionsArray } = this.parseRolePermissions(role.permissions);
        
        const roleData = {
          id: role.id ?? null,
          name: role.name ?? 'Bilinmeyen Rol',
          color: role.color ?? 0,
          hoist: role.hoist ?? false,
          position: role.position ?? 0,
          managed: role.managed ?? false,
          mentionable: role.mentionable ?? false,
          icon: role.icon ?? null,
          unicodeEmoji: role.unicodeEmoji ?? null,
          tags: role.tags ? JSON.stringify(role.tags) : null
        };

        await this.pool!.execute(
          `INSERT INTO role_data (backup_id, id, name, color, hoist, position, permissions, permissions_new, managed, mentionable, icon, unicode_emoji, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            backupId, roleData.id, roleData.name, roleData.color, roleData.hoist,
            roleData.position, permissionsBigInt, JSON.stringify(permissionsArray),
            roleData.managed, roleData.mentionable, roleData.icon, roleData.unicodeEmoji, roleData.tags
          ]
        );

        await this.saveRoleBackupData(backupId, role);
      } catch (error) {
        this.logger.error(`Rol ${role.id} için veri kaydetme hatası:`, error);
      }
    }
  }

  private parseRolePermissions(permissions: any): { permissionsBigInt: bigint, permissionsArray: string[] } {
    let permissionsBigInt = 0n;
    let permissionsArray: string[] = [];

    try {
      if (permissions !== undefined && permissions !== null) {
        permissionsBigInt = typeof permissions === 'object' ? permissions.bitfield : BigInt(permissions);
        permissionsArray = this.parsePermissions(permissionsBigInt);
      }
    } catch (permError) {
      this.logger.error(`Rol izinleri ayrıştırma hatası:`, permError);
      permissionsBigInt = 0n;
      permissionsArray = [];
    }

    if (permissionsBigInt === null || permissionsBigInt === undefined) {
      permissionsBigInt = 0n;
    }

    return { permissionsBigInt, permissionsArray };
  }

  async saveRoleBackupData(backupId: string, role: any): Promise<void> {
    try {
      const { permissionsBigInt, permissionsArray } = this.parseRolePermissions(role.permissions);
      
      const tags = role.tags || {};
      const roleData = {
        id: role.id ?? null,
        guildId: role.guildId ?? role.guild?.id ?? role.guild_id ?? null,
        name: role.name ?? 'Bilinmeyen Rol',
        color: role.color ?? 0,
        hoist: role.hoist ?? false,
        icon: role.icon ?? null,
        unicodeEmoji: role.unicodeEmoji ?? null,
        position: role.position ?? 0,
        managed: role.managed ?? false,
        mentionable: role.mentionable ?? false,
        tags: JSON.stringify(tags),
        integrationId: tags.integrationId ?? null,
        botId: tags.botId ?? null,
        premiumSubscriber: tags.premiumSubscriber ?? false,
        availableForPurchase: tags.availableForPurchase ?? false,
        guildConnections: tags.guildConnections ?? false,
        createdTimestamp: role.createdTimestamp ?? null
      };

      await this.pool!.execute(
        `INSERT INTO role_backup (
          backup_id, id, guild_id, name, color, hoist, icon, unicode_emoji, position, 
          permissions, permissions_new, permissions_array, managed, mentionable, tags,
          integration_id, bot_id, premium_subscriber, available_for_purchase, guild_connections, created_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          backupId, roleData.id, roleData.guildId, roleData.name, roleData.color,
          roleData.hoist, roleData.icon, roleData.unicodeEmoji, roleData.position,
          permissionsBigInt, JSON.stringify(permissionsArray), JSON.stringify(permissionsArray),
          roleData.managed, roleData.mentionable, roleData.tags, roleData.integrationId,
          roleData.botId, roleData.premiumSubscriber, roleData.availableForPurchase,
          roleData.guildConnections, roleData.createdTimestamp
        ]
      );
    } catch (error) {
      this.logger.error(`Rol yedek verisi kaydetme hatası ${role.id}:`, error);
    }
  }

  private parsePermissions(permissions: bigint | number | undefined | null): string[] {
    if (permissions === undefined || permissions === null) {
      return [];
    }

    const permissionFlags = {
      CreateInstantInvite: PermissionFlagsBits.CreateInstantInvite,
      KickMembers: PermissionFlagsBits.KickMembers,
      BanMembers: PermissionFlagsBits.BanMembers,
      Administrator: PermissionFlagsBits.Administrator,
      ManageChannels: PermissionFlagsBits.ManageChannels,
      ManageGuild: PermissionFlagsBits.ManageGuild,
      AddReactions: PermissionFlagsBits.AddReactions,
      ViewAuditLog: PermissionFlagsBits.ViewAuditLog,
      PrioritySpeaker: PermissionFlagsBits.PrioritySpeaker,
      Stream: PermissionFlagsBits.Stream,
      ViewChannel: PermissionFlagsBits.ViewChannel,
      SendMessages: PermissionFlagsBits.SendMessages,
      SendTTSMessages: PermissionFlagsBits.SendTTSMessages,
      ManageMessages: PermissionFlagsBits.ManageMessages,
      EmbedLinks: PermissionFlagsBits.EmbedLinks,
      AttachFiles: PermissionFlagsBits.AttachFiles,
      ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
      MentionEveryone: PermissionFlagsBits.MentionEveryone,
      UseExternalEmojis: PermissionFlagsBits.UseExternalEmojis,
      ViewGuildInsights: PermissionFlagsBits.ViewGuildInsights,
      Connect: PermissionFlagsBits.Connect,
      Speak: PermissionFlagsBits.Speak,
      MuteMembers: PermissionFlagsBits.MuteMembers,
      DeafenMembers: PermissionFlagsBits.DeafenMembers,
      MoveMembers: PermissionFlagsBits.MoveMembers,
      UseVAD: PermissionFlagsBits.UseVAD,
      ChangeNickname: PermissionFlagsBits.ChangeNickname,
      ManageNicknames: PermissionFlagsBits.ManageNicknames,
      ManageRoles: PermissionFlagsBits.ManageRoles,
      ManageWebhooks: PermissionFlagsBits.ManageWebhooks,
      ManageEmojisAndStickers: PermissionFlagsBits.ManageEmojisAndStickers,
      UseApplicationCommands: PermissionFlagsBits.UseApplicationCommands,
      RequestToSpeak: PermissionFlagsBits.RequestToSpeak,
      ManageEvents: PermissionFlagsBits.ManageEvents,
      ManageThreads: PermissionFlagsBits.ManageThreads,
      CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
      CreatePrivateThreads: PermissionFlagsBits.CreatePrivateThreads,
      UseExternalStickers: PermissionFlagsBits.UseExternalStickers,
      SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
      UseEmbeddedActivities: PermissionFlagsBits.UseEmbeddedActivities,
      ModerateMembers: PermissionFlagsBits.ModerateMembers
    };

    const permissionNames = Object.keys(permissionFlags);
    const permissionsBigInt = BigInt(permissions);
    const activePermissions: string[] = [];

    for (const permission of permissionNames) {
      const flag = permissionFlags[permission as keyof typeof permissionFlags];
      if ((permissionsBigInt & flag) === flag) {
        activePermissions.push(permission);
      }
    }

    return activePermissions;
  }

  async saveChannelsData(backupId: string, channels: any[]): Promise<void> {
    for (const channel of channels) {
      try {
        const parentId = channel.parent_id ?? channel.parentId ?? null;
        
        await this.pool!.execute(
          `INSERT INTO channel_data (
            id, backup_id, type, name, position, parent_id, topic, nsfw, last_message_id, bitrate, user_limit, rate_limit_per_user, rtc_region, video_quality_mode, message_count, member_count, thread_metadata, member, default_auto_archive_duration, permissions, flags, available_tags, applied_tags, default_reaction_emoji, default_thread_rate_limit_per_user, default_sort_order, default_forum_layout, guild_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            channel.id, backupId, channel.type ?? 0, channel.name ?? 'Bilinmeyen Kanal',
            channel.position ?? 0, parentId, channel.topic ?? null, channel.nsfw ?? false,
            channel.lastMessageId ?? null, channel.bitrate ?? null, channel.userLimit ?? null,
            channel.rateLimitPerUser ?? 0, channel.rtcRegion ?? null, channel.videoQualityMode ?? null,
            channel.messageCount ?? null, channel.memberCount ?? null,
            channel.threadMetadata ? JSON.stringify(channel.threadMetadata) : null,
            channel.member ? JSON.stringify(channel.member) : null,
            channel.defaultAutoArchiveDuration ?? null,
            channel.permissions ? JSON.stringify(channel.permissions) : null,
            channel.flags ?? 0, channel.availableTags ? JSON.stringify(channel.availableTags) : null,
            channel.appliedTags ? JSON.stringify(channel.appliedTags) : null,
            channel.defaultReactionEmoji ? JSON.stringify(channel.defaultReactionEmoji) : null,
            channel.defaultThreadRateLimitPerUser ?? 0, channel.defaultSortOrder ?? null,
            channel.defaultForumLayout ?? 0, channel.guildId ?? null
          ]
        );
      } catch (error) {
        this.logger.error(`Kanal ${channel.id} için veri kaydetme hatası:`, error);
      }
    }
  }

  async saveWebhooksData(backupId: string, webhooks: any[]): Promise<void> {
    for (const webhook of webhooks) {
      try {
        await this.pool!.execute(
          `INSERT INTO webhook_data (backup_id, id, type, channel_id, name, avatar, token, application_id, source_guild, source_channel, url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            backupId, webhook.id, webhook.type ?? 1, webhook.channelId ?? null,
            webhook.name ?? null, webhook.avatar ?? null, webhook.token ?? null,
            webhook.applicationId ?? null, webhook.sourceGuild ? JSON.stringify(webhook.sourceGuild) : null,
            webhook.sourceChannel ? JSON.stringify(webhook.sourceChannel) : null, webhook.url ?? null
          ]
        );
      } catch (error) {
        this.logger.error(`Webhook ${webhook.id} için veri kaydetme hatası:`, error);
      }
    }
  }

  async saveEmojisData(backupId: string, emojis: any[]): Promise<void> {
    for (const emoji of emojis) {
      try {
        await this.pool!.execute(
          `INSERT INTO emoji_data (backup_id, id, name, roles, user, require_colons, managed, animated, available)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            backupId, emoji.id, emoji.name ?? 'bilinmeyen_emoji',
            emoji.roles ? JSON.stringify(emoji.roles) : null,
            emoji.user ? JSON.stringify(emoji.user) : null,
            emoji.requireColons ?? null, emoji.managed ?? null,
            emoji.animated ?? null, emoji.available ?? null
          ]
        );
      } catch (error) {
        this.logger.error(`Emoji ${emoji.id} için veri kaydetme hatası:`, error);
      }
    }
  }

  async saveStickersData(backupId: string, stickers: any[]): Promise<void> {
    for (const sticker of stickers) {
      try {
        await this.pool!.execute(
          `INSERT INTO sticker_data (backup_id, id, pack_id, name, description, tags, asset, preview_asset, format_type, available, guild_id, user, sort_value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            backupId, sticker.id, sticker.packId ?? null, sticker.name ?? 'Bilinmeyen Stiker',
            sticker.description ?? null, sticker.tags ?? '', sticker.asset ?? null,
            sticker.previewAsset ?? null, sticker.formatType ?? null, sticker.available ?? null,
            sticker.guildId ?? null, sticker.user ? JSON.stringify(sticker.user) : null,
            sticker.sortValue ?? null
          ]
        );
      } catch (error) {
        this.logger.error(`Stiker ${sticker.id} için veri kaydetme hatası:`, error);
      }
    }
  }

  async saveMembersData(backupId: string, members: any[], guildId: string): Promise<void> {
    for (const member of members) {
      try {
        const memberData = {
          guildId: member.guildId ?? guildId,
          nick: member.nick ?? null,
          avatar: member.avatar ?? null,
          deaf: member.deaf ?? false,
          mute: member.mute ?? false,
          pending: member.pending ?? null,
          roles: member.roles ? JSON.stringify(member.roles) : '[]',
          permissions: member.permissions ? JSON.stringify(member.permissions) : null,
          joinedAt: member.joinedAt ? formatDate(member.joinedAt) : formatDate(new Date()),
          premiumSince: member.premiumSince ? formatDate(member.premiumSince) : null,
          communicationDisabledUntil: member.communicationDisabledUntil ? formatDate(member.communicationDisabledUntil) : null
        };

        await this.pool!.execute(
          `INSERT INTO member_data (id, backup_id, guild_id, nick, avatar, roles, joined_at, premium_since, deaf, mute, pending, permissions, communication_disabled_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            member.id, backupId, memberData.guildId, memberData.nick, memberData.avatar,
            memberData.roles, memberData.joinedAt, memberData.premiumSince, memberData.deaf,
            memberData.mute, memberData.pending, memberData.permissions, memberData.communicationDisabledUntil
          ]
        );
      } catch (error) {
        this.logger.error(`Üye ${member.id} için veri kaydetme hatası:`, error);
      }
    }
  }

  async saveBansData(backupId: string, bans: any[]): Promise<void> {
    for (const ban of bans) {
      try {
        await this.pool!.execute(
          `INSERT INTO ban_data (backup_id, user_id, reason, moderator_id, timestamp)
           VALUES (?, ?, ?, ?, ?)`,
          [
            backupId, ban.user?.id ?? ban.userId ?? null, ban.reason ?? null,
            ban.moderatorId ?? null, ban.timestamp ? formatDate(ban.timestamp) : formatDate(new Date())
          ]
        );
      } catch (error) {
        this.logger.error(`Kullanıcı ${ban.user?.id || ban.userId} için ban verisi kaydetme hatası:`, error);
      }
    }
  }

  async saveInvitesData(backupId: string, invites: any[]): Promise<void> {
    for (const invite of invites) {
      try {
        await this.pool!.execute(
          `INSERT INTO invite_data (backup_id, code, channel_id, inviter_id, max_age, max_uses, uses, temporary, created_at_invite, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            backupId, invite.code ?? 'bilinmeyen', invite.channelId ?? null,
            invite.inviter?.id ?? invite.inviterId ?? null, invite.maxAge ?? 0,
            invite.maxUses ?? 0, invite.uses ?? 0, invite.temporary ?? false,
            invite.createdAt ? formatDate(invite.createdAt) : formatDate(new Date()),
            invite.expiresAt ? formatDate(invite.expiresAt) : null
          ]
        );
      } catch (error) {
        this.logger.error(`Davet ${invite.code} için veri kaydetme hatası:`, error);
      }
    }
  }

  public async addToWhitelist(guildId: string, type: 'user' | 'role' | 'channel' | 'permission' | 'action', targetId: string, addedBy: string, reason?: string, expiresAt?: Date): Promise<void> {
    try {
      await this.pool!.execute(
        'INSERT INTO whitelist (id, guild_id, whitelist_type, target_id, reason, added_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = ?, added_by = ?, expires_at = ?, is_active = TRUE',
        [uuidv4(), guildId, type, targetId, reason, addedBy, expiresAt, reason, addedBy, expiresAt]
      );
      this.logger.info(`Sunucu ${guildId} için whitelist'e ${type} ${targetId} eklendi`);
    } catch (error) {
      this.logger.error('Whitelist ekleme hatası:', error);
      throw error;
    }
  }

  public async removeFromWhitelist(guildId: string, type: 'user' | 'role' | 'channel' | 'permission' | 'action', targetId: string): Promise<void> {
    try {
      await this.pool!.execute(
        'UPDATE whitelist SET is_active = FALSE WHERE guild_id = ? AND whitelist_type = ? AND target_id = ?',
        [guildId, type, targetId]
      );
      this.logger.info(`Sunucu ${guildId} için whitelist'ten ${type} ${targetId} kaldırıldı`);
    } catch (error) {
      this.logger.error('Whitelist kaldırma hatası:', error);
      throw error;
    }
  }

  public async getWhitelist(guildId: string): Promise<any[]> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT * FROM whitelist WHERE guild_id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY added_at DESC',
        [guildId]
      );
      return rows as any[];
    } catch (error) {
      this.logger.error('Whitelist alma hatası:', error);
      throw error;
    }
  }

  public async isWhitelisted(guildId: string, type: 'user' | 'role' | 'channel' | 'permission' | 'action', targetId: string): Promise<boolean> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT COUNT(*) as count FROM whitelist WHERE guild_id = ? AND whitelist_type = ? AND target_id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())',
        [guildId, type, targetId]
      );
      return (rows as any[])[0].count > 0;
    } catch (error) {
      this.logger.error('Whitelist kontrol hatası:', error);
      return false;
    }
  }

  public async clearExpiredWhitelist(): Promise<void> {
    try {
      await this.pool!.execute(
        'UPDATE whitelist SET is_active = FALSE WHERE expires_at IS NOT NULL AND expires_at <= NOW()'
      );
      this.logger.info('Süresi dolmuş whitelist kayıtları temizlendi');
    } catch (error) {
      this.logger.error('Süresi dolmuş whitelist temizleme hatası:', error);
    }
  }

  public async backupWhitelistData(): Promise<any[]> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT * FROM whitelist WHERE is_active = TRUE'
      ) as [any[], any];
      return rows as any[];
    } catch (error) {
      this.logger.error('Whitelist verisi yedekleme hatası:', error);
      return [];
    }
  }

  public async restoreWhitelistData(whitelistData: any[]): Promise<void> {
    try {
      for (const entry of whitelistData) {
        await this.pool!.execute(
          'INSERT INTO whitelist (id, guild_id, whitelist_type, target_id, reason, added_by, expires_at, is_active, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason), added_by = VALUES(added_by), expires_at = VALUES(expires_at), is_active = VALUES(is_active)',
          [entry.id, entry.guild_id, entry.whitelist_type, entry.target_id, entry.reason, entry.added_by, entry.expires_at, entry.is_active, entry.added_at]
        );
      }
      this.logger.info(`${whitelistData.length} whitelist kaydı geri yüklendi`);
    } catch (error) {
      this.logger.error('Whitelist verisi geri yükleme hatası:', error);
    }
  }


  async getGuildData(backupId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM guild_data WHERE backup_id = ?',
      [backupId]
    ) as [any[], any];
    return (rows as any[])[0];
  }

  async getRolesData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM role_data WHERE backup_id = ? ORDER BY position DESC',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getRoleBackupData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM role_backup WHERE backup_id = ? ORDER BY position DESC',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getRoleData(backupId: string, roleId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM role_data WHERE backup_id = ? AND id = ?',
      [backupId, roleId]
    ) as [any[], any];
    return (rows as any[])[0];
  }

  async getRoleBackupDataById(backupId: string, roleId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM role_backup WHERE backup_id = ? AND id = ?',
      [backupId, roleId]
    ) as [any[], any];
    return (rows as any[])[0];
  }

  async getRoleWithFullData(backupId: string, roleId: string): Promise<any> {
    const roleData = await this.getRoleData(backupId, roleId);
    const roleBackup = await this.getRoleBackupDataById(backupId, roleId);
    
    if (!roleData && !roleBackup) {
      return null;
    }

    return {
      ...roleData,
      ...roleBackup,
      permissions: {
        bitfield: roleData?.permissions || roleBackup?.permissions,
        array: roleData?.permissions_new ? JSON.parse(roleData.permissions_new) : 
               roleBackup?.permissions_array ? JSON.parse(roleBackup.permissions_array) : []
      },
      tags: roleBackup?.tags ? JSON.parse(roleBackup.tags) : roleData?.tags ? JSON.parse(roleData.tags) : {}
    };
  }

  async getChannelsData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT *, guild_id AS guildId, parent_id AS parent_id FROM channel_data WHERE backup_id = ? ORDER BY position ASC',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getEmojisData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM emoji_data WHERE backup_id = ?',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getStickersData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM sticker_data WHERE backup_id = ?',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getWebhooksData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM webhook_data WHERE backup_id = ?',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getMembersData(backupId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM member_data WHERE backup_id = ?',
      [backupId]
    ) as [any[], any];
    return rows as any[];
  }

  async getChannelData(backupId: string, channelId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT *, guild_id AS guildId, parent_id AS parent_id FROM channel_data WHERE backup_id = ? AND id = ?',
      [backupId, channelId]
    ) as [any[], any];
    
    return (rows as any[])[0];
  }

  async getEmojiData(backupId: string, emojiId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM emoji_data WHERE backup_id = ? AND id = ?',
      [backupId, emojiId]
    ) as [any[], any];
    return (rows as any[])[0];
  }

  async getStickerData(backupId: string, stickerId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM sticker_data WHERE backup_id = ? AND id = ?',
      [backupId, stickerId]
    ) as [any[], any];
    return (rows as any[])[0];
  }

  async getWebhookData(backupId: string, webhookId: string): Promise<any> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM webhook_data WHERE backup_id = ? AND id = ?',
      [backupId, webhookId]
    ) as [any[], any];
    return (rows as any[])[0];
  }

  async getMembersWithRole(backupId: string, roleId: string): Promise<any[]> {
    const [rows] = await this.pool!.execute(
      'SELECT * FROM member_data WHERE backup_id = ? AND JSON_CONTAINS(roles, ?)',
      [backupId, JSON.stringify(roleId)]
    ) as [any[], any];
    return rows as any[];
  }

  async getLatestBackup(guildId: string): Promise<any> {
    try {
      const [rows] = await this.pool!.execute(
        'SELECT * FROM backups WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1',
        [guildId]
      );
      return (rows as any[])[0] || null;
    } catch (error) {
      this.logger.error('En son yedek alma hatası:', error);
      return null;
    }
  }


  private async getDataFromTable(tableName: string, backupId: string, itemId?: string): Promise<any> {
    try {
      const query = itemId 
        ? `SELECT * FROM ${tableName} WHERE backup_id = ? AND id = ?`
        : `SELECT * FROM ${tableName} WHERE backup_id = ?`;
      
      const params = itemId ? [backupId, itemId] : [backupId];
      const [rows] = await this.pool!.execute(query, params) as [any[], any];
      
      return itemId ? (rows as any[])[0] : rows as any[];
    } catch (error) {
      this.logger.error(`${tableName} tablosundan veri alma hatası:`, error);
      return itemId ? null : [];
    }
  }


  async getRoleFromBackup(backupId: string, roleId: string): Promise<any> {
    return await this.getDataFromTable('role_backup', backupId, roleId);
  }

  async getChannelFromBackup(backupId: string, channelId: string): Promise<any> {
    return await this.getDataFromTable('channel_data', backupId, channelId);
  }

  async getEmojiFromBackup(backupId: string, emojiId: string): Promise<any> {
    return await this.getDataFromTable('emoji_data', backupId, emojiId);
  }

  async getStickerFromBackup(backupId: string, stickerId: string): Promise<any> {
    return await this.getDataFromTable('sticker_data', backupId, stickerId);
  }

  async getGuildFromBackup(backupId: string): Promise<any> {
    return await this.getDataFromTable('guild_data', backupId);
  }


  private safeValue(value: any): any {
    return value === undefined ? null : value;
  }

  private sanitizeParameters(params: any[]): any[] {
    return params.map(param => {
      if (param === undefined || param === null) return null;
      
      if (typeof param === 'object' && param !== null) {
        if (typeof param === 'bigint') return param;
        if (param instanceof Date) return param;
        return JSON.stringify(param);
      }
      
      return param;
    });
  }
}

function formatDate(date: Date | string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}