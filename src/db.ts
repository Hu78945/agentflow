import { Pool } from 'pg';
import { SCHEMA } from './schema';

export type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** The whole data layer: parameterized queries, a read-only transaction, and raw multi-statement exec. */
export interface Db {
  query: Query;
  /** Runs `fn` in a READ ONLY transaction with a 2s statement timeout; always rolled back. */
  readOnly<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function pgDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 10 });
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    async readOnly(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '2s'");
        return await fn(async (sql, params) => (await client.query(sql, params)).rows);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}
