import Anthropic from '@anthropic-ai/sdk';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anthropicLlm, fakeLlm } from '../src/llm/llm';

// A stand-in for api.anthropic.com so the real SDK code path runs offline.
let server: Server;
let requests: { path: string; body: Record<string, unknown> }[] = [];
let respond: (res: import('node:http').ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      requests.push({ path: req.url!, body: JSON.parse(raw) });
      respond(res);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env.ANTHROPIC_BASE_URL;
  server.close();
});

const json = (status: number, body: unknown) => (res: import('node:http').ServerResponse) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

describe('anthropicLlm', () => {
  it('sends tools + system prompt and maps the response, including cache usage', async () => {
    requests = [];
    respond = json(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'sql_query', input: { sql: 'SELECT 1' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 812, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    });
    const res = await anthropicLlm('test-key', 'claude-haiku-5-5').complete([{ role: 'user', content: 'hi' }]);

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/messages');
    expect(requests[0].body).toMatchObject({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] });
    expect((requests[0].body.tools as { name: string }[]).map((t) => t.name)).toEqual(['http_fetch', 'sql_query', 'memory_search', 'memory_store']);
    expect(res).toEqual({
      model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'sql_query', input: { sql: 'SELECT 1' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 812, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
  });

  it('does not retry inside the SDK (Temporal owns retries)', async () => {
    requests = [];
    respond = json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const err = await anthropicLlm('test-key', 'claude-haiku-5-5').complete([{ role: 'user', content: 'hi' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect(err).toMatchObject({ status: 529 });
    expect(requests).toHaveLength(1);
  });
});

describe('fakeLlm', () => {
  const llm = fakeLlm('claude-haiku-5-5');

  it.each([
    ['Remember that deploys freeze on Fridays', 'memory_store'],
    ['Fetch https://example.com/ for me', 'http_fetch'],
    ['What is revenue by country?', 'sql_query'],
    ['recall what you know about deploys', 'memory_search'],
  ])('%s -> %s', async (prompt, tool) => {
    const res = await llm.complete([{ role: 'user', content: prompt }]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: tool });
  });

  it('answers from the tool result and reports estimated usage', async () => {
    const res = await llm.complete([
      { role: 'user', content: 'What is revenue?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'sql_query', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[{"revenue":42}]' }] },
    ]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.content).toEqual([{ type: 'text', text: 'Here is what I found: [{"revenue":42}]' }]);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });
});
