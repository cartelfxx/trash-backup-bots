import { Message } from 'discord.js';

export default {
  name: 'backup',
  description: 'Anında yedek alır',
  async execute(message: Message, args: string[], client: any) {
    if (
      message.member?.permissions.has('Administrator') ||
      message.guild?.ownerId === message.author.id
    ) {
      await message.reply('Yedek alınıyor, lütfen bekleyin...');
      try {
        await client.backupManager.createBackup(message.guild!.id, true);
        await message.reply('✅ Yedek başarıyla alındı!');
      } catch (err) {
        await message.reply('❌ Yedek alınırken hata oluştu!');
        client.logger?.error?.(String(err));
      }
    } else {
      await message.reply('Bu komutu kullanmak için yetkin yok.');
    }
  }
};