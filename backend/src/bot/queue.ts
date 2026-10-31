import { config } from '../config';
import { logger } from '../logger';
import type { BotRow, MessageDTO } from '../types';

export interface BotJob {
  roomId: number;
  bot: BotRow;
  trigger: MessageDTO;
}

export class BotQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly latest = new Map<string, BotJob>();

  constructor(private readonly run: (job: BotJob) => Promise<void>) {}

  push(job: BotJob, mode: 'mention' | 'all'): void {
    const key = `${job.roomId}:${job.bot.userId}`;
    if (mode === 'all') {
      this.latest.set(key, job);
      const existing = this.timers.get(key);
      clearTimeout(existing);
      const timer = setTimeout(() => {
        this.timers.delete(key);
        const latestJob = this.latest.get(key);
        this.latest.delete(key);
        if (latestJob) {
          this.chain(key, latestJob);
        }
      }, config.botDebounceMs);
      this.timers.set(key, timer);
      return;
    }
    this.chain(key, job);
  }

  private chain(key: string, job: BotJob): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.run(job))
      .catch((error) => {
        logger.error({ err: error, key }, 'bot job failed');
      });
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    });
  }
}
