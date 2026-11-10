import type Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure, CancelledFailure, WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundle } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmResponse } from '../src/llm/llm';
import type { Activities, ExecuteToolInput, RecordEventInput } from '../src/temporal/activities';
import { agentRun, approvalSignal, stateQuery, type AgentRunInput } from '../src/temporal/workflows';

// Expected activity failures (retry tests) would otherwise flood the output.
const silentLogger = new DefaultLogger('ERROR');
Runtime.install({ logger: silentLogger, telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } } });

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

beforeAll(async () => {
  [env, workflowBundle] = await Promise.all([
    TestWorkflowEnvironment.createTimeSkipping(),
    bundleWorkflowCode({ workflowsPath: join(__dirname, '../src/temporal/workflows.ts'), logger: silentLogger }),
  ]);
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const text = (t: string): LlmResponse => ({ model: 'claude-haiku-5-5', content: [{ type: 'text', text: t }], stopReason: 'end_turn', usage });
const toolUse = (name: string, input: unknown, id = `toolu_${name}`): LlmResponse => ({
  model: 'claude-haiku-5-5',
  content: [{ type: 'tool_use', id, name, input }],
  stopReason: 'tool_use',
  usage,
});

/** In-memory activities: `script` returns the LLM reply for each call; `tool` handles tool calls. */
function fakeActivities(opts: {
  script: (messages: Anthropic.MessageParam[], call: number) => LlmResponse;
  tool?: (input: ExecuteToolInput) => { output: string; isError: boolean };
}) {
  const calls = { llm: [] as Anthropic.MessageParam[][], tools: [] as ExecuteToolInput[], events: [] as RecordEventInput[] };
  const activities: Activities = {
    async callLlm({ messages }) {
      calls.llm.push(messages);
      return opts.script(messages, calls.llm.length);
    },
    async executeTool(input) {
      calls.tools.push(input);
      return (opts.tool ?? (() => ({ output: 'ok', isError: false })))(input);
    },
    async recordEvent(e) {
      calls.events.push(e);
    },
  };
  return { activities, calls };
}

async function run(activities: Activities, input: Partial<AgentRunInput>, during?: (id: string) => Promise<void>) {
  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities,
  });
  return worker.runUntil(async () => {
    const runId = randomUUID();
    const handle = await env.client.workflow.start(agentRun, { taskQueue, workflowId: runId, args: [{ runId, prompt: 'hi', ...input }] });
    await during?.(runId);
    return handle.result();
  });
}

