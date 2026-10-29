import type { BotRow, MessageDTO } from '../types';

export function shouldTrigger(bot: BotRow, message: MessageDTO): boolean {
  if (message.senderType !== 'user') {
    return false;
  }
  if (bot.triggerMode === 'all') {
    return true;
  }
  return message.content.includes(`@${bot.username}`);
}
