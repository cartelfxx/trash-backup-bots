import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import { Logger } from './utils/logger';
import { DatabaseManager } from './database/DatabaseManager';
import { RedisManager } from './database/RedisManager';
import { ElasticsearchManager } from './database/ElasticsearchManager';
import { GuardManager } from './guard/GuardManager';
import { BackupManager } from './backup/BackupManager';
import { AuditManager } from './audit/AuditManager';
import { WebServer } from './web/WebServer';
import { WhitelistCommands } from './commands/WhitelistCommands';
import * as dotenv from 'dotenv';

dotenv.config();

export class DiscordGuardBackup {
  private client!: Client;
  private logger!: Logger;
  private databaseManager!: DatabaseManager;
  private redisManager!: RedisManager;
  private elasticsearchManager!: ElasticsearchManager;
  private backupManager!: BackupManager;
  private guardManager!: GuardManager;
  private auditManager!: AuditManager;
  private webServer!: WebServer;
  private whitelistCommands!: WhitelistCommands;
  private targetGuildId!: string;

  constructor() {
    this.logger = Logger.getInstance();
    
    this.targetGuildId = process.env.DISCORD_GUILD_ID || '';
    if (!this.targetGuildId) {
      this.logger.error('DISCORD_GUILD_ID ortam değişkeni gerekli');
      process.exit(1);
    }
    
    this.logger.info(`Discord Guard & Backup Sistemi başlatılıyor - Sunucu: ${this.targetGuildId}`);
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User,
        Partials.GuildMember,
        Partials.Reaction,
        Partials.GuildScheduledEvent,
        Partials.ThreadMember
      ]
    });

    this.initializeManagers();
    this.setupEventHandlers();
  }

  private initializeManagers(): void {
    this.databaseManager = new DatabaseManager();
    this.redisManager = new RedisManager();
    this.elasticsearchManager = new ElasticsearchManager();
    this.auditManager = new AuditManager(this.client, this.databaseManager, this.elasticsearchManager, this.targetGuildId);
    this.backupManager = new BackupManager(this.client, this.databaseManager, this.elasticsearchManager, this.auditManager, this.targetGuildId);
    this.guardManager = new GuardManager(this.client, this.databaseManager, this.redisManager, this.elasticsearchManager, this.auditManager, this.backupManager);
    this.webServer = new WebServer(this.backupManager, this.guardManager, this.auditManager, this.databaseManager, this.redisManager, this.elasticsearchManager, this.targetGuildId);
    this.whitelistCommands = new WhitelistCommands(this.client, this.databaseManager, this.backupManager, this.targetGuildId);
  }

  private setupEventHandlers(): void {
    this.client.once('ready', async () => {
      this.logger.info(`${this.client.user?.tag} olarak giriş yapıldı`);
      
      const targetGuild = this.client.guilds.cache.get(this.targetGuildId);
      if (!targetGuild) {
        this.logger.error(`${this.targetGuildId} hedef sunucusu bulunamadı. Bot hedef sunucuda olmalı.`);
        process.exit(1);
      }
      
      this.logger.info(`Hedef sunucuya bağlanıldı: ${targetGuild.name} (${targetGuild.id})`);
      
      await this.startManagers();
    });

    this.client.on('error', (error) => {
      this.logger.error('Discord istemci hatası:', error);
    });

    this.client.on('disconnect', () => {
      this.logger.warn('Discord istemcisi bağlantısı kesildi');
    });

    this.client.on('reconnecting', () => {
      this.logger.info('Discord istemcisi yeniden bağlanıyor...');
    });
  }

  private async startManagers(): Promise<void> {
    try {
      this.logger.info('Yöneticiler başlatılıyor...');

      const managers = [
        { name: 'Veritabanı', manager: this.databaseManager },
        { name: 'Redis', manager: this.redisManager },
        { name: 'Elasticsearch', manager: this.elasticsearchManager }
      ];

      for (const { name, manager } of managers) {
        await manager.connect();
        this.logger.info(`${name} yöneticisi başlatıldı`);
      }

      try {
        await this.elasticsearchManager.forceRecreateIndices();
        this.logger.info('Elasticsearch indeksleri başarıyla yeniden oluşturuldu');
      } catch (error) {
        this.logger.warn('Elasticsearch indeksleri yeniden oluşturulurken hata, mevcut indekslerle devam ediliyor:', error);
      }

      const serviceManagers = [
        { name: 'Denetim', manager: this.auditManager },
        { name: 'Yedekleme', manager: this.backupManager },
        { name: 'Koruma', manager: this.guardManager },
        { name: 'Web Sunucu', manager: this.webServer }
      ];

      for (const { name, manager } of serviceManagers) {
        await manager.start();
        this.logger.info(`${name} yöneticisi başlatıldı`);
      }

      this.logger.info('Tüm yöneticiler başarıyla başlatıldı');
      this.logger.info(`Discord Guard & Backup Sistemi artık ${this.targetGuildId} sunucusunu koruyor`);

    } catch (error) {
      this.logger.error('Yöneticiler başlatılırken hata:', error);
      process.exit(1);
    }
  }

  public async stop(): Promise<void> {
    try {
      this.logger.info('Discord Guard & Backup Sistemi durduruluyor...');

      const services = [
        { name: 'Web Sunucu', manager: this.webServer },
        { name: 'Koruma', manager: this.guardManager },
        { name: 'Yedekleme', manager: this.backupManager },
        { name: 'Denetim', manager: this.auditManager }
      ];

      for (const { name, manager } of services) {
        await manager.stop();
      }

      const databases = [
        { name: 'Elasticsearch', manager: this.elasticsearchManager },
        { name: 'Redis', manager: this.redisManager },
        { name: 'Veritabanı', manager: this.databaseManager }
      ];

      for (const { name, manager } of databases) {
        await manager.disconnect();
      }

      this.client.destroy();
      this.logger.info('Discord Guard & Backup Sistemi başarıyla durduruldu');
    } catch (error) {
      this.logger.error('Sistem durdurulurken hata:', error);
    }
  }

  public async start(): Promise<void> {
    try {
      const token = process.env.DISCORD_TOKEN;
      if (!token) {
        throw new Error('DISCORD_TOKEN ortam değişkeni gerekli');
      }

      await this.client.login(token);
    } catch (error) {
      this.logger.error('Discord Guard & Backup Sistemi başlatılırken hata:', error);
      process.exit(1);
    }
  }
}


const handleShutdown = async () => {
  const app = new DiscordGuardBackup();
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);


const app = new DiscordGuardBackup();
app.start().catch((error) => {
  console.error('Uygulama başlatılamadı:', error);
  process.exit(1);
}); 