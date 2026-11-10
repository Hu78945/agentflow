import type Anthropic from '@anthropic-ai/sdk';
import type { Duration } from '@temporalio/common';
import {
  ActivityFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import { requiresApproval } from '../tools/definitions';
import type { Activities } from './activities';

export interface AgentRunInput {
  runId: string;
  prompt: string;
  maxSteps?: number;
  approvalTimeout?: Duration;
}

export interface AgentRunResult {
  status: 'completed' | 'max_steps_exceeded';
  output: string;
  steps: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Defaults to the call currently waiting for approval. */
  toolUseId?: string;
  reason?: string;
}

export interface PendingApproval {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface RunState {
  step: number;
  pendingApproval?: PendingApproval;
}

export const approvalSignal = defineSignal<[ApprovalDecision]>('approval');
export const stateQuery = defineQuery<RunState>('state');

// Both long-running activities heartbeat every second; 5s of silence means the worker died and the call is retried elsewhere.
// LLM calls: rate limits and 5xx are common and transient, so retry with backoff; non-retryable failures skip this.
const { callLlm } = proxyActivities<Activities>({
  startToCloseTimeout: '90s',
  heartbeatTimeout: '5s',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '30s', maximumAttempts: 5 },
});
// Tools: fewer attempts; after the last one the failure is handed to the model as an error result.
const { executeTool } = proxyActivities<Activities>({
  startToCloseTimeout: '30s',
  heartbeatTimeout: '5s',
  retry: { initialInterval: '1s', maximumAttempts: 3 },
});
const { recordEvent } = proxyActivities<Activities>({
  startToCloseTimeout: '10s',
  retry: { maximumAttempts: 10 },
});

/**
 * One agent run: LLM -> tool calls -> LLM ... until the model stops asking for tools.
 * Every step is an activity, so a crashed worker resumes from the last completed step instead of starting over.
 */
export async function agentRun({ runId, prompt, maxSteps = 10, approvalTimeout = '24h' }: AgentRunInput): Promise<AgentRunResult> {
  // Trade-off: full history rides in workflow state and every callLlm input; continue-as-new if runs get long.
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  const decisions = new Map<string, ApprovalDecision>();
  const state: RunState = { step: 0 };

  setHandler(stateQuery, () => state);
  setHandler(approvalSignal, (d) => {
    const id = d.toolUseId ?? state.pendingApproval?.toolUseId;
    if (id) decisions.set(id, d);
  });

  async function runTool(call: Anthropic.ToolUseBlockParam): Promise<Anthropic.ToolResultBlockParam> {
    const result = (content: string, isError: boolean): Anthropic.ToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content,
      is_error: isError,
    });

    if (requiresApproval(call.name)) {
      state.pendingApproval = { toolUseId: call.id, name: call.name, input: call.input };
      await recordEvent({ runId, type: 'approval_requested', data: { ...state.pendingApproval }, status: 'awaiting_approval' });
      const decided = await condition(() => decisions.has(call.id), approvalTimeout);
      state.pendingApproval = undefined;
      const decision = decisions.get(call.id);
      await recordEvent({ runId, type: 'approval_resolved', data: { toolUseId: call.id, timedOut: !decided, ...decision }, status: 'running' });
      if (!decision?.approved) {
        return result(decided ? `A human rejected this call${decision?.reason ? `: ${decision.reason}` : '.'}` : 'Approval timed out.', true);
      }
    }

    try {
      const { output, isError } = await executeTool({ runId, toolUseId: call.id, name: call.name, input: call.input });
      return result(output, isError);
    } catch (err) {
      if (isCancellation(err) || !(err instanceof ActivityFailure)) throw err;
      return result(`Tool failed after retries: ${err.cause?.message ?? err.message}`, true);
    }
  }

  try {
    await recordEvent({ runId, type: 'run_started', data: { prompt }, status: 'running' });
    for (state.step = 1; state.step <= maxSteps; state.step++) {
      const res = await callLlm({ runId, step: state.step, messages });
      messages.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
      if (res.stopReason !== 'tool_use' || calls.length === 0) {
        const output = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
        await recordEvent({ runId, type: 'run_completed', data: { output, stopReason: res.stopReason }, status: 'completed', output });
        return { status: 'completed', output, steps: state.step };
      }

      // Sequential on purpose: approvals are easier to reason about one at a time. All results go back in one message.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) results.push(await runTool(call));
      messages.push({ role: 'user', content: results });
    }
    const output = `Stopped after ${maxSteps} steps without a final answer.`;
    await recordEvent({ runId, type: 'run_failed', data: { reason: 'max_steps_exceeded' }, status: 'failed', output });
    return { status: 'max_steps_exceeded', output, steps: maxSteps };
  } catch (err) {
    const cancelled = isCancellation(err);
    // Runs even though the workflow scope is cancelled, so the DB never shows a cancelled run as "running".
    await CancellationScope.nonCancellable(() =>
      recordEvent({
        runId,
        type: cancelled ? 'run_cancelled' : 'run_failed',
        data: { error: err instanceof Error ? err.message : String(err) },
        status: cancelled ? 'cancelled' : 'failed',
      }),
    );
    throw err;
  }
}
