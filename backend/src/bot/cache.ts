let version = 0;

export function bumpBotCache(): void {
  version += 1;
}

export function botCacheVersion(): number {
  return version;
}
