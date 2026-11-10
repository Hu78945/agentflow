/**
 * Measures two things against a real Temporal dev server, a real worker process and Postgres (PGlite over the wire):
 *   A. orchestration overhead: end-to-end latency of N runs (2 fake-LLM steps + 1 memory_search tool call each)
 *   B. crash recovery: SIGKILL the only worker while M slow tool calls are in flight, start a fresh worker,
 *      and check every run still completes with exactly one recorded result per tool call.
 * Usage: npm run bench   (env: BENCH_RUNS, BENCH_CRASH_RUNS)
 */
import { Client, Connection } from '@temporalio/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { RunsService } from '../src/api/runs.service';
import { loadConfig } from '../src/config';
import { migrate, pgDb } from '../src/db';
import { startLocalStack } from '../scripts/local-stack';

const RUNS = Number(process.env.BENCH_RUNS ?? 100);
const CRASH_RUNS = Number(process.env.BENCH_CRASH_RUNS ?? 20);
// Long enough that every run is inside its tool call when the worker is killed.
const TOOL_DELAY_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function main() {
  const stack = await startLocalStack({ pgPort: 54339, temporalPort: 7243 });

  // A deliberately slow upstream for http_fetch; counts how often each URL is actually hit.
  const hits = new Map<string, number>();
  const slow = createServer((req, res) => {
    hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
    setTimeout(() => res.end(`<p>payload for ${req.url}</p>`), TOOL_DELAY_MS);
  }).listen(0, '127.0.0.1');
  await once(slow, 'listening');
  const slowPort = (slow.address() as AddressInfo).port;

  const env = {
    ...process.env,
    DATABASE_URL: stack.databaseUrl,
    TEMPORAL_ADDRESS: stack.temporalAddress,
    HTTP_FETCH_ALLOWED_HOSTS: '127.0.0.1',
    ANTHROPIC_API_KEY: '', // always the deterministic fake LLM
  };
  const config = loadConfig(env);
  const db = pgDb(config.databaseUrl);
  await migrate(db);
  const temporal = new Client({ connection: await Connection.connect({ address: config.temporalAddress }) });
  const runs = new RunsService(db, config, temporal);

  async function startWorker(): Promise<ChildProcess> {
    const child = spawn(process.execPath, [join(__dirname, '../src/worker.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    await new Promise<void>((resolve, reject) => {
      const onData = (d: Buffer) => (log += d) && log.includes("state: 'RUNNING'") && resolve();
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('exit', (code) => reject(new Error(`worker exited (${code}):\n${log}`)));
    });
    return child;
  }

  async function runAll(prompts: string[]) {
    return Promise.all(
      prompts.map(async (prompt) => {
        const t0 = performance.now();
        const { id } = await runs.create(prompt);
        const result = await temporal.workflow.getHandle(id).result();
        return { id, result, ms: performance.now() - t0 };
      }),
    );
  }

  let worker = await startWorker();

  // ---- A: orchestration overhead ------------------------------------------------------------
  await runAll(['recall warmup']); // first run pays for workflow bundle/cache warmup
  const sequential: number[] = [];
  for (let i = 0; i < 20; i++) sequential.push((await runAll([`recall solo ${i}`]))[0].ms);
  sequential.sort((x, y) => x - y);
  const tA = performance.now();
  const a = await runAll(Array.from({ length: RUNS }, (_, i) => `recall note ${i}`));
  const wallA = performance.now() - tA;
  const lat = a.map((r) => r.ms).sort((x, y) => x - y);

  // ---- B: crash recovery ------------------------------------------------------------------------
  const crash = runAll(Array.from({ length: CRASH_RUNS }, (_, i) => `fetch http://127.0.0.1:${slowPort}/item/${i}`));
  while ([...hits.values()].length < CRASH_RUNS) await sleep(20); // every tool call is now mid-flight
  const inFlightAtKill = [...hits.values()].reduce((x, y) => x + y, 0);
  worker.kill('SIGKILL');
  const killedAt = performance.now();
  const killedAtWall = Date.now();
  worker = await startWorker();
  const b = await crash;
  const recoveryMs = performance.now() - killedAt;

  const ledger = await db.query<{ key: string; n: number }>(
    'SELECT idempotency_key AS key, count(*)::int AS n FROM tool_executions WHERE run_id = ANY($1) GROUP BY 1',
    [b.map((r) => r.id)],
  );
  const [toolTimes] = await db.query<{ first: Date; last: Date }>(
    "SELECT min(created_at) AS first, max(created_at) AS last FROM run_events WHERE run_id = ANY($1) AND type = 'tool_result'",
    [b.map((r) => r.id)],
  );
  const events = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM run_events WHERE run_id = ANY($1) AND type = 'run_completed' GROUP BY run_id",
    [b.map((r) => r.id)],
  );
  const statuses = await db.query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM runs WHERE id = ANY($1) GROUP BY 1',
    [b.map((r) => r.id)],
  );

  const [{ version }] = await db.query<{ version: string }>('SELECT version()');
  const report = {
    environment: `${process.platform}/${process.arch}, node ${process.version}, Temporal dev server, PGlite (${version.split(' on ')[0]}) over pg wire, fake LLM`,
    A0_sequential: {
      runs: sequential.length,
      latency_ms: { p50: Math.round(pct(sequential, 50)), p95: Math.round(pct(sequential, 95)) },
    },
    A_orchestration: {
      runs: RUNS,
      started_concurrently: true,
      completed: a.filter((r) => r.result.status === 'completed').length,
      latency_ms: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), max: Math.round(lat.at(-1)!) },
      throughput_runs_per_s: Number((RUNS / (wallA / 1000)).toFixed(1)),
    },
    B_crash_recovery: {
      runs: CRASH_RUNS,
      tool_delay_ms: TOOL_DELAY_MS,
      completed: b.filter((r) => r.result.status === 'completed').length,
      db_statuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
      kill_to_first_retried_tool_result_ms: new Date(toolTimes.first).getTime() - killedAtWall,
      kill_to_last_retried_tool_result_ms: new Date(toolTimes.last).getTime() - killedAtWall,
      kill_to_all_completed_ms: Math.round(recoveryMs),
      tool_calls_in_flight_at_kill: inFlightAtKill,
      upstream_requests: [...hits.values()].reduce((x, y) => x + y, 0),
      recorded_tool_results: ledger.length,
      duplicate_recorded_results: ledger.filter((l) => l.n > 1).length,
      duplicate_terminal_events: events.filter((e) => e.n > 1).length,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  worker.kill('SIGTERM');
  await once(worker, 'exit');
  slow.close();
  await temporal.connection.close();
  await db.close();
  await stack.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
