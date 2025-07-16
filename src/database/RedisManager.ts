import { createClient, RedisClientType } from 'redis';
import { Logger } from '../utils/logger';
import { RedisConfig } from '../utils/types';

export class RedisManager {
  private client: RedisClientType | null = null;
  private logger: Logger;
  private config: RedisConfig;

  constructor() {
    this.logger = Logger.getInstance();
    this.config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3
    };
  }

  public async connect(): Promise<void> {
    try {
      this.client = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              this.logger.error('Redis bağlantısı 10 denemeden sonra başarısız oldu');
              return new Error('Redis bağlantısı başarısız');
            }
            return Math.min(retries * 100, 3000);
          }
        },
        password: this.config.password,
        database: this.config.db
      });

      this.client.on('error', (err) => {
        this.logger.error('Redis istemci hatası:', err);
      });

      this.client.on('connect', () => {
        this.logger.info('Redis istemcisi bağlandı');
      });

      this.client.on('ready', () => {
        this.logger.info('Redis istemcisi hazır');
      });

      this.client.on('end', () => {
        this.logger.warn('Redis istemcisi bağlantısı kesildi');
      });

      await this.client.connect();
      this.logger.info('Redis veritabanı başarıyla bağlandı');
    } catch (error) {
      this.logger.error('Redis veritabanına bağlanma hatası:', error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.client) {
        await this.client.quit();
        this.client = null;
      }
      this.logger.info('Redis veritabanı bağlantısı kesildi');
    } catch (error) {
      this.logger.error('Redis veritabanından çıkış hatası:', error);
    }
  }


  private async executeRedisOperation<T>(operation: () => Promise<T>, errorMessage: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error(errorMessage, error);
      throw error;
    }
  }


  public async set(key: string, value: string, ttl?: number): Promise<void> {
    await this.executeRedisOperation(
      async () => {
        if (ttl) {
          await this.client!.setEx(key, ttl, value);
        } else {
          await this.client!.set(key, value);
        }
      },
      'Redis anahtarı ayarlama hatası:'
    );
  }

  public async get(key: string): Promise<string | null> {
    return await this.executeRedisOperation(
      () => this.client!.get(key),
      'Redis anahtarı alma hatası:'
    );
  }

  public async del(key: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.del(key),
      'Redis anahtarı silme hatası:'
    );
  }

  public async exists(key: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.exists(key),
      'Redis anahtarı varlık kontrolü hatası:'
    );
  }


  public async hset(key: string, field: string, value: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.hSet(key, field, value),
      'Redis hash alanı ayarlama hatası:'
    );
  }

  public async hget(key: string, field: string): Promise<string | null> {
    return await this.executeRedisOperation(
      async () => {
        const result = await this.client!.hGet(key, field);
        return result || null;
      },
      'Redis hash alanı alma hatası:'
    );
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    return await this.executeRedisOperation(
      () => this.client!.hGetAll(key),
      'Redis hash tüm alanları alma hatası:'
    );
  }

  public async hdel(key: string, field: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.hDel(key, field),
      'Redis hash alanı silme hatası:'
    );
  }


  public async lpush(key: string, value: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.lPush(key, value),
      'Redis listesine ekleme hatası:'
    );
  }

  public async rpush(key: string, value: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.rPush(key, value),
      'Redis listesine ekleme hatası:'
    );
  }

  public async lpop(key: string): Promise<string | null> {
    return await this.executeRedisOperation(
      () => this.client!.lPop(key),
      'Redis listesinden çıkarma hatası:'
    );
  }

  public async rpop(key: string): Promise<string | null> {
    return await this.executeRedisOperation(
      () => this.client!.rPop(key),
      'Redis listesinden çıkarma hatası:'
    );
  }

  public async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return await this.executeRedisOperation(
      () => this.client!.lRange(key, start, stop),
      'Redis liste aralığı alma hatası:'
    );
  }


  public async sadd(key: string, member: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.sAdd(key, member),
      'Redis setine ekleme hatası:'
    );
  }

  public async srem(key: string, member: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.sRem(key, member),
      'Redis setinden çıkarma hatası:'
    );
  }

  public async smembers(key: string): Promise<string[]> {
    return await this.executeRedisOperation(
      () => this.client!.sMembers(key),
      'Redis set üyelerini alma hatası:'
    );
  }

  public async sismember(key: string, member: string): Promise<boolean> {
    return await this.executeRedisOperation(
      () => this.client!.sIsMember(key, member),
      'Redis set üyelik kontrolü hatası:'
    );
  }


  public async zadd(key: string, score: number, member: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.zAdd(key, { score, value: member }),
      'Redis sıralı setine ekleme hatası:'
    );
  }

  public async zrem(key: string, member: string): Promise<number> {
    return await this.executeRedisOperation(
      () => this.client!.zRem(key, member),
      'Redis sıralı setinden çıkarma hatası:'
    );
  }

  public async zrange(key: string, start: number, stop: number, withScores: boolean = false): Promise<string[]> {
    return await this.executeRedisOperation(
      async () => {
        if (withScores) {
          const result = await this.client!.zRangeWithScores(key, start, stop);
          return result.map(item => `${item.value}:${item.score}`);
        } else {
          return await this.client!.zRange(key, start, stop);
        }
      },
      'Redis sıralı set aralığı alma hatası:'
    );
  }

  public async zscore(key: string, member: string): Promise<number | null> {
    return await this.executeRedisOperation(
      () => this.client!.zScore(key, member),
      'Redis sıralı set skoru alma hatası:'
    );
  }


  private createGuardKey(type: string, guildId: string, userId: string, action?: string): string {
    const base = `guard:${type}:${guildId}:${userId}`;
    return action ? `${base}:${action}` : base;
  }

  public async setUserViolationCount(userId: string, guildId: string, count: number, ttl: number = 3600): Promise<void> {
    const key = this.createGuardKey('violations', guildId, userId);
    await this.set(key, count.toString(), ttl);
  }

  public async getUserViolationCount(userId: string, guildId: string): Promise<number> {
    const key = this.createGuardKey('violations', guildId, userId);
    const count = await this.get(key);
    return count ? parseInt(count) : 0;
  }

  public async incrementUserViolationCount(userId: string, guildId: string, ttl: number = 3600): Promise<number> {
    const key = this.createGuardKey('violations', guildId, userId);
    const count = await this.get(key);
    const newCount = (count ? parseInt(count) : 0) + 1;
    await this.set(key, newCount.toString(), ttl);
    return newCount;
  }

  public async setUserCooldown(userId: string, guildId: string, action: string, ttl: number): Promise<void> {
    const key = this.createGuardKey('cooldown', guildId, userId, action);
    await this.set(key, '1', ttl);
  }

  public async isUserOnCooldown(userId: string, guildId: string, action: string): Promise<boolean> {
    const key = this.createGuardKey('cooldown', guildId, userId, action);
    const exists = await this.exists(key);
    return exists === 1;
  }

  public async addToWhitelist(userId: string, guildId: string): Promise<void> {
    const key = this.createGuardKey('whitelist', guildId, userId);
    await this.sadd(key, userId);
  }

  public async removeFromWhitelist(userId: string, guildId: string): Promise<void> {
    const key = this.createGuardKey('whitelist', guildId, userId);
    await this.srem(key, userId);
  }

  public async isWhitelisted(userId: string, guildId: string): Promise<boolean> {
    const key = this.createGuardKey('whitelist', guildId, userId);
    return await this.sismember(key, userId);
  }


  private createBackupKey(type: string, backupId: string): string {
    return `backup:${type}:${backupId}`;
  }

  public async setBackupProgress(backupId: string, progress: number): Promise<void> {
    const key = this.createBackupKey('progress', backupId);
    await this.set(key, progress.toString(), 3600);
  }

  public async getBackupProgress(backupId: string): Promise<number> {
    const key = this.createBackupKey('progress', backupId);
    const progress = await this.get(key);
    return progress ? parseInt(progress) : 0;
  }

  public async setBackupStatus(backupId: string, status: string): Promise<void> {
    const key = this.createBackupKey('status', backupId);
    await this.set(key, status, 3600);
  }

  public async getBackupStatus(backupId: string): Promise<string | null> {
    const key = this.createBackupKey('status', backupId);
    return await this.get(key);
  }


  private createSessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  public async setSession(sessionId: string, data: any, ttl: number = 3600): Promise<void> {
    const key = this.createSessionKey(sessionId);
    await this.set(key, JSON.stringify(data), ttl);
  }

  public async getSession(sessionId: string): Promise<any | null> {
    const key = this.createSessionKey(sessionId);
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const key = this.createSessionKey(sessionId);
    await this.del(key);
  }


  private createCacheKey(key: string): string {
    return `cache:${key}`;
  }

  public async setCache(key: string, data: any, ttl: number = 300): Promise<void> {
    const cacheKey = this.createCacheKey(key);
    await this.set(cacheKey, JSON.stringify(data), ttl);
  }

  public async getCache(key: string): Promise<any | null> {
    const cacheKey = this.createCacheKey(key);
    const data = await this.get(cacheKey);
    return data ? JSON.parse(data) : null;
  }

  public async deleteCache(key: string): Promise<void> {
    const cacheKey = this.createCacheKey(key);
    await this.del(cacheKey);
  }


  public async incrementRateLimit(key: string, ttl: number = 60): Promise<number> {
    const current = await this.get(key);
    const count = current ? parseInt(current) : 0;
    const newCount = count + 1;
    await this.set(key, newCount.toString(), ttl);
    return newCount;
  }

  public async getRateLimit(key: string): Promise<number> {
    const current = await this.get(key);
    return current ? parseInt(current) : 0;
  }


  public async flushdb(): Promise<void> {
    await this.executeRedisOperation(
      () => this.client!.flushDb(),
      'Redis veritabanı temizleme hatası:'
    );
    this.logger.info('Redis veritabanı temizlendi');
  }

  public async ping(): Promise<string> {
    return await this.executeRedisOperation(
      () => this.client!.ping(),
      'Redis ping hatası:'
    );
  }

  public async info(): Promise<string> {
    return await this.executeRedisOperation(
      () => this.client!.info(),
      'Redis bilgisi alma hatası:'
    );
  }
} 