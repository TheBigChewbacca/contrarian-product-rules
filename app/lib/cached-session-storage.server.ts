import {
  MissingSessionStorageError,
  MissingSessionTableError,
  type PrismaSessionStorageInterface,
} from "@shopify/shopify-app-session-storage-prisma";
import { TtlCache, parseTtlMs } from "./ttl-cache.server";

// Derived from the wrapped storage rather than imported from
// @shopify/shopify-api, which is only a transitive dependency here. This keeps
// the wrapper's types pinned to whatever version of
// @shopify/shopify-app-session-storage-prisma (9.0.x, SessionStorage 5.0.x) is
// actually installed.
type StoredSession = Awaited<
  ReturnType<PrismaSessionStorageInterface["findSessionsByShop"]>
>[number];

export const DEFAULT_SESSION_CACHE_TTL_MS = 30 * 60 * 1000;

// How often a broken storage may re-check the database. Requests in between
// fail fast instead of each starting another round of connection attempts.
const READINESS_RECHECK_INTERVAL_MS = 10 * 1000;

// Every request through `authenticate.admin`, `authenticate.webhook` and
// `unauthenticated.admin` loads a session, so each one was a Postgres round
// trip. With webhooks arriving about once a minute, Neon's compute never got
// the 5 minutes of idle time it needs to autosuspend.
//
// This caches successful reads only, per process, and drops everything on any
// write or delete so a token rotation or an uninstall is never served from a
// stale entry. An entry is additionally pinned to the session's own `expires`
// where it has one (the app runs with `expiringOfflineAccessTokens`), so a
// cached session can never outlive its access token.
export class CachedSessionStorage implements PrismaSessionStorageInterface {
  private readonly sessions: TtlCache<StoredSession>;
  private readonly shopSessions: TtlCache<StoredSession[]>;
  private readinessCheck: Promise<boolean> | undefined;
  private lastReadinessCheckAt = 0;

  constructor(
    private readonly storage: PrismaSessionStorageInterface,
    ttlMs: number = parseTtlMs(
      process.env.SESSION_CACHE_TTL_MS,
      DEFAULT_SESSION_CACHE_TTL_MS,
    ),
  ) {
    this.sessions = new TtlCache<StoredSession>(ttlMs);
    this.shopSessions = new TtlCache<StoredSession[]>(ttlMs);
  }

  async storeSession(session: StoredSession): Promise<boolean> {
    const stored = await this.withRecovery(() => this.storage.storeSession(session));
    // Invalidate unconditionally, including on a failed write: the cached copy
    // is no longer known to match the row.
    this.clear();
    return stored;
  }

  async loadSession(id: string): Promise<StoredSession | undefined> {
    const cached = this.sessions.get(id);
    if (cached) return cached.value;

    const session = await this.withRecovery(() => this.storage.loadSession(id));
    // A miss is not cached. Caching "no such session" would pin a negative
    // result across the OAuth callback that is about to create it.
    if (session) this.sessions.set(id, session, sessionExpiry(session));
    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    const deleted = await this.withRecovery(() => this.storage.deleteSession(id));
    this.clear();
    return deleted;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const deleted = await this.withRecovery(() => this.storage.deleteSessions(ids));
    this.clear();
    return deleted;
  }

  async findSessionsByShop(shop: string): Promise<StoredSession[]> {
    const cached = this.shopSessions.get(shop);
    if (cached) return cached.value;

    const sessions = await this.withRecovery(() => this.storage.findSessionsByShop(shop));
    // An empty list is not cached, for the same reason a missed load is not.
    if (sessions.length > 0) {
      this.shopSessions.set(shop, sessions, earliestExpiry(sessions));
      for (const session of sessions) {
        this.sessions.set(session.id, session, sessionExpiry(session));
      }
    }
    return sessions;
  }

  isReady(): Promise<boolean> {
    return this.storage.isReady();
  }

  clear(): void {
    this.sessions.clear();
    this.shopSessions.clear();
  }

  // PrismaSessionStorage checks the Session table once, when it is created. If
  // that check fails (on 2026-11-06 a Neon connection timed out while an
  // instance was starting), every later call fails with "session table does
  // not exist" until the process restarts, even after the database is back.
  // `isReady()` runs the check again and resets that state, so call it and
  // retry once.
  private async withRecovery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isNotReadyError(error)) throw error;
      if (!(await this.recheckReadiness())) throw error;
      return operation();
    }
  }

  private recheckReadiness(): Promise<boolean> {
    // Concurrent requests share one in-flight check.
    if (this.readinessCheck) return this.readinessCheck;
    if (Date.now() - this.lastReadinessCheckAt < READINESS_RECHECK_INTERVAL_MS) {
      return Promise.resolve(false);
    }
    this.lastReadinessCheckAt = Date.now();
    this.readinessCheck = this.storage
      .isReady()
      .catch(() => false)
      .finally(() => {
        this.readinessCheck = undefined;
      });
    return this.readinessCheck;
  }
}

function isNotReadyError(error: unknown): boolean {
  return (
    error instanceof MissingSessionTableError ||
    error instanceof MissingSessionStorageError
  );
}

function sessionExpiry(session: StoredSession): number | undefined {
  return session.expires ? session.expires.getTime() : undefined;
}

function earliestExpiry(sessions: StoredSession[]): number | undefined {
  const expiries = sessions
    .map((session) => sessionExpiry(session))
    .filter((expiry): expiry is number => expiry !== undefined);
  return expiries.length === sessions.length && expiries.length > 0
    ? Math.min(...expiries)
    : undefined;
}
