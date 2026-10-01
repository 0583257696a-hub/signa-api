import type { Services } from '../../context';
import { run } from '../../lib/db';
import { hourBucket } from '../../lib/time';

/**
 * Hourly aggregate counters in D1 for metrics that admins need to query
 * (queue failures, provider latency, job outcomes). High-volume request
 * counters are emitted as structured logs instead, to avoid a D1 write per request.
 */
export async function recordMetric(svc: Services, name: string, label = '', value = 0): Promise<void> {
  try {
    await run(
      svc.db,
      `INSERT INTO ops_metrics (bucket, name, label, count, sum_value, max_value) VALUES (?,?,?,1,?,?)
       ON CONFLICT (bucket, name, label) DO UPDATE SET
         count = count + 1, sum_value = sum_value + excluded.sum_value,
         max_value = MAX(max_value, excluded.max_value)`,
      hourBucket(svc.now()),
      name,
      label,
      Math.round(value),
      Math.round(value),
    );
  } catch {
    // Metrics must never break the request path.
  }
}
