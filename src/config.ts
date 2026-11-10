import { anthropicLlm, fakeLlm, type Llm } from './llm/llm';
import { isPricedModel } from './llm/pricing';

export const TASK_QUEUE = 'agentflow';

export function loadConfig(env = process.env) {
  const model = env.LLM_MODEL ?? 'claude-haiku-5-5';
  if (!isPricedModel(model)) throw new Error(`LLM_MODEL "${model}" has no entry in src/llm/pricing.ts`);
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://agentflow:agentflow@localhost:5432/agentflow',
    temporalAddress: env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    port: Number(env.PORT ?? 3000),
    model,
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    allowedHosts: (env.HTTP_FETCH_ALLOWED_HOSTS ?? 'example.com,en.wikipedia.org').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function makeLlm(config: Config): Llm {
  return config.apiKey ? anthropicLlm(config.apiKey, config.model) : fakeLlm(config.model);
}
