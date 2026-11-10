import type { Db } from '../db';
import { embed, toPgVector } from '../memory/embed';
import { TOOL_DEFS, isToolName, type ToolName } from './definitions';
import type { z } from 'zod';

export interface ToolContext {
  db: Db;
  /** Stable per tool call; side-effecting tools must thread it into their writes. */
  idempotencyKey: string;
  allowedHosts: string[];
  fetch?: typeof fetch;
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

/** Expected failures the model should see and react to (bad input, policy). Anything else is retried. */
export class ToolInputError extends Error {}

const MAX_OUTPUT_CHARS = 8_000;
const MAX_ROWS = 50;

type Impl<N extends ToolName> = (input: z.output<(typeof TOOL_DEFS)[N]['schema']>, ctx: ToolContext) => Promise<string>;

const IMPLS: { [N in ToolName]: Impl<N> } = {
  async http_fetch({ url }, ctx) {
    const { hostname } = new URL(url);
    if (!isHostAllowed(hostname, ctx.allowedHosts)) {
      throw new ToolInputError(`Host "${hostname}" is not in the allowlist (${ctx.allowedHosts.join(', ')})`);
    }
    // redirect: 'error' so a redirect cannot escape the allowlist.
    const res = await (ctx.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500) throw new Error(`Upstream ${res.status}`); // transient -> retried by Temporal
    const body = htmlToText(await res.text());
    return `HTTP ${res.status}\n${body}`;
  },

  async sql_query({ sql }, ctx) {
    const statement = sql.trim().replace(/;\s*$/, '');
    if (!/^(select|with)\b/i.test(statement)) throw new ToolInputError('Only SELECT / WITH queries are allowed');
    // The READ ONLY transaction is the real guarantee; wrapping in a subquery also rejects multiple statements.
    try {
      const rows = await ctx.db.readOnly((q) => q(`SELECT * FROM (${statement}) AS q LIMIT ${MAX_ROWS}`));
      return JSON.stringify(rows);
    } catch (err) {
      // SQL errors (syntax, read-only violation, timeout) are the model's to fix, not ours to retry.
      if (isQueryError(err)) throw new ToolInputError(`SQL error: ${err.message}`);
      throw err;
    }
  },

  async memory_search({ query, k }, ctx) {
    const rows = await ctx.db.query<{ text: string; score: number }>(
      'SELECT text, 1 - (embedding <=> $1::vector) AS score FROM memories ORDER BY embedding <=> $1::vector LIMIT $2',
      [toPgVector(embed(query)), k],
    );
    return JSON.stringify(rows.map((r) => ({ text: r.text, score: Number(Number(r.score).toFixed(3)) })));
  },

  async memory_store({ text }, ctx) {
    // ON CONFLICT on the idempotency key makes a retried or replayed call a no-op.
    await ctx.db.query(
      'INSERT INTO memories (idempotency_key, text, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT (idempotency_key) DO NOTHING',
      [ctx.idempotencyKey, text, toPgVector(embed(text))],
    );
    return 'Stored.';
  },
};

/** Validates input with the tool's zod schema and runs it. Input/policy problems come back as `isError` results. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!isToolName(name)) return { output: `Unknown tool "${name}"`, isError: true };
  const parsed = TOOL_DEFS[name].schema.safeParse(rawInput);
  if (!parsed.success) return { output: `Invalid input: ${parsed.error.message}`, isError: true };
  try {
    const output = await (IMPLS[name] as Impl<ToolName>)(parsed.data as never, ctx);
    return { output: output.slice(0, MAX_OUTPUT_CHARS), isError: false };
  } catch (err) {
    if (err instanceof ToolInputError) return { output: err.message, isError: true };
    throw err;
  }
}

export function isHostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SQLSTATE classes caused by the query itself: data (22), read-only txn (25), syntax/access (42), unsupported (0A), timeout. */
function isQueryError(err: unknown): err is Error {
  const code = (err as { code?: unknown })?.code;
  return err instanceof Error && typeof code === 'string' && (/^(22|25|42|0A)[0-9A-Z]{3}$/.test(code) || code === '57014');
}
