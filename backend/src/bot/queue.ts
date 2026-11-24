import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import type { BotRow, MessageDTO } from '../types';
import { onBotDebounce, publishBotDebounce } from './bus';

export interface BotJob {
  roomId: number;
  bot: BotRow;
  trigger: MessageDTO;
}

/**
 * Debounce state for one `roomId:botUserId`, held only by instances that
 * pushed a job for the key. `owner` is the instance that saw the latest
 * message: every bus event resets the timer and reassigns the owner, so
 * the fire times converge and only the owner runs its job.
 */
interface Pending {
  job: BotJob;
  owner: string;
  timer: NodeJS.Timeout;
}

export class BotQueue {
  /** Distinguishes this instance's jobs on the bus. */
  private readonly instanceId = randomUUID();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Pending>();
  private readonly offBus: () => void;

  constructor(private readonly run: (job: BotJob) => Promise<void>) {
    this.offBus = onBotDebounce((key, owner) => this.receiveBotDebounce(key, owner));
  }

  push(job: BotJob, mode: 'mention' | 'all'): void {
    const key = `${job.roomId}:${job.bot.userId}`;
    if (mode === 'all') {
      this.arm(key, job, this.instanceId);
      // Mirrors the push cluster-wide: every instance resets its timer and
      // records this one as owner, so rapid messages landing on different
      // instances coalesce into a single reply instead of one per instance.
      publishBotDebounce({ key, owner: this.instanceId });
      return;
    }
    this.chain(key, job);
  }

  /** Drops the room's pending debounced jobs so a stop silences queued turns too. */
  cancelRoom(roomId: number, botUserIds?: number[]): void {
    for (const [key, entry] of [...this.pending]) {
      if (this.matches(key, roomId, botUserIds)) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
      }
    }
  }

  /** Releases the bus listener; the queue must not be used afterwards. */
  close(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.offBus();
  }

  private arm(key: string, job: BotJob, owner: string): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => this.fire(key), config.botDebounceMs);
    this.pending.set(key, { job, owner, timer });
  }

  /**
   * A bus event sets the owner unconditionally: own reflections restore an
   * owner an older foreign event may have overwritten, and foreign owners
   * turn this instance into a non-firing mirror of the key.
   */
  private receiveBotDebounce(key: string, owner: string): void {
    const entry = this.pending.get(key);
    // Nothing pending here: this instance did not push, so it never fires.
    if (!entry) {
      return;
    }
    this.arm(key, entry.job, owner);
  }

  private fire(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    this.pending.delete(key);
    if (entry.owner === this.instanceId) {
      this.chain(key, entry.job);
    }
  }

  private matches(key: string, roomId: number, botUserIds?: number[]): boolean {
    const sep = key.indexOf(':');
    if (Number(key.slice(0, sep)) !== roomId) {
      return false;
    }
    return botUserIds ? botUserIds.includes(Number(key.slice(sep + 1))) : true;
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
