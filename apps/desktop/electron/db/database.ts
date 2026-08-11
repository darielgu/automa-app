import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations.js";

export type Db = DatabaseSync;

/**
 * `node:sqlite` is built into the Node runtime that Electron ships (verified:
 * Electron 36.9.5 / Node 22.19). Using it rather than better-sqlite3 means the
 * app has no native modules at all, so there is no ABI rebuild step and no
 * per-architecture binary to get wrong in a two-arch DMG.
 */
export function openDatabase(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath);

  // WAL lets the UI read while a sync writes. NORMAL is the right durability
  // trade for a cache we can always rebuild from the feed.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  runMigrations(db);

  // The profile and resume rows can contain a home address and phone number.
  // Keep the file readable only by its owner.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal: a filesystem that does not support modes is still usable.
  }

  return db;
}

export function runMigrations(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  let version = Number(row?.user_version ?? 0);

  for (let target = version; target < MIGRATIONS.length; target += 1) {
    const sql = MIGRATIONS[target];
    if (!sql) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      // PRAGMA does not accept a bound parameter, and `target` is a loop index
      // over a constant array, so interpolation here cannot carry user input.
      db.exec(`PRAGMA user_version = ${target + 1}`);
      db.exec("COMMIT");
      version = target + 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${target + 1} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return version;
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE so concurrent writers queue rather than
 * collide. Nested calls reuse the open transaction.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const alreadyOpen = db.isTransaction;
  if (!alreadyOpen) db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (!alreadyOpen) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (!alreadyOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the useful one; a rollback failure would mask it.
      }
    }
    throw error;
  }
}

/**
 * `DatabaseSync` returns null-prototype objects. Anything that later does a
 * prototype check on a row (deep equality in tests, structured clone across
 * IPC) misbehaves on those, so give rows a normal prototype at the boundary.
 */
export function plain<T extends object>(row: T | undefined): T | undefined {
  return row ? ({ ...row } as T) : undefined;
}

export function plainAll<T extends object>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }) as T);
}

export function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
