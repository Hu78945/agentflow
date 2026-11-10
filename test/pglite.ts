import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { migrate, type Db } from '../src/db';

/** The same Db contract as production, backed by in-process WASM Postgres + pgvector, so tests need no server. */
export async function pgliteDb(): Promise<Db> {
  const pg = await PGlite.create({ extensions: { vector } });
  const query: Db['query'] = async (sql, params) => (await pg.query(sql, params)).rows as never;
  const db: Db = {
    query,
    readOnly: (fn) =>
      pg.transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        const result = await fn(async (sql, params) => (await tx.query(sql, params)).rows as never);
        await tx.rollback();
        return result;
      }),
    exec: async (sql) => void (await pg.exec(sql)),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}
