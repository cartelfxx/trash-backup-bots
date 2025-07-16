import { Client, Message, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Logger } from '../utils/logger';
import { DatabaseManager } from '../database/DatabaseManager';
import { BackupManager } from '../backup/BackupManager';

export class WhitelistCommands {
  private client: Client;
  private logger: Logger;
  private databaseManager: DatabaseManager;
  private backupManager: BackupManager;
  private targetGuildId: string;

  constructor(
    client: Client,
    databaseManager: DatabaseManager,
    backupManager: BackupManager,
    targetGuildId: string
  ) {
    this.client = client;
    this.logger = Logger.getInstance();
    this.databaseManager = databaseManager;
    this.backupManager = backupManager;
    this.targetGuildId = targetGuildId;
    this.setupCommands();
  }

  private setupCommands(): void {
    this.client.on('messageCreate', async (message: Message) => {
      if (message.author.bot) return;
      if (!message.guild) return;


      if (message.guild.id !== this.targetGuildId) return;

      const prefix = '!whitelist';
      if (!message.content.startsWith(prefix)) return;


      const hasBackup = await this.checkServerHasBackup(message.guild.id);
      if (!hasBackup) {
        const embed = new EmbedBuilder()
          .setTitle('❌ Whitelist Komutu Kullanılamaz')
          .setDescription('Bu sunucuda whitelist komutları kullanabilmek için önce backup alınması gerekiyor.')
          .setColor(0xFF0000)
          .setTimestamp();
        
        message.reply({ embeds: [embed] });
        return;
      }


      if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        const embed = new EmbedBuilder()
          .setTitle('❌ Yetkisiz')
          .setDescription('Bu komutu kullanmak için "Sunucuyu Yönet" yetkisine sahip olmalısınız.')
          .setColor(0xFF0000)
          .setTimestamp();
        
        message.reply({ embeds: [embed] });
        return;
      }

      const args = message.content.slice(prefix.length).trim().split(' ');
      const command = args[0]?.toLowerCase();

      try {
        switch (command) {
          case 'add':
            await this.handleAdd(message, args);
            break;
          case 'remove':
            await this.handleRemove(message, args);
            break;
          case 'list':
            await this.handleList(message);
            break;
          case 'check':
            await this.handleCheck(message, args);
            break;
          case 'debug':
            await this.handleDebug(message, args);
            break;
          case 'help':
            await this.handleHelp(message);
            break;
          default:
            await this.handleHelp(message);
        }
      } catch (error) {
        this.logger.error('Error handling whitelist command:', error);
        const embed = new EmbedBuilder()
          .setTitle('❌ Hata')
          .setDescription('Komut işlenirken bir hata oluştu.')
          .setColor(0xFF0000)
          .setTimestamp();
        
        message.reply({ embeds: [embed] });
      }
    });
  }

  private async checkServerHasBackup(guildId: string): Promise<boolean> {
    try {
      const backups = await this.backupManager.getBackupsByGuild(guildId, 1);
      return backups.length > 0;
    } catch (error) {
      this.logger.error('Error checking server backup:', error);
      return false;
    }
  }

  private async handleAdd(message: Message, args: string[]): Promise<void> {
    if (args.length < 4) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Eksik Parametre')
        .setDescription('Kullanım: `!whitelist add <type> <target> [reason] [expires]`\n\n**Türler:**\n• `user` - Kullanıcı ID\n• `role` - Rol ID\n• `action` - Aksiyon (role_delete, channel_create, vb.)\n\n**Örnek:**\n`!whitelist add user 123456789 "Admin user" 24h`')
        .setColor(0xFF6600)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
      return;
    }

    const type = args[1];
    const targetId = args[2];
    const reason = args.slice(3, -1).join(' ') || 'No reason provided';
    const expiresStr = args[args.length - 1];


    if (!['user', 'role', 'action'].includes(type)) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Geçersiz Tür')
        .setDescription('Geçerli türler: `user`, `role`, `action`')
        .setColor(0xFF0000)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
      return;
    }


    let expiresAt: Date | undefined;
    if (expiresStr && expiresStr !== reason) {
      const parsedExpires = this.parseExpiration(expiresStr);
      if (!parsedExpires) {
        const embed = new EmbedBuilder()
          .setTitle('❌ Geçersiz Süre')
          .setDescription('Geçerli süre formatları: `1h`, `24h`, `7d`, `30d`')
          .setColor(0xFF0000)
          .setTimestamp();
        
        message.reply({ embeds: [embed] });
        return;
      }
      expiresAt = parsedExpires;
    }

    try {
      await this.databaseManager.addToWhitelist(
        message.guild!.id,
        type as any,
        targetId,
        message.author.id,
        reason,
        expiresAt
      );

      const embed = new EmbedBuilder()
        .setTitle('✅ Whitelist Eklendi')
        .setDescription(`**Tür:** ${type}\n**Hedef:** ${targetId}\n**Sebep:** ${reason}${expiresAt ? `\n**Bitiş:** ${expiresAt.toLocaleString('tr-TR')}` : ''}`)
        .setColor(0x00FF00)
        .setTimestamp();

      message.reply({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Error adding to whitelist:', error);
      const embed = new EmbedBuilder()
        .setTitle('❌ Hata')
        .setDescription('Whitelist eklenirken bir hata oluştu.')
        .setColor(0xFF0000)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
    }
  }

  private async handleRemove(message: Message, args: string[]): Promise<void> {
    if (args.length < 3) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Eksik Parametre')
        .setDescription('Kullanım: `!whitelist remove <type> <target>`\n\n**Örnek:**\n`!whitelist remove user 123456789`')
        .setColor(0xFF6600)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
      return;
    }

    const type = args[1];
    const targetId = args[2];

    try {
      await this.databaseManager.removeFromWhitelist(
        message.guild!.id,
        type as any,
        targetId
      );

      const embed = new EmbedBuilder()
        .setTitle('✅ Whitelist Kaldırıldı')
        .setDescription(`**Tür:** ${type}\n**Hedef:** ${targetId}`)
        .setColor(0x00FF00)
        .setTimestamp();

      message.reply({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Error removing from whitelist:', error);
      const embed = new EmbedBuilder()
        .setTitle('❌ Hata')
        .setDescription('Whitelist kaldırılırken bir hata oluştu.')
        .setColor(0xFF0000)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
    }
  }

  private async handleList(message: Message): Promise<void> {
    try {
      const whitelist = await this.databaseManager.getWhitelist(message.guild!.id);
      
      if (whitelist.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle('📋 Whitelist')
          .setDescription('Bu sunucuda henüz whitelist kaydı bulunmuyor.')
          .setColor(0x808080)
          .setTimestamp();
        
        message.reply({ embeds: [embed] });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 Whitelist')
        .setDescription(`Toplam **${whitelist.length}** kayıt bulundu.`)
        .setColor(0x0099FF)
        .setTimestamp();


      const users = whitelist.filter(w => w.whitelist_type === 'user');
      const roles = whitelist.filter(w => w.whitelist_type === 'role');
      const actions = whitelist.filter(w => w.whitelist_type === 'action');

      if (users.length > 0) {
        const userList = users.map(w => 
          `• <@${w.target_id}> - ${w.reason || 'Sebep belirtilmemiş'}${w.expires_at ? ` (${new Date(w.expires_at).toLocaleDateString('tr-TR')})` : ''}`
        ).join('\n');
        embed.addFields({ name: '👤 Kullanıcılar', value: userList, inline: false });
      }

      if (roles.length > 0) {
        const roleList = roles.map(w => 
          `• <@&${w.target_id}> - ${w.reason || 'Sebep belirtilmemiş'}${w.expires_at ? ` (${new Date(w.expires_at).toLocaleDateString('tr-TR')})` : ''}`
        ).join('\n');
        embed.addFields({ name: '🎭 Roller', value: roleList, inline: false });
      }

      if (actions.length > 0) {
        const actionList = actions.map(w => 
          `• \`${w.target_id}\` - ${w.reason || 'Sebep belirtilmemiş'}${w.expires_at ? ` (${new Date(w.expires_at).toLocaleDateString('tr-TR')})` : ''}`
        ).join('\n');
        embed.addFields({ name: '⚡ Aksiyonlar', value: actionList, inline: false });
      }

      message.reply({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Error listing whitelist:', error);
      const embed = new EmbedBuilder()
        .setTitle('❌ Hata')
        .setDescription('Whitelist listelenirken bir hata oluştu.')
        .setColor(0xFF0000)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
    }
  }

  private async handleCheck(message: Message, args: string[]): Promise<void> {
    if (args.length < 3) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Eksik Parametre')
        .setDescription('Kullanım: `!whitelist check <type> <target>`\n\n**Örnek:**\n`!whitelist check user 123456789`')
        .setColor(0xFF6600)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
      return;
    }

    const type = args[1];
    const targetId = args[2];

    try {
      const isWhitelisted = await this.databaseManager.isWhitelisted(
        message.guild!.id,
        type as any,
        targetId
      );

      const embed = new EmbedBuilder()
        .setTitle(isWhitelisted ? '✅ Whitelist\'te' : '❌ Whitelist\'te Değil')
        .setDescription(`**Tür:** ${type}\n**Hedef:** ${targetId}\n**Durum:** ${isWhitelisted ? 'Whitelist\'te bulunuyor' : 'Whitelist\'te bulunmuyor'}`)
        .setColor(isWhitelisted ? 0x00FF00 : 0xFF0000)
        .setTimestamp();

      message.reply({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Error checking whitelist:', error);
      const embed = new EmbedBuilder()
        .setTitle('❌ Hata')
        .setDescription('Whitelist kontrolü yapılırken bir hata oluştu.')
        .setColor(0xFF0000)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
    }
  }

  private async handleDebug(message: Message, args: string[]): Promise<void> {
    if (args.length < 2) {
      const embed = new EmbedBuilder()
        .setTitle('❌ Eksik Parametre')
        .setDescription('Kullanım: `!whitelist debug <guildId>`\n\n**Örnek:**\n`!whitelist debug 123456789012345678`')
        .setColor(0xFF6600)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
      return;
    }

    const guildId = args[1];

    try {
      const whitelist = await this.databaseManager.getWhitelist(guildId);
      const embed = new EmbedBuilder()
        .setTitle('🔍 Whitelist Debug')
        .setDescription(`Sunucu ID: \`${guildId}\`\nToplam **${whitelist.length}** kayıt bulundu.`)
        .setColor(0x0099FF)
        .setTimestamp();


      const users = whitelist.filter(w => w.whitelist_type === 'user');
      const roles = whitelist.filter(w => w.whitelist_type === 'role');
      const actions = whitelist.filter(w => w.whitelist_type === 'action');

      if (users.length > 0) {
        const userList = users.map(w => 
          `• <@${w.target_id}> - ${w.reason || 'Sebep belirtilmemiş'}${w.expires_at ? ` (${new Date(w.expires_at).toLocaleDateString('tr-TR')})` : ''}`
        ).join('\n');
        embed.addFields({ name: '👤 Kullanıcılar', value: userList, inline: false });
      }

      if (roles.length > 0) {
        const roleList = roles.map(w => 
          `• <@&${w.target_id}> - ${w.reason || 'Sebep belirtilmemiş'}${w.expires_at ? ` (${new Date(w.expires_at).toLocaleDateString('tr-TR')})` : ''}`
        ).join('\n');
        embed.addFields({ name: '🎭 Roller', value: roleList, inline: false });
      }

      if (actions.length > 0) {
        const actionList = actions.map(w => 
          `• \`${w.target_id}\` - ${w.reason || 'Sebep belirtilmemiş'}${w.expires_at ? ` (${new Date(w.expires_at).toLocaleDateString('tr-TR')})` : ''}`
        ).join('\n');
        embed.addFields({ name: '⚡ Aksiyonlar', value: actionList, inline: false });
      }

      message.reply({ embeds: [embed] });
    } catch (error) {
      this.logger.error('Error debugging whitelist:', error);
      const embed = new EmbedBuilder()
        .setTitle('❌ Hata')
        .setDescription('Whitelist debug yapılırken bir hata oluştu.')
        .setColor(0xFF0000)
        .setTimestamp();
      
      message.reply({ embeds: [embed] });
    }
  }

  private async handleHelp(message: Message): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Whitelist Komutları')
      .setDescription('Bu komutlar sadece backup alınan sunucularda çalışır.')
      .addFields(
        { name: '📝 Ekleme', value: '`!whitelist add <type> <target> [reason] [expires]`\nKullanıcı, rol veya aksiyon ekler', inline: false },
        { name: '🗑️ Kaldırma', value: '`!whitelist remove <type> <target>`\nWhitelist\'ten kaldırır', inline: false },
        { name: '📋 Listeleme', value: '`!whitelist list`\nTüm whitelist kayıtlarını gösterir', inline: false },
        { name: '🔍 Kontrol', value: '`!whitelist check <type> <target>`\nWhitelist durumunu kontrol eder', inline: false },
        { name: '❓ Yardım', value: '`!whitelist help`\nBu mesajı gösterir', inline: false }
      )
      .addFields(
        { name: '🎯 Türler', value: '• `user` - Kullanıcı ID\n• `role` - Rol ID\n• `action` - Aksiyon (role_delete, vb.)', inline: false },
        { name: '⏰ Süre Formatları', value: '• `1h` - 1 saat\n• `24h` - 24 saat\n• `7d` - 7 gün\n• `30d` - 30 gün', inline: false }
      )
      .addFields(
        { name: '📝 Örnekler', value: '```\n!whitelist add user 123456789 "Admin" 24h\n!whitelist add role 987654321 "Moderator"\n!whitelist add action role_delete "Allowed"\n!whitelist remove user 123456789\n!whitelist check user 123456789```', inline: false }
      )
      .setColor(0x0099FF)
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }

  private parseExpiration(expiresStr: string): Date | null {
    const now = new Date();
    const match = expiresStr.match(/^(\d+)([hd])$/);
    
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'h':
        return new Date(now.getTime() + value * 60 * 60 * 1000);
      case 'd':
        return new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
      default:
        return null;
    }
  }
} 