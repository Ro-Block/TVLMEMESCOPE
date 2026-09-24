import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS trades (
      chain TEXT NOT NULL, pool TEXT NOT NULL, tx TEXT NOT NULL, wallet TEXT NOT NULL,
      kind TEXT NOT NULL, token TEXT NOT NULL, qty REAL NOT NULL, usd REAL NOT NULL, ts INTEGER NOT NULL,
      PRIMARY KEY (chain, tx, pool, wallet, kind)
    );
    CREATE INDEX IF NOT EXISTS trades_wallet ON trades (wallet, chain, token, ts);
    CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);
    CREATE INDEX IF NOT EXISTS trades_pool ON trades (chain, pool, ts);
    CREATE TABLE IF NOT EXISTS pools (
      id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, token TEXT NOT NULL,
      symbol TEXT NOT NULL, created_at INTEGER NOT NULL, price_usd REAL NOT NULL, trending INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pools_created ON pools (chain, created_at);
    CREATE INDEX IF NOT EXISTS pools_addr ON pools (chain, address);
    CREATE TABLE IF NOT EXISTS seeds (
      wallet TEXT NOT NULL, chain TEXT NOT NULL, source TEXT NOT NULL, label TEXT, json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, chain, source)
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      wallet TEXT NOT NULL, chain TEXT NOT NULL, label TEXT, added_at INTEGER NOT NULL,
      PRIMARY KEY (wallet, chain)
    );
    CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (ts);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  `);
  // Migrations for databases created by earlier versions.
  const cols = (db.prepare('PRAGMA table_info(trades)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('block')) db.exec('ALTER TABLE trades ADD COLUMN block INTEGER');
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
