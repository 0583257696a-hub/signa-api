import type { Services } from '../../context';
import type { SignJobMessage } from '../../env';
import { recordMetric } from '../metrics/service';
import { deadLetterJob, processSignJob, RetryableJobError } from './jobs';

/** Producer abstraction (Cloudflare Queues in production, in-memory in tests). */
export interface JobQueue {
  send(message: SignJobMessage): Promise<void>;
}

export class CloudflareJobQueue implements JobQueue {
  constructor(private readonly queue: Queue<SignJobMessage>) {}
  async send(message: SignJobMessage): Promise<void> {
    await this.queue.send(message, { contentType: 'json' });
  }
}

/** Exponential backoff for redeliveries: 10s, 20s, 40s … capped at 5 minutes. */
export const backoffSeconds = (attempt: number) => Math.min(300, 10 * 2 ** Math.max(0, attempt - 1));

const isMessage = (b: unknown): b is SignJobMessage =>
  typeof b === 'object' && b !== null && typeof (b as SignJobMessage).jobId === 'string' && /^job_[0-9a-z]{10,40}$/.test((b as SignJobMessage).jobId);

/**
 * Queue consumer. Messages carry only a job ID. Bounded retries are enforced both
 * by the job's attempt counter and by the queue's max_retries + dead-letter queue.
 * Exceptions are logged by code only — never with message bodies or source text.
 */
export async function consumeSignJobs(svc: Services, batch: MessageBatch<unknown>, deadLetter: boolean): Promise<void> {
  for (const msg of batch.messages) {
    if (!isMessage(msg.body)) {
      svc.logger.log('warn', 'queue_message_invalid', { queue: batch.queue });
      msg.ack();
      continue;
    }
    const { jobId } = msg.body;
    if (deadLetter) {
      await deadLetterJob(svc, jobId);
      msg.ack();
      continue;
    }
    try {
      await processSignJob(svc, jobId);
      msg.ack();
    } catch (e) {
      if (e instanceof RetryableJobError) {
        await recordMetric(svc, 'queue_retry', 'sign_jobs');
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      } else {
        await recordMetric(svc, 'queue_consumer_error', 'sign_jobs');
        svc.logger.log('error', 'queue_consumer_error', { jobId, errorCode: e instanceof Error ? e.name : 'unknown' });
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      }
    }
  }
}
