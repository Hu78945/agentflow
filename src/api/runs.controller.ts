import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Sse, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { RunsService, TERMINAL_EVENTS } from './runs.service';

const CreateRun = z.strictObject({ prompt: z.string().min(1).max(10_000), maxSteps: z.int().min(1).max(25).optional() });
const Decision = z.strictObject({ toolUseId: z.string().optional(), reason: z.string().max(1000).optional() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

const POLL_MS = 300;

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  create(@Body() body: unknown) {
    const { prompt, maxSteps } = parse(CreateRun, body);
    return this.runs.create(prompt, maxSteps);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Post(':id/approve')
  @HttpCode(202)
  approve(@Param('id') id: string, @Body() body: unknown) {
    return this.runs.decide(id, { approved: true, ...parse(Decision, body) });
  }

  @Post(':id/reject')
  @HttpCode(202)
  reject(@Param('id') id: string, @Body() body: unknown) {
    return this.runs.decide(id, { approved: false, ...parse(Decision, body) });
  }

  @Post(':id/cancel')
  @HttpCode(202)
  cancel(@Param('id') id: string) {
    return this.runs.cancel(id);
  }

  /** Streams the run's step log; reconnecting clients resume via Last-Event-ID. Closes after the terminal event. */
  @Sse(':id/events')
  events(@Param('id') id: string, @Headers('last-event-id') lastEventId?: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cursor = /^\d+$/.test(lastEventId ?? '') ? lastEventId! : '0';
      let timer: NodeJS.Timeout | undefined;
      let closed = false;
      // Trade-off: DB polling per subscriber; switch to LISTEN/NOTIFY if many clients watch at once.
      const poll = async () => {
        try {
          for (const e of await this.runs.eventsAfter(id, cursor)) {
            cursor = e.id;
            subscriber.next({ id: e.id, type: e.type, data: { ...e.data, at: e.created_at } });
            if (TERMINAL_EVENTS.has(e.type)) return subscriber.complete();
          }
          if (!closed) timer = setTimeout(poll, POLL_MS);
        } catch (err) {
          subscriber.error(err);
        }
      };
      void this.runs.get(id).then(poll, (err) => subscriber.error(err));
      return () => {
        closed = true;
        clearTimeout(timer);
      };
    });
  }
}
