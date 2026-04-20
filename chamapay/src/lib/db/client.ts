import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

let _db: Database.Database | null = null;

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? "file:./var/chamapay.sqlite";
  const filePath = url.startsWith("file:") ? url.slice(5) : url;
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const p = resolveDbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  _db = db;
  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function tx<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const wrapped = db.transaction(fn);
  return wrapped(db);
}
