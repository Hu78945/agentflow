import { NativeConnection, Worker } from '@temporalio/worker';
import { loadConfig, makeLlm, TASK_QUEUE } from './config';
import { migrate, pgDb } from './db';
import { createActivities } from './temporal/activities';

async function main() {
  const config = loadConfig();
  const db = pgDb(config.databaseUrl);
  await migrate(db);
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./temporal/workflows'),
    activities: createActivities({ db, llm: makeLlm(config), allowedHosts: config.allowedHosts }),
  });
  console.log(`worker: task queue "${TASK_QUEUE}", model ${config.model}${config.apiKey ? '' : ' (fake LLM: ANTHROPIC_API_KEY unset)'}`);
  await worker.run(); // resolves after SIGINT/SIGTERM drain
  await connection.close();
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
