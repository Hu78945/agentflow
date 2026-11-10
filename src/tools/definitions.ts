import { z } from 'zod';

/**
 * Tool contracts: name, description, input schema, and whether a human must approve the call.
 * Kept free of I/O so the workflow sandbox can import it (it only needs `requiresApproval`).
 */
export const TOOL_DEFS = {
  http_fetch: {
    description: 'Fetch a web page over HTTP(S) and return its text. Only allowlisted hosts are reachable.',
    schema: z.strictObject({ url: z.url({ protocol: /^https?$/ }) }),
    requiresApproval: false,
  },
  sql_query: {
    description:
      'Run one read-only SQL SELECT against the demo dataset (tables: demo.customers(id,name,country), demo.orders(id,customer_id,amount_usd,created_at)). At most 50 rows are returned.',
    schema: z.strictObject({ sql: z.string().min(1).max(2000) }),
    requiresApproval: false,
  },
  memory_search: {
    description: 'Search long-term memory for notes similar to the query.',
    schema: z.strictObject({ query: z.string().min(1).max(500), k: z.int().min(1).max(10).default(3) }),
    requiresApproval: false,
  },
  memory_store: {
    description: 'Save a note to long-term memory. Writes require human approval.',
    schema: z.strictObject({ text: z.string().min(1).max(2000) }),
    requiresApproval: true,
  },
} as const;

export type ToolName = keyof typeof TOOL_DEFS;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_DEFS, name);
}

export function requiresApproval(name: string): boolean {
  return isToolName(name) && TOOL_DEFS[name].requiresApproval;
}
