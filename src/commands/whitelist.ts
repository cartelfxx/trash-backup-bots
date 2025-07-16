import { Message, PermissionFlagsBits } from 'discord.js';

export default {
  name: 'whitelist',
  description: 'Whitelist yönetimi',
  async execute(message: Message, args: string[], client: any) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild) && message.guild!.ownerId !== message.author.id) {
      await message.reply('Bu komutu kullanmak için "Sunucuyu Yönet" yetkisine sahip olmalısınız.');
      return;
    }
    if (!args[0] || !['ekle', 'çıkar'].includes(args[0])) {
      await message.reply('Kullanım: !whitelist ekle <userId> veya !whitelist çıkar <userId>');
      return;
    }
    const action = args[0];
    const userId = args[1];
    if (!userId) {
      await message.reply('Lütfen bir kullanıcı ID girin.');
      return;
    }
    try {
      if (action === 'ekle') {
        await client.databaseManager.addToWhitelist(
          message.guild!.id,
          'user',
          userId,
          message.author.id
        );
        await message.reply(`<@${userId}> başarıyla whitelist'e eklendi.`);
      } else if (action === 'çıkar') {
        await client.databaseManager.removeFromWhitelist(
          message.guild!.id,
          'user',
          userId
        );
        await message.reply(`<@${userId}> whitelist'ten çıkarıldı.`);
      }
    } catch (err) {
      await message.reply('Whitelist işlemi sırasında hata oluştu.');
      client.logger?.error?.(String(err));
    }
  }
}; 
