import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db';
import { TOOLS } from '../src/llm/llm';
import { runTool, isHostAllowed, type ToolContext } from '../src/tools/tools';
import { pgliteDb } from './pglite';

let db: Db;
let ctx: ToolContext;

beforeAll(async () => {
  db = await pgliteDb();
  ctx = { db, idempotencyKey: 'run-1:toolu_1', allowedHosts: ['example.com'] };
});
afterAll(() => db.close());

describe('tool input validation (zod)', () => {
  it.each([
    ['sql_query', {}, /expected string/],
    ['sql_query', { sql: 'SELECT 1', extra: true }, /Unrecognized key/],
    ['http_fetch', { url: 'not a url' }, /Invalid URL/],
    ['http_fetch', { url: 'file:///etc/passwd' }, /Invalid URL/],
    ['memory_search', { query: 'x', k: 50 }, /Too big/],
    ['memory_store', { text: '' }, /Too small/],
  ])('%s rejects %j', async (name, input, message) => {
    const res = await runTool(name, input, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(message);
  });

  it('rejects unknown tools', async () => {
    expect(await runTool('rm_rf', {}, ctx)).toEqual({ output: 'Unknown tool "rm_rf"', isError: true });
  });

  it('exposes every tool to the model with a JSON schema', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['http_fetch', 'sql_query', 'memory_search', 'memory_store']);
    expect(TOOLS[1].input_schema).toMatchObject({ type: 'object', required: ['sql'], additionalProperties: false });
  });
});

describe('http_fetch', () => {
  it('matches the allowlist on exact host or subdomain only', () => {
    expect(isHostAllowed('example.com', ['example.com'])).toBe(true);
    expect(isHostAllowed('docs.example.com', ['example.com'])).toBe(true);
    expect(isHostAllowed('evilexample.com', ['example.com'])).toBe(false);
    expect(isHostAllowed('example.com.evil.io', ['example.com'])).toBe(false);
  });

  it('refuses non-allowlisted hosts without making a request', async () => {
    const fetch = vi.fn();
    const res = await runTool('http_fetch', { url: 'https://evil.io/x' }, { ...ctx, fetch });
    expect(res).toMatchObject({ isError: true, output: expect.stringContaining('not in the allowlist') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns page text with tags stripped and refuses redirects', async () => {
    const fetch = vi.fn(async () => new Response('<html><script>x()</script><h1>Hello</h1> <p>world</p></html>'));
    const res = await runTool('http_fetch', { url: 'https://example.com/' }, { ...ctx, fetch: fetch as never });
    expect(res).toEqual({ output: 'HTTP 200\nHello world', isError: false });
    expect(fetch).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({ redirect: 'error' }));
  });

  it('throws on upstream 5xx so Temporal retries it', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503 }));
    await expect(runTool('http_fetch', { url: 'https://example.com/' }, { ...ctx, fetch: fetch as never })).rejects.toThrow('Upstream 503');
  });
});

describe('sql_query', () => {
  it('runs SELECTs against the demo dataset', async () => {
    const res = await runTool('sql_query', { sql: 'SELECT name FROM demo.customers WHERE country = $$UK$$;' }, ctx);
    expect(res).toEqual({ output: '[{"name":"Umbrella"}]', isError: false });
  });

  it.each([
    ['DELETE FROM demo.orders', /Only SELECT/],
    ['SELECT 1; DROP TABLE demo.orders', /SQL error/],
    ['WITH d AS (DELETE FROM demo.orders RETURNING *) SELECT * FROM d', /SQL error/],
    ['SELECT nope FROM demo.orders', /SQL error/],
  ])('blocks %s', async (sql, message) => {
    const res = await runTool('sql_query', { sql }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(message);
    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM demo.orders');
    expect(n).toBe(6);
  });

  it('caps result size at 50 rows', async () => {
    const res = await runTool('sql_query', { sql: 'SELECT generate_series(1, 500) AS n' }, ctx);
    expect(JSON.parse(res.output)).toHaveLength(50);
  });
});

describe('memory', () => {
  it('stores idempotently and finds the most similar note first', async () => {
    await runTool('memory_store', { text: 'The billing service runs on Postgres 16' }, { ...ctx, idempotencyKey: 'k1' });
    await runTool('memory_store', { text: 'The billing service runs on Postgres 16' }, { ...ctx, idempotencyKey: 'k1' });
    await runTool('memory_store', { text: 'Lunch is at noon on Fridays' }, { ...ctx, idempotencyKey: 'k2' });
    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM memories');
    expect(n).toBe(2);

    const res = await runTool('memory_search', { query: 'which database does billing use', k: 2 }, ctx);
    const hits = JSON.parse(res.output) as { text: string; score: number }[];
    expect(hits[0].text).toContain('billing');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });
});
