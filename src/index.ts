import { createApp } from './app';
import { runMaintenance } from './cron';
import type { Bindings } from './env';
import { consumeSignJobs } from './modules/sign/queue';
import { buildServices } from './services';

const app = createApp();

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    const svc = buildServices(env);
    await consumeSignJobs(svc, batch, batch.queue.endsWith('-dlq'));
  },

  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMaintenance(buildServices(env), controller.cron).then(() => undefined));
  },
} satisfies ExportedHandler<Bindings>;
