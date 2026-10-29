import { config } from '../config';
import { pool, type RowDataPacket } from '../db';
import type { BotRow } from '../types';
import type { ChatMessage } from './provider';

export async function buildContext(
  roomId: number,
  bot: BotRow,
  excludeMessageId?: number,
): Promise<ChatMessage[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.sender_id, m.content, u.display_name
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = ? AND m.status = 'done' AND m.deleted_at IS NULL AND m.id <> ?
     ORDER BY m.seq DESC
     LIMIT ?`,
    [roomId, excludeMessageId ?? 0, config.botContextMessages],
  );

  const ordered = rows.reverse();
  const messages: ChatMessage[] = [];
  if (bot.systemPrompt) {
    messages.push({ role: 'system', content: bot.systemPrompt });
  }
  for (const row of ordered) {
    const isSelf = Number(row.sender_id) === bot.userId;
    messages.push({
      role: isSelf ? 'assistant' : 'user',
      content: isSelf ? String(row.content) : `${String(row.display_name)}: ${String(row.content)}`,
    });
  }

  let total = messages.reduce((sum, message) => sum + message.content.length, 0);
  let start = messages[0]?.role === 'system' ? 1 : 0;
  while (total > config.botContextMaxChars && start < messages.length - 1) {
    total -= messages[start].content.length;
    start += 1;
  }
  const kept =
    messages[0]?.role === 'system'
      ? [messages[0], ...messages.slice(start)]
      : messages.slice(start);

  const last = kept[kept.length - 1];
  const cap = config.botContextMaxChars - 200;
  if (last && last.content.length > cap) {
    last.content = `${last.content.slice(0, cap)}…`;
  }
  return kept;
}
