import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redisOpts = { host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null as null };

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Main execution queue
export const testExecutionQueue = new Queue('test-execution', {
  connection: redisOpts,
  defaultJobOptions: {
    attempts: 2,                    // retry once on failure
    backoff: { type: 'fixed', delay: 5000 }, // 5s before retry
    removeOnComplete: 200,
    removeOnFail: 100,
  },
});

// Dead Letter Queue — failed jobs after all retries exhausted
export const deadLetterQueue = new Queue('test-execution-dlq', {
  connection: redisOpts,
  defaultJobOptions: {
    removeOnComplete: 500,          // keep DLQ entries longer for investigation
    removeOnFail: 500,
  },
});

// Queue events for monitoring
export const queueEvents = new QueueEvents('test-execution', { connection: redisOpts });

export interface TestJobData {
  sessionId: string;
  testRunId: string;
  testId: string;
  testName: string;
  testUrl: string;
  testInstructions: string;
  expectedOutcome: string;
  headless: boolean;
  requiresAuth: boolean;
  maxTurns?: number;
  timeout?: number;
  viewport?: { width: number; height: number };
  resumeFromUrl?: string;
  resumeContext?: string;
  resumeStorageStatePath?: string; // browser cookies/localStorage from timed-out run
  attempt?: number;
  /** Optional declarative validation rules from the test definition. */
  validation?: Array<{ type: 'url' | 'text' | 'element' | 'not_text'; value: string; label?: string }>;
}

export function createSubscriber() {
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

// Get queue metrics
export async function getQueueMetrics() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    testExecutionQueue.getWaitingCount(),
    testExecutionQueue.getActiveCount(),
    testExecutionQueue.getCompletedCount(),
    testExecutionQueue.getFailedCount(),
    testExecutionQueue.getDelayedCount(),
  ]);

  const dlqCount = await deadLetterQueue.getWaitingCount();

  return { waiting, active, completed, failed, delayed, dlq: dlqCount };
}
