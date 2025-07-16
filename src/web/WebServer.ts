import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { Logger } from '../utils/logger';
import { BackupManager } from '../backup/BackupManager';
import { GuardManager } from '../guard/GuardManager';
import { AuditManager } from '../audit/AuditManager';
import { DatabaseManager } from '../database/DatabaseManager';
import { RedisManager } from '../database/RedisManager';
import { ElasticsearchManager } from '../database/ElasticsearchManager';

interface WebServerConfig {
  port: number;
  host: string;
}

export class WebServer {
  private app: express.Application;
  private server: any;
  private logger: Logger;
  private config: WebServerConfig;
  private targetGuildId: string;

  constructor(
    private backupManager: BackupManager,
    private guardManager: GuardManager,
    private auditManager: AuditManager,
    private databaseManager: DatabaseManager,
    private redisManager: RedisManager,
    private elasticsearchManager: ElasticsearchManager,
    targetGuildId: string
  ) {
    this.logger = Logger.getInstance();
    this.targetGuildId = targetGuildId;
    this.config = {
      port: parseInt(process.env.WEB_SERVER_PORT || '3000'),
      host: process.env.WEB_SERVER_HOST || 'localhost'
    };

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private validateGuildId(req: Request, res: Response, next: NextFunction): void {
    const guildId = req.params.guildId || req.body.guildId;
    
    if (guildId && guildId !== this.targetGuildId) {
      res.status(403).json({
        success: false,
        error: 'Erişim reddedildi: Sunucu ID\'si hedef sunucu ile eşleşmiyor'
      });
      return;
    }
    
    next();
  }

  private setupMiddleware(): void {
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
    }));

    this.app.use(cors({ credentials: true }));
    this.app.use(compression() as unknown as express.RequestHandler);
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));


    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
  }

  private setupRoutes(): void {

    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'sağlıklı',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });


    this.app.use('/api/v1', this.createApiRoutes());


    this.setupWhitelistRoutes();
    

    this.setupRestoreRoutes();
  }

  private setupWhitelistRoutes(): void {
    this.app.post('/api/whitelist/add', this.validateGuildId.bind(this), async (req: Request, res: Response) => {
      try {
        const { guildId, type, targetId, reason, expiresAt, addedBy } = req.body;
        
        if (!guildId || !type || !targetId || !addedBy) {
          return res.status(400).json({ error: 'Gerekli alanlar eksik' });
        }

        await this.databaseManager.addToWhitelist(guildId, type, targetId, addedBy, reason, expiresAt ? new Date(expiresAt) : undefined);
        
        return res.json({ success: true, message: 'Whitelist\'e başarıyla eklendi' });
      } catch (error) {
        this.logger.error('Whitelist\'e ekleme hatası:', error);
        return res.status(500).json({ error: 'Whitelist\'e eklenemedi' });
      }
    });

    this.app.delete('/api/whitelist/remove', this.validateGuildId.bind(this), async (req: Request, res: Response) => {
      try {
        const { guildId, type, targetId } = req.body;
        
        if (!guildId || !type || !targetId) {
          return res.status(400).json({ error: 'Gerekli alanlar eksik' });
        }

        await this.databaseManager.removeFromWhitelist(guildId, type, targetId);
        
        return res.json({ success: true, message: 'Whitelist\'ten başarıyla kaldırıldı' });
      } catch (error) {
        this.logger.error('Whitelist\'ten kaldırma hatası:', error);
        return res.status(500).json({ error: 'Whitelist\'ten kaldırılamadı' });
      }
    });

    this.app.get('/api/whitelist/:guildId', this.validateGuildId.bind(this), async (req: Request, res: Response) => {
      try {
        const { guildId } = req.params;
        const whitelist = await this.databaseManager.getWhitelist(guildId);
        
        return res.json({ success: true, whitelist });
      } catch (error) {
        this.logger.error('Whitelist getirme hatası:', error);
        return res.status(500).json({ error: 'Whitelist alınamadı' });
      }
    });

    this.app.post('/api/whitelist/check', this.validateGuildId.bind(this), async (req: Request, res: Response) => {
      try {
        const { guildId, type, targetId } = req.body;
        
        if (!guildId || !type || !targetId) {
          return res.status(400).json({ error: 'Gerekli alanlar eksik' });
        }

        const isWhitelisted = await this.databaseManager.isWhitelisted(guildId, type, targetId);
        
        return res.json({ success: true, isWhitelisted });
      } catch (error) {
        this.logger.error('Whitelist kontrol hatası:', error);
        return res.status(500).json({ error: 'Whitelist kontrol edilemedi' });
      }
    });
  }

  private setupRestoreRoutes(): void {
    const restoreRoutes = [
      { path: '/api/v1/backups/:backupId/restore/full', method: 'restoreFullGuild' as keyof BackupManager, name: 'tam sunucu' },
      { path: '/api/v1/backups/:backupId/restore/role/:roleId', method: 'restoreRole' as keyof BackupManager, name: 'rol' },
      { path: '/api/v1/backups/:backupId/restore/channel/:channelId', method: 'restoreChannel' as keyof BackupManager, name: 'kanal' },
      { path: '/api/v1/backups/:backupId/restore/emoji/:emojiId', method: 'restoreEmoji' as keyof BackupManager, name: 'emoji' },
      { path: '/api/v1/backups/:backupId/restore/sticker/:stickerId', method: 'restoreSticker' as keyof BackupManager, name: 'sticker' },
      { path: '/api/v1/backups/:backupId/restore/webhook/:webhookId', method: 'restoreWebhook' as keyof BackupManager, name: 'webhook' }
    ];

    restoreRoutes.forEach(route => {
      this.app.post(route.path, async (req, res) => {
        try {
          const { backupId } = req.params;
          const targetId = req.params.roleId || req.params.channelId || req.params.emojiId || req.params.stickerId || req.params.webhookId;
          const success = await (this.backupManager[route.method] as any)(backupId, targetId);
          
          if (success) {
            res.json({ success: true, message: `${route.name} başarıyla geri yüklendi` });
          } else {
            res.status(400).json({ success: false, message: `${route.name} geri yüklenemedi` });
          }
        } catch (error) {
          res.status(500).json({ success: false, message: 'Sunucu hatası' });
        }
      });
    });
  }

  private createApiRoutes(): express.Router {
    const router = express.Router();


    router.get('/backups', this.getBackups.bind(this));
    router.get('/backups/:backupId', this.getBackup.bind(this));
    router.post('/backups', this.validateGuildId.bind(this), this.createBackup.bind(this));
    router.delete('/backups/:backupId', this.deleteBackup.bind(this));
    router.post('/backups/:backupId/restore', this.restoreBackup.bind(this));
    router.get('/backups/guild/:guildId', this.validateGuildId.bind(this), this.getBackupsByGuild.bind(this));


    router.get('/guard/config/:guildId', this.validateGuildId.bind(this), this.getGuardConfig.bind(this));
    router.put('/guard/config/:guildId', this.validateGuildId.bind(this), this.updateGuardConfig.bind(this));
    router.post('/guard/whitelist/:guildId/users/:userId', this.validateGuildId.bind(this), this.addToWhitelist.bind(this));
    router.delete('/guard/whitelist/:guildId/users/:userId', this.validateGuildId.bind(this), this.removeFromWhitelist.bind(this));
    router.get('/guard/violations/:guildId', this.validateGuildId.bind(this), this.getGuardViolations.bind(this));


    router.get('/audit/events/:guildId', this.validateGuildId.bind(this), this.getAuditEvents.bind(this));
    router.get('/audit/analytics/:guildId', this.validateGuildId.bind(this), this.getAuditAnalytics.bind(this));
    router.post('/audit/search', this.validateGuildId.bind(this), this.searchAuditEvents.bind(this));


    router.get('/system/status', this.getSystemStatus.bind(this));
    router.get('/system/stats', this.getSystemStats.bind(this));
    router.post('/system/backup', this.createSystemBackup.bind(this));

    return router;
  }

  private setupErrorHandling(): void {
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Bulunamadı',
        message: `${req.method} ${req.path} rotası bulunamadı`
      });
    });

    this.app.use((error: any, req: Request, res: Response, next: NextFunction) => {
      this.logger.error('Web sunucu hatası:', error);
      
      res.status(error.status || 500).json({
        error: error.message || 'Sunucu Hatası',
        timestamp: new Date().toISOString()
      });
    });
  }


  private async getBackups(req: Request, res: Response): Promise<void> {
    try {
      const { guildId, limit = 10, offset = 0 } = req.query;
      
      if (!guildId) {
        res.status(400).json({
          success: false,
          error: 'guildId parametresi gerekli'
        });
        return;
      }

      const backups = await this.backupManager.getBackupsByGuild(guildId as string, parseInt(limit as string));
      res.json({
        success: true,
        data: backups,
        pagination: {
          limit: parseInt(limit as string),
          offset: parseInt(offset as string),
          total: backups.length
        }
      });
    } catch (error) {
      this.logger.error('Yedekler alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Yedekler alınamadı'
      });
    }
  }

  private async getBackup(req: Request, res: Response): Promise<void> {
    try {
      const { backupId } = req.params;
      const backup = await this.backupManager.getBackup(backupId);
      
      if (backup) {
        res.json({ success: true, data: backup });
      } else {
        res.status(404).json({
          success: false,
          error: 'Yedek bulunamadı'
        });
      }
    } catch (error) {
      this.logger.error('Yedek alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Yedek alınamadı'
      });
    }
  }

  private async createBackup(req: Request, res: Response): Promise<void> {
    try {
      const { guildId, immediate = false } = req.body;
      
      if (!guildId) {
        res.status(400).json({
          success: false,
          error: 'guildId gerekli'
        });
        return;
      }

      const backup = await this.backupManager.createBackup(guildId, immediate);
      
      if (backup) {
        res.json({
          success: true,
          data: backup,
          message: 'Yedek başarıyla oluşturuldu'
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Yedek oluşturulamadı'
        });
      }
    } catch (error) {
      this.logger.error('Yedek oluşturma hatası:', error);
      res.status(500).json({
        success: false,
        error: 'Yedek oluşturulamadı'
      });
    }
  }

  private async deleteBackup(req: Request, res: Response): Promise<void> {
    try {
      const { backupId } = req.params;
      await this.backupManager.deleteBackup(backupId);
      
      res.json({
        success: true,
        message: 'Yedek başarıyla silindi'
      });
    } catch (error) {
      this.logger.error('Yedek silme hatası:', error);
      res.status(500).json({
        success: false,
        error: 'Yedek silinemedi'
      });
    }
  }

  private async restoreBackup(req: Request, res: Response): Promise<void> {
    try {
      const { backupId } = req.params;
      const { guildId } = req.body;
      
      if (!guildId) {
        res.status(400).json({
          success: false,
          error: 'guildId gerekli'
        });
        return;
      }

      await this.backupManager.restoreBackup(backupId, guildId);
      
      res.json({
        success: true,
        message: 'Yedek geri yükleme başlatıldı'
      });
    } catch (error) {
      this.logger.error('Yedek geri yükleme hatası:', error);
      res.status(500).json({
        success: false,
        error: 'Yedek geri yüklenemedi'
      });
    }
  }

  private async getBackupsByGuild(req: Request, res: Response): Promise<void> {
    try {
      const { guildId } = req.params;
      const { limit = 10 } = req.query;
      
      const backups = await this.backupManager.getBackupsByGuild(guildId, parseInt(limit as string));
      
      res.json({
        success: true,
        data: backups
      });
    } catch (error) {
      this.logger.error('Sunucu yedekleri alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Yedekler alınamadı'
      });
    }
  }


  private async getGuardConfig(req: Request, res: Response): Promise<void> {
    try {
      const { guildId } = req.params;
      const config = await this.guardManager.getConfig(guildId);
      
      if (config) {
        res.json({ success: true, data: config });
      } else {
        res.status(404).json({
          success: false,
          error: 'Koruma yapılandırması bulunamadı'
        });
      }
    } catch (error) {
      this.logger.error('Koruma yapılandırması alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Koruma yapılandırması alınamadı'
      });
    }
  }

  private async updateGuardConfig(req: Request, res: Response): Promise<void> {
    try {
      const { guildId } = req.params;
      const config = req.body;
      
      await this.guardManager.updateConfig(guildId, config);
      
      res.json({
        success: true,
        message: 'Koruma yapılandırması başarıyla güncellendi'
      });
    } catch (error) {
      this.logger.error('Koruma yapılandırması güncellenirken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Koruma yapılandırması güncellenemedi'
      });
    }
  }

  private async addToWhitelist(req: Request, res: Response): Promise<void> {
    try {
      const { guildId, userId } = req.params;
      
      await this.guardManager.addToWhitelist(guildId, userId);
      
      res.json({
        success: true,
        message: 'Kullanıcı whitelist\'e başarıyla eklendi'
      });
    } catch (error) {
      this.logger.error('Whitelist\'e kullanıcı ekleme hatası:', error);
      res.status(500).json({
        success: false,
        error: 'Kullanıcı whitelist\'e eklenemedi'
      });
    }
  }

  private async removeFromWhitelist(req: Request, res: Response): Promise<void> {
    try {
      const { guildId, userId } = req.params;
      
      await this.guardManager.removeFromWhitelist(guildId, userId);
      
      res.json({
        success: true,
        message: 'Kullanıcı whitelist\'ten başarıyla kaldırıldı'
      });
    } catch (error) {
      this.logger.error('Whitelist\'ten kullanıcı kaldırma hatası:', error);
      res.status(500).json({
        success: false,
        error: 'Kullanıcı whitelist\'ten kaldırılamadı'
      });
    }
  }

  private async getGuardViolations(req: Request, res: Response): Promise<void> {
    try {
      const { guildId } = req.params;
      const { timeRange = '7d' } = req.query;
      
      const analytics = await this.elasticsearchManager.getGuardViolationAnalytics(guildId, timeRange as string);
      
      res.json({
        success: true,
        data: analytics
      });
    } catch (error) {
      this.logger.error('Koruma ihlalleri alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Koruma ihlalleri alınamadı'
      });
    }
  }


  private async getAuditEvents(req: Request, res: Response): Promise<void> {
    try {
      const { guildId } = req.params;
      const { limit = 50 } = req.query;
      
      const events = await this.auditManager.getAuditEvents(guildId, parseInt(limit as string));
      
      res.json({
        success: true,
        data: events
      });
    } catch (error) {
      this.logger.error('Denetim olayları alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Denetim olayları alınamadı'
      });
    }
  }

  private async getAuditAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const { guildId } = req.params;
      const { timeRange = '7d' } = req.query;
      
      const analytics = await this.auditManager.getAuditAnalytics(guildId, timeRange as string);
      
      res.json({
        success: true,
        data: analytics
      });
    } catch (error) {
      this.logger.error('Denetim analitikleri alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Denetim analitikleri alınamadı'
      });
    }
  }

  private async searchAuditEvents(req: Request, res: Response): Promise<void> {
    try {
      const query = req.body;
      
      const results = await this.auditManager.searchAuditEvents(query);
      
      res.json({
        success: true,
        data: results
      });
    } catch (error) {
      this.logger.error('Denetim olayları aranırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Denetim olayları aranamadı'
      });
    }
  }


  private async getSystemStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        database: {
          mysql: await this.checkDatabaseConnection(),
          redis: await this.checkRedisConnection(),
          elasticsearch: await this.checkElasticsearchConnection()
        },
        services: {
          backup: this.backupManager ? 'çalışıyor' : 'durdu',
          guard: this.guardManager ? 'çalışıyor' : 'durdu',
          audit: this.auditManager ? 'çalışıyor' : 'durdu'
        }
      };
      
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      this.logger.error('Sistem durumu alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Sistem durumu alınamadı'
      });
    }
  }

  private async getSystemStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = {
        timestamp: new Date().toISOString(),
        guilds: this.backupManager ? 'sayı' : 0,
        backups: {
          total: 0,
          recent: 0
        },
        violations: {
          total: 0,
          recent: 0
        },
        auditEvents: {
          total: 0,
          recent: 0
        }
      };
      
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      this.logger.error('Sistem istatistikleri alınırken hata:', error);
      res.status(500).json({
        success: false,
        error: 'Sistem istatistikleri alınamadı'
      });
    }
  }

  private async createSystemBackup(req: Request, res: Response): Promise<void> {
    try {
      const { guildIds } = req.body;
      
      if (!guildIds || !Array.isArray(guildIds)) {
        res.status(400).json({
          success: false,
          error: 'guildIds dizisi gerekli'
        });
        return;
      }

      const results = [];
      for (const guildId of guildIds) {
        try {
          const backup = await this.backupManager.createBackup(guildId, true);
          results.push({
            guildId,
            success: true,
            backupId: backup?.id
          });
        } catch (error) {
          results.push({
            guildId,
            success: false,
            error: (error as Error).message
          });
        }
      }
      
      res.json({
        success: true,
        data: results,
        message: 'Sistem yedekleme tamamlandı'
      });
    } catch (error) {
      this.logger.error('Sistem yedekleme hatası:', error);
      res.status(500).json({
        success: false,
        error: 'Sistem yedekleme oluşturulamadı'
      });
    }
  }


  private async checkDatabaseConnection(): Promise<boolean> {
    try {
      return true;
    } catch (error) {
      return false;
    }
  }

  private async checkRedisConnection(): Promise<boolean> {
    try {
      await this.redisManager.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  private async checkElasticsearchConnection(): Promise<boolean> {
    try {
      await this.elasticsearchManager.ping();
      return true;
    } catch (error) {
      return false;
    }
  }


  public async start(): Promise<void> {
    try {
      return new Promise((resolve, reject) => {
        this.server = this.app.listen(this.config.port, () => {
          this.logger.success(`Web sunucu ${this.config.port} portunda başlatıldı`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          this.logger.error('Web sunucu hatası:', error);
          reject(error);
        });
      });
    } catch (error) {
      this.logger.error('Web sunucu başlatılamadı:', error);
      throw error;
    }
  }
 
  public async stop(): Promise<void> {
    try {
      if (this.server) {
        this.server.close();
        this.logger.info('Web sunucu durduruldu');
      }
    } catch (error) {
      this.logger.error('Web sunucu durdurulurken hata:', error);
    }
  }
} 