import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client, Connection } from '@temporalio/client';
import { RunsController } from './api/runs.controller';
import { CONFIG, DB, RunsService } from './api/runs.service';
import { loadConfig } from './config';
import { migrate, pgDb } from './db';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

async function bootstrap() {
  const config = loadConfig();
  const db = pgDb(config.databaseUrl);
  await migrate(db);
  const temporal = new Client({ connection: await Connection.connect({ address: config.temporalAddress }) });

  @Module({
    controllers: [RunsController, HealthController],
    providers: [RunsService, { provide: DB, useValue: db }, { provide: CONFIG, useValue: config }, { provide: Client, useValue: temporal }],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`api: http://localhost:${config.port}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
