import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import { TASK_QUEUE, type Config } from '../config';
import type { Db } from '../db';
import { agentRun, approvalSignal, stateQuery, type ApprovalDecision } from '../temporal/workflows';

export const DB = Symbol('DB');
export const CONFIG = Symbol('CONFIG');

export interface RunEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export const TERMINAL_EVENTS = new Set(['run_completed', 'run_failed', 'run_cancelled']);

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    private readonly temporal: Client,
  ) {}

  async create(prompt: string, maxSteps?: number) {
    const id = randomUUID();
    await this.db.query('INSERT INTO runs (id, prompt, model) VALUES ($1, $2, $3)', [id, prompt, this.config.model]);
    // Workflow id = run id: starting the same run twice is rejected by Temporal, not duplicated.
    await this.temporal.workflow.start(agentRun, { taskQueue: TASK_QUEUE, workflowId: id, args: [{ runId: id, prompt, maxSteps }] });
    return { id, status: 'queued' };
  }

  async get(id: string) {
    const [run] = await this.db.query<{ status: string }>('SELECT * FROM runs WHERE id = $1', [id]);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    const [usage] = await this.db.query(
      `SELECT count(*)::int AS llm_calls,
              coalesce(sum(input_tokens), 0)::int AS input_tokens,
              coalesce(sum(output_tokens), 0)::int AS output_tokens,
              coalesce(sum(cache_read_tokens), 0)::int AS cache_read_tokens,
              coalesce(sum(cache_write_tokens), 0)::int AS cache_write_tokens,
              coalesce(sum(cost_usd), 0)::float8 AS cost_usd
       FROM llm_calls WHERE run_id = $1`,
      [id],
    );
    const pendingApproval =
      run.status === 'awaiting_approval' ? (await this.temporal.workflow.getHandle(id).query(stateQuery)).pendingApproval : undefined;
    return { ...run, usage, pendingApproval };
  }

  async decide(id: string, decision: ApprovalDecision) {
    const run = await this.get(id);
    if (run.status !== 'awaiting_approval') throw new ConflictException(`Run is ${run.status}, not awaiting approval`);
    await this.temporal.workflow.getHandle(id).signal(approvalSignal, decision);
    return { id, accepted: true };
  }

  async cancel(id: string) {
    await this.get(id);
    try {
      await this.temporal.workflow.getHandle(id).cancel();
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) throw new ConflictException('Run already finished');
      throw err;
    }
    return { id, cancelRequested: true };
  }

  eventsAfter(id: string, afterId: string): Promise<RunEvent[]> {
    return this.db.query<RunEvent>(
      'SELECT id::text, type, data, created_at FROM run_events WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 100',
      [id, afterId],
    );
  }
}
