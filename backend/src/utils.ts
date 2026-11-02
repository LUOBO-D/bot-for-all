const BYTES_PER_MIB = 1024 * 1024;

/** Human-readable MiB with one decimal, for quota messages only. */
export function formatMiB(bytes: number): string {
  return (bytes / BYTES_PER_MIB).toFixed(1);
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value ?? '');
}

export function isDuplicateError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  );
}
