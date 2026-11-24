import { onBotCacheInvalidation, publishBotCacheInvalidation } from './bus';

let version = 0;

// A bump on any instance travels over the bot bus, so every replica drops its
// room bot list immediately instead of serving one for up to CACHE_TTL_MS.
onBotCacheInvalidation(() => {
  version += 1;
});

export function bumpBotCache(): void {
  version += 1;
  publishBotCacheInvalidation();
}

export function botCacheVersion(): number {
  return version;
}
