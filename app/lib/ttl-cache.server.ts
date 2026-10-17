// Process-local, time-bounded cache.
//
// Cloud Run runs many short-lived instances, so this is a per-instance cache,
// not a shared one: a cold instance simply does the real read. That is the
// whole point — it removes the *repeated* reads a single instance performs
// while it is warm (Neon bills compute by uptime, and a steady trickle of
// webhooks was keeping the database from ever autosuspending), without
// introducing a second source of truth that could go stale across instances.
//
// Entries are never served past their expiry, and callers can pin an entry to
// expire earlier than the default TTL (see `expiresAt`) when the cached value
// has its own lifetime, such as an access token.
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): { value: T } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Wrapped so callers can distinguish "cached undefined/null" from "miss".
    return { value: entry.value };
  }

  // `expiresAt` caps the entry's lifetime; the effective expiry is the earlier
  // of it and now + ttlMs. An already-elapsed cap means the value is not
  // cached at all.
  set(key: string, value: T, expiresAt?: number): void {
    const now = Date.now();
    const deadline = Math.min(now + this.ttlMs, expiresAt ?? Number.POSITIVE_INFINITY);
    if (deadline <= now) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { value, expiresAt: deadline });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export function parseTtlMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}
