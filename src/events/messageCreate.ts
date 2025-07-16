import { Message } from 'discord.js';

const prefix = '!';

export default {
  name: 'messageCreate',
  async execute(message: Message, client: any) {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift()?.toLowerCase();

    const command = client.commands.get(commandName);
    if (!command) return;

    try {
      await command.execute(message, args, client);
    } catch (error) {
      await message.reply('Komut çalıştırılırken bir hata oluştu.');
      client.logger?.error?.(String(error));
    }
  }
}; 