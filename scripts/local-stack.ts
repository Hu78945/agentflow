/**
 * Docker-free dev dependencies: Postgres+pgvector (PGlite, WASM, in-memory) behind a real
 * Postgres wire-protocol socket, and a Temporal dev server (CLI binary downloaded by the SDK on first use).
 * Data is lost when the process exits. Use docker compose for anything persistent.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { TestWorkflowEnvironment } from '@temporalio/testing';

export interface LocalStack {
  databaseUrl: string;
  temporalAddress: string;
  stop(): Promise<void>;
}

export async function startLocalStack({ pgPort = 54329, temporalPort = 7233 } = {}): Promise<LocalStack> {
  const pg = await PGlite.create({ extensions: { vector } });
  // PGlite is single-connection; the server queues queries from several clients onto it.
  const pgServer = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: pgPort, maxConnections: 16 });
  await pgServer.start();
  const temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', port: temporalPort, ui: true } });
  return {
    databaseUrl: `postgres://postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
    temporalAddress: temporal.address,
    async stop() {
      await temporal.teardown();
      await pgServer.stop();
      await pg.close();
    },
  };
}

if (require.main === module) {
  startLocalStack().then((stack) => {
    console.log(`DATABASE_URL=${stack.databaseUrl}\nTEMPORAL_ADDRESS=${stack.temporalAddress}\nTemporal UI: http://127.0.0.1:8233`);
    const shutdown = () => void stack.stop().finally(() => process.exit(0));
    process.on('SIGINT', shutdown).on('SIGTERM', shutdown);
  });
}
