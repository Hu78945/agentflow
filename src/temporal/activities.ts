import Anthropic from '@anthropic-ai/sdk';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Db } from '../db';
import type { Llm, LlmResponse } from '../llm/llm';
import { costUsd } from '../llm/pricing';
import { runTool, type ToolResult } from '../tools/tools';

export interface ActivityDeps {
  db: Db;
  llm: Llm;
  allowedHosts: string[];
  fetch?: typeof fetch;
}

export interface CallLlmInput {
  runId: string;
  step: number;
  messages: Anthropic.MessageParam[];
}

export interface ExecuteToolInput {
  runId: string;
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface RecordEventInput {
  runId: string;
  type: string;
  data?: Record<string, unknown>;
  status?: string;
  output?: string;
}

export function createActivities({ db, llm, allowedHosts, fetch }: ActivityDeps) {
  /**
   * Appends to the run's event log at most once per key. Activities are at-least-once: a worker can die after the
   * INSERT but before Temporal hears about it, and the retry must not log the same step twice.
   */
  async function appendEvent(runId: string, type: string, data: Record<string, unknown>, perAttempt: boolean) {
    const { workflowExecution, activityId, attempt } = Context.current().info;
    const dedupKey = [workflowExecution?.runId ?? runId, activityId, perAttempt ? attempt : 0, type].join(':');
    await db.query('INSERT INTO run_events (run_id, type, data, dedup_key) VALUES ($1, $2, $3, $4) ON CONFLICT (dedup_key) DO NOTHING', [
      runId,
      type,
      data,
      dedupKey,
    ]);
  }

  async function recordEvent({ runId, type, data = {}, status, output }: RecordEventInput): Promise<void> {
    await appendEvent(runId, type, data, false);
    if (status) {
      await db.query('UPDATE runs SET status = $2, output = COALESCE($3, output), updated_at = now() WHERE id = $1', [
        runId,
        status,
        output ?? null,
      ]);
    }
  }

  return {
    recordEvent,

    async callLlm({ runId, step, messages }: CallLlmInput): Promise<LlmResponse> {
      const { attempt } = Context.current().info;
      const started = performance.now();
      let res: LlmResponse;
      try {
        res = await withHeartbeat(() => llm.complete(messages));
      } catch (err) {
        throw toTemporalFailure(err);
      }
      const latencyMs = Math.round(performance.now() - started);
      const cost = costUsd(res.model, res.usage);
      const u = res.usage;
      await db.query(
        `INSERT INTO llm_calls (run_id, step, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [runId, step, attempt, res.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, cost, latencyMs],
      );
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      // Per attempt: if a retry calls the model again, that second (billed) response is a real, separate event.
      await appendEvent(runId, 'llm_response', { step, attempt, stopReason: res.stopReason, text, usage: u, costUsd: cost, latencyMs }, true);
      return res;
    },

    /** At-least-once delivery from Temporal + this ledger = each tool call's result is recorded and returned once. */
    async executeTool({ runId, toolUseId, name, input }: ExecuteToolInput): Promise<ToolResult> {
      const key = `${runId}:${toolUseId}`;
      const prior = await findExecution(db, key);
      if (prior) {
        await appendEvent(runId, 'tool_replayed', { toolUseId, name }, true);
        return prior;
      }
      const result = await withHeartbeat(() => runTool(name, input, { db, idempotencyKey: key, allowedHosts, fetch }));
      await db.query(
        `INSERT INTO tool_executions (idempotency_key, run_id, tool, input, output, is_error)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, runId, name, JSON.stringify(input ?? null), result.output, result.isError],
      );
      const stored = (await findExecution(db, key)) ?? result; // a concurrent attempt may have won the insert
      await appendEvent(runId, 'tool_result', { toolUseId, name, ...stored }, true);
      return stored;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

/** Heartbeats while `fn` runs, so a dead worker is noticed after heartbeatTimeout instead of startToCloseTimeout. */
async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const timer = setInterval(() => ctx.heartbeat(), 1_000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function findExecution(db: Db, key: string): Promise<ToolResult | undefined> {
  const [row] = await db.query<{ output: string; is_error: boolean }>(
    'SELECT output, is_error FROM tool_executions WHERE idempotency_key = $1',
    [key],
  );
  return row && { output: row.output, isError: row.is_error };
}

/** Client errors (bad request, auth) will fail identically on retry; rate limits, 5xx and network errors won't. */
function toTemporalFailure(err: unknown): unknown {
  if (err instanceof Anthropic.APIError && err.status !== undefined && err.status < 500 && err.status !== 429 && err.status !== 408) {
    return ApplicationFailure.nonRetryable(err.message, `AnthropicHttp${err.status}`);
  }
  return err;
}
