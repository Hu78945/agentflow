import Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db';
import type { Llm } from '../src/llm/llm';
import { createActivities } from '../src/temporal/activities';
import { pgliteDb } from './pglite';

let db: Db;
const logger = new DefaultLogger('ERROR'); // expected failures below would log as WARN
const activityEnv = (attempt = 1) => new MockActivityEnvironment({ attempt }, { logger });
const RUN = 'run-act';

beforeAll(async () => {
  db = await pgliteDb();
  await db.query("INSERT INTO runs (id, prompt, model) VALUES ($1, 'p', 'claude-haiku-5-5')", [RUN]);
});
afterAll(() => db.close());

const reply: Awaited<ReturnType<Llm['complete']>> = {
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: 'hello' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

describe('callLlm', () => {
  it('records tokens and cost for every attempt, including retries', async () => {
    const acts = createActivities({ db, llm: { complete: async () => reply }, allowedHosts: [] });
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
    await activityEnv(1).run(acts.callLlm, { runId: RUN, step: 1, messages });
    await activityEnv(2).run(acts.callLlm, { runId: RUN, step: 1, messages });

    const rows = await db.query<{ attempt: number; cost_usd: string }>(
      'SELECT attempt, cost_usd FROM llm_calls WHERE run_id = $1 ORDER BY attempt',
      [RUN],
    );
    // 2000 * $0.10/M + 400 * $0.50/M = $0.0004 per attempt
    expect(rows.map((r) => [r.attempt, Number(r.cost_usd)])).toEqual([[1, 0.0004], [2, 0.0004]]);
    const events = await db.query<{ type: string }>('SELECT type FROM run_events WHERE run_id = $1', [RUN]);
    expect(events.filter((e) => e.type === 'llm_response')).toHaveLength(2);
  });

  it('marks Anthropic 4xx errors non-retryable but lets 429/5xx retry', async () => {
    const failWith = (status: number) =>
      createActivities({
        db,
        allowedHosts: [],
        llm: { complete: async () => Promise.reject(Anthropic.APIError.generate(status, { error: { message: 'x' } }, 'x', new Headers())) },
      });
    const call = (status: number) =>
      activityEnv().run(failWith(status).callLlm, { runId: RUN, step: 9, messages: [] }).catch((e: unknown) => e);

    const bad = await call(400);
    expect(bad).toBeInstanceOf(ApplicationFailure);
    expect((bad as ApplicationFailure).nonRetryable).toBe(true);
    expect(await call(429)).toBeInstanceOf(Anthropic.RateLimitError);
    expect(await call(529)).toBeInstanceOf(Anthropic.APIError);
  });
});

describe('recordEvent', () => {
  it('appends an event once even when the activity is retried, and updates run status', async () => {
    const acts = createActivities({ db, llm: { complete: vi.fn() }, allowedHosts: [] });
    const event = { runId: RUN, type: 'run_completed', status: 'completed', output: 'done' };
    await activityEnv(1).run(acts.recordEvent, event);
    await activityEnv(2).run(acts.recordEvent, event); // same activity id, retried after a crash
    const rows = await db.query("SELECT 1 FROM run_events WHERE run_id = $1 AND type = 'run_completed'", [RUN]);
    const [run] = await db.query<{ status: string; output: string }>('SELECT status, output FROM runs WHERE id = $1', [RUN]);
    expect(rows).toHaveLength(1);
    expect(run).toEqual({ status: 'completed', output: 'done' });
  });
});

describe('executeTool idempotency', () => {
  it('executes a side-effecting tool once no matter how often the activity is retried', async () => {
    const acts = createActivities({ db, llm: { complete: vi.fn() }, allowedHosts: [] });
    const input = { runId: RUN, toolUseId: 'toolu_mem', name: 'memory_store', input: { text: 'remember the alamo' } };

    const results = await Promise.all([1, 2, 3].map(() => activityEnv().run(acts.executeTool, input)));
    results.push(await activityEnv().run(acts.executeTool, input));

    expect(new Set(results.map((r) => JSON.stringify(r)))).toEqual(new Set([JSON.stringify({ output: 'Stored.', isError: false })]));
    const [{ memories }] = await db.query<{ memories: number }>("SELECT count(*)::int AS memories FROM memories WHERE text = 'remember the alamo'");
    const [{ ledger }] = await db.query<{ ledger: number }>("SELECT count(*)::int AS ledger FROM tool_executions WHERE idempotency_key = 'run-act:toolu_mem'");
    expect({ memories, ledger }).toEqual({ memories: 1, ledger: 1 });
  });

  it('replays the recorded result instead of re-fetching', async () => {
    const fetch = vi.fn(async () => new Response('<p>v1</p>'));
    const acts = createActivities({ db, llm: { complete: vi.fn() }, allowedHosts: ['example.com'], fetch: fetch as never });
    const input = { runId: RUN, toolUseId: 'toolu_http', name: 'http_fetch', input: { url: 'https://example.com' } };
    const first = await activityEnv().run(acts.executeTool, input);
    fetch.mockImplementation(async () => new Response('<p>v2</p>'));
    const second = await activityEnv().run(acts.executeTool, input);
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
