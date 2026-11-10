import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { TOOL_DEFS } from '../tools/definitions';
import type { Usage } from './pricing';

export interface LlmResponse {
  model: string;
  content: Anthropic.ContentBlockParam[];
  stopReason: Anthropic.StopReason | null;
  usage: Usage;
}

export interface Llm {
  complete(messages: Anthropic.MessageParam[]): Promise<LlmResponse>;
}

export const SYSTEM_PROMPT =
  'You are a careful data assistant. Use tools when they help; prefer one tool call at a time. ' +
  'When you have enough information, answer concisely.';

export const TOOLS: Anthropic.Tool[] = Object.entries(TOOL_DEFS).map(([name, def]) => ({
  name,
  description: def.description,
  input_schema: z.toJSONSchema(def.schema, { io: 'input' }) as Anthropic.Tool.InputSchema,
}));

/** Real model. The SDK's own retries are disabled: Temporal's activity retry policy is the single retry layer. */
export function anthropicLlm(apiKey: string, model: string): Llm {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 60_000 });
  return {
    async complete(messages) {
      const res = await client.messages.create({ model, max_tokens: 4096, system: SYSTEM_PROMPT, tools: TOOLS, messages });
      return {
        model,
        content: res.content as Anthropic.ContentBlockParam[],
        stopReason: res.stop_reason,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * Deterministic stand-in used when ANTHROPIC_API_KEY is unset: picks one tool from keywords in the prompt,
 * then answers from the tool result. Token counts are estimated (chars / 4) so cost accounting still runs.
 */
export function fakeLlm(model: string): Llm {
  return {
    async complete(messages) {
      const prompt = textOf(messages[0]);
      const last = messages[messages.length - 1];
      const toolResult =
        last.role === 'user' && Array.isArray(last.content)
          ? last.content.find((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
          : undefined;

      let content: Anthropic.ContentBlockParam[];
      if (toolResult) {
        const body = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content);
        const prefix = toolResult.is_error ? 'The tool call failed' : 'Here is what I found';
        content = [{ type: 'text', text: `${prefix}: ${body.slice(0, 500)}` }];
      } else {
        const call = pickTool(prompt);
        content = call
          ? [
              { type: 'text', text: `I'll use ${call.name}.` },
              { type: 'tool_use', id: `toolu_fake_${messages.length}`, name: call.name, input: call.input },
            ]
          : [{ type: 'text', text: `You said: ${prompt}` }];
      }

      const inChars = JSON.stringify(messages).length + SYSTEM_PROMPT.length + JSON.stringify(TOOLS).length;
      return {
        model,
        content,
        stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: {
          inputTokens: Math.ceil(inChars / 4),
          outputTokens: Math.ceil(JSON.stringify(content).length / 4),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}

function pickTool(prompt: string): { name: string; input: Record<string, unknown> } | undefined {
  const p = prompt.toLowerCase();
  const url = prompt.match(/https?:\/\/\S+/)?.[0];
  if (/\b(remember|save|store)\b/.test(p)) return { name: 'memory_store', input: { text: prompt } };
  if (url) return { name: 'http_fetch', input: { url } };
  if (/\b(revenue|orders?|customers?|sql)\b/.test(p)) {
    return {
      name: 'sql_query',
      input: {
        sql: 'SELECT c.country, sum(o.amount_usd) AS revenue FROM demo.orders o JOIN demo.customers c ON c.id = o.customer_id GROUP BY c.country ORDER BY revenue DESC',
      },
    };
  }
  if (/\b(recall|memory|remembered)\b/.test(p)) return { name: 'memory_search', input: { query: prompt } };
  return undefined;
}

function textOf(m: Anthropic.MessageParam): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}
