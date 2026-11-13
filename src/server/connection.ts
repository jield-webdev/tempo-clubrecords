import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { databaseTls } from './database-tls.ts';
import { dirname, resolve } from 'node:path';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';

export type Row = Record<string, any>;
export type Input = SQLInputValue;

/** One transaction owns its connection until commit/rollback. SQLite operations are queued
 * so unrelated requests cannot accidentally join an async import's transaction. */
export class Db {
  private context = new AsyncLocalStorage<PoolConnection | DatabaseSync>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dialect: 'sqlite' | 'mysql',
    private source: DatabaseSync | Pool,
  ) {}
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => {});
    return next;
  }
  private async execute(sql: string, args: Input[] = []): Promise<any> {
    if (this.dialect === 'mysql') {
      // Quote the reserved settings column; retain strict errors on invalid inserts.
      sql = sql.replace(/(?<![`\w])(key|round)(?![`\w])/g, '`$1`');
      if (/INSERT OR IGNORE/i.test(sql)) {
        sql = sql.replace(/INSERT OR IGNORE/i, 'INSERT') + ' ON DUPLICATE KEY UPDATE id=id';
        // Tables without an id use a primary-key column as a no-op assignment.
        const table = sql.match(/INSERT INTO (\w+)/i)?.[1];
        const column = (
          {
            settings: '`key`',
            swimmer_identifiers: 'scheme',
            result_categories: 'result_id',
          } as Record<string, string>
        )[table || ''];
        if (column) sql = sql.replace(/id=id$/, `${column}=${column}`);
      }
      const connection = this.context.getStore() as PoolConnection | undefined;
      const client = connection || (this.source as Pool);
      const [rows] = args.length
        ? await client.execute(
            sql,
            args.map((v) =>
              ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v,
            ),
          )
        : await client.query(sql);
      return rows;
    }
    const action = async () => {
      const db = this.source as DatabaseSync;
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) return db.prepare(sql).all(...args);
      return db.prepare(sql).run(...args);
    };
    return this.context.getStore() ? action() : this.exclusive(action);
  }
  prepare(sql: string) {
    return {
      all: async (...args: Input[]): Promise<Row[]> => this.execute(sql, args),
      get: async (...args: Input[]): Promise<Row | undefined> => (await this.execute(sql, args))[0],
      run: async (...args: Input[]) => {
        const result = (await this.execute(sql, args)) as ResultSetHeader & {
          lastInsertRowid?: number | bigint;
        };
        return {
          lastInsertRowid: Number(result.lastInsertRowid ?? result.insertId),
          changes: Number(result.affectedRows ?? (result as any).changes),
        };
      },
    };
  }
  async exec(sql: string): Promise<void> {
    if (this.dialect === 'sqlite') {
      const action = async () => {
        (this.source as DatabaseSync).exec(sql);
      };
      await (this.context.getStore() ? action() : this.exclusive(action));
    } else {
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await this.execute(statement);
    }
  }
  async transaction<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) throw new Error('Nested transactions are not supported.');
    const run = async () => {
      const connection =
        this.dialect === 'mysql'
          ? await (this.source as Pool).getConnection()
          : (this.source as DatabaseSync);
      return this.context.run(connection, async () => {
        let locked = false;
        try {
          if (this.dialect === 'mysql') {
            const row = await this.prepare(
              "SELECT GET_LOCK(SHA2(CONCAT('tempo:',DATABASE()),256),30) acquired",
            ).get();
            if (row?.acquired !== 1) throw new Error('Database is busy; retry the operation.');
            locked = true;
          }
          await this.exec(this.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN IMMEDIATE');
          try {
            const value = await action();
            await this.prepare("UPDATE settings SET value=value+1 WHERE key='data_revision'").run();
            await this.exec('COMMIT');
            return value;
          } catch (error) {
            await this.exec('ROLLBACK');
            throw error;
          }
        } finally {
          if (this.dialect === 'mysql') {
            try {
              if (locked)
                await this.prepare(
                  "SELECT RELEASE_LOCK(SHA2(CONCAT('tempo:',DATABASE()),256))",
                ).get();
            } finally {
              (connection as PoolConnection).release();
            }
          }
        }
      });
    };
    return this.dialect === 'sqlite' ? this.exclusive(run) : run();
  }
  async version(): Promise<string> {
    const row = await this.prepare(
      this.dialect === 'sqlite'
        ? 'PRAGMA data_version'
        : "SELECT value FROM settings WHERE key='data_revision'",
    ).get();
    return String(row?.data_version ?? row?.value);
  }
  async close(): Promise<void> {
    if (this.dialect === 'mysql') await (this.source as Pool).end();
    else await this.exclusive(async () => (this.source as DatabaseSync).close());
  }
}

export function connect(location: string): Db {
  if (/^mysql:\/\//.test(location)) {
    const url = new URL(location);
    if (!url.hostname || !url.pathname.slice(1))
      throw new Error('DATABASE_URL must include a MySQL host and database.');
    const pool = mysql.createPool({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: databaseTls(url.hostname),
      connectionLimit: 10,
      connectTimeout: 10000,
      enableKeepAlive: true,
      charset: 'utf8mb4_bin',
      timezone: 'Z',
      supportBigNumbers: true,
    });
    pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'");
    });
    return new Db('mysql', pool);
  }
  if (location.includes('://')) throw new Error('Unsupported DATABASE_URL; use mysql://.');
  if (location !== ':memory:') mkdirSync(dirname(resolve(location)), { recursive: true });
  return new Db('sqlite', new DatabaseSync(location));
}