/** Polls the workflow's state query until a tool call is waiting for approval. */
async function waitForApproval(runId: string) {
  const handle = env.client.workflow.getHandle(runId);
  for (let i = 0; i < 100; i++) {
    const state = await handle.query(stateQuery);
    if (state.pendingApproval) return state.pendingApproval;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('workflow never asked for approval');
}

const lastToolResult = (messages: Anthropic.MessageParam[]) => {
  const content = messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  return content[0];
};

describe('agentRun workflow', () => {
  it('runs LLM -> tool -> LLM and feeds the tool result back', async () => {
    const { activities, calls } = fakeActivities({
      script: (_m, n) => (n === 1 ? toolUse('sql_query', { sql: 'SELECT 1' }) : text('one')),
      tool: () => ({ output: '[{"?column?":1}]', isError: false }),
    });
    const result = await run(activities, {});
    expect(result).toEqual({ status: 'completed', output: 'one', steps: 2 });
    expect(calls.tools).toHaveLength(1);
    expect(calls.tools[0]).toMatchObject({ name: 'sql_query', toolUseId: 'toolu_sql_query', input: { sql: 'SELECT 1' } });
    expect(lastToolResult(calls.llm[1])).toMatchObject({ tool_use_id: 'toolu_sql_query', content: '[{"?column?":1}]', is_error: false });
    expect(calls.events.map((e) => e.status).filter(Boolean)).toEqual(['running', 'completed']);
  });

  it('retries a failing LLM call with backoff and then succeeds', async () => {
    let attempts = 0;
    const { activities } = fakeActivities({ script: () => text('done') });
    const flaky: Activities = {
      ...activities,
      async callLlm(input) {
        if (++attempts < 3) throw new Error('529 overloaded');
        return activities.callLlm(input);
      },
    };
    const result = await run(flaky, {});
    expect(result.status).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable LLM failures', async () => {
    let attempts = 0;
    const { activities, calls } = fakeActivities({ script: () => text('unused') });
    const badRequest: Activities = {
      ...activities,
      async callLlm() {
        attempts++;
        throw ApplicationFailure.nonRetryable('invalid model', 'AnthropicHttp400');
      },
    };
    await expect(run(badRequest, {})).rejects.toBeInstanceOf(WorkflowFailedError);
    expect(attempts).toBe(1);
    expect(calls.events.at(-1)).toMatchObject({ type: 'run_failed', status: 'failed' });
  });

  it('turns a tool that keeps failing into an error result for the model', async () => {
    const { activities, calls } = fakeActivities({
      script: (_m, n) => (n === 1 ? toolUse('http_fetch', { url: 'https://example.com' }) : text('sorry')),
      tool: () => {
        throw new Error('connection reset');
      },
    });
    const result = await run(activities, {});
    expect(result.status).toBe('completed');
    expect(calls.tools).toHaveLength(3); // maximumAttempts
    expect(lastToolResult(calls.llm[1])).toMatchObject({ is_error: true, content: expect.stringContaining('connection reset') });
  });

  it('pauses a dangerous tool until approved, then executes it', async () => {
    const { activities, calls } = fakeActivities({
      script: (_m, n) => (n === 1 ? toolUse('memory_store', { text: 'note' }) : text('saved')),
    });
    const result = await run(activities, {}, async (runId) => {
      const pending = await waitForApproval(runId);
      expect(pending).toEqual({ toolUseId: 'toolu_memory_store', name: 'memory_store', input: { text: 'note' } });
      expect(calls.tools).toHaveLength(0); // nothing executes before approval
      await env.client.workflow.getHandle(runId).signal(approvalSignal, { approved: true });
    });
    expect(result.output).toBe('saved');
    expect(calls.tools).toHaveLength(1);
    expect(calls.events.map((e) => e.status).filter(Boolean)).toEqual(['running', 'awaiting_approval', 'running', 'completed']);
  });

  it('skips a rejected tool and tells the model why', async () => {
    const { activities, calls } = fakeActivities({
      script: (_m, n) => (n === 1 ? toolUse('memory_store', { text: 'note' }) : text('ok, not saved')),
    });
    await run(activities, {}, async (runId) => {
      await waitForApproval(runId);
      await env.client.workflow.getHandle(runId).signal(approvalSignal, { approved: false, reason: 'contains PII' });
    });
    expect(calls.tools).toHaveLength(0);
    expect(lastToolResult(calls.llm[1])).toMatchObject({ is_error: true, content: 'A human rejected this call: contains PII' });
  });

  it('treats an approval that never comes as a rejection once the timeout passes (time-skipped)', async () => {
    const { activities, calls } = fakeActivities({
      script: (_m, n) => (n === 1 ? toolUse('memory_store', { text: 'note' }) : text('gave up')),
    });
    const result = await run(activities, { approvalTimeout: '7 days' });
    expect(result.output).toBe('gave up');
    expect(calls.tools).toHaveLength(0);
    expect(lastToolResult(calls.llm[1])).toMatchObject({ is_error: true, content: 'Approval timed out.' });
  });

  it('can be cancelled while waiting for approval and records the cancellation', async () => {
    const { activities, calls } = fakeActivities({ script: () => toolUse('memory_store', { text: 'note' }) });
    const err = await run(activities, {}, async (runId) => {
      await waitForApproval(runId);
      await env.client.workflow.getHandle(runId).cancel();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    expect((err as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);
    expect(calls.tools).toHaveLength(0);
    expect(calls.events.at(-1)).toMatchObject({ type: 'run_cancelled', status: 'cancelled' });
  });

  it('stops at maxSteps when the model never finishes', async () => {
    const { activities, calls } = fakeActivities({ script: (_m, n) => toolUse('sql_query', { sql: 'SELECT 1' }, `toolu_${n}`) });
    const result = await run(activities, { maxSteps: 3 });
    expect(result.status).toBe('max_steps_exceeded');
    expect(calls.llm).toHaveLength(3);
    expect(calls.events.at(-1)).toMatchObject({ type: 'run_failed', status: 'failed' });
  });
});
