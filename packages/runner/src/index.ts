import { connectDb } from './db/turso.js';
import { startWorker } from './queue/worker.js';
import { createServer } from './server.js';
import { startCleanupScheduler } from './services/cleanup.service.js';
import { startMetricsScheduler } from './services/metrics.service.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.RUNNER_PORT || '3001', 10);
if (Number.isNaN(PORT)) {
  logger.error(`Invalid RUNNER_PORT: "${process.env.RUNNER_PORT}"`);
  process.exit(1);
}

async function main() {
  // 1. Connect to Turso/SQLite
  await connectDb();

  // 2. Start BullMQ worker (processes test execution jobs)
  await startWorker();

  // 3. Start retention cleanup scheduler + metrics
  await Promise.all([startCleanupScheduler(), startMetricsScheduler()]);

  // 4. Start Express API server
  const app = createServer();

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`CUA Runner API listening on http://localhost:${PORT}`);
    logger.info(`Health:   http://localhost:${PORT}/health`);
    logger.info(`Tests:    http://localhost:${PORT}/api/tests`);
    logger.info(`Metrics:  http://localhost:${PORT}/api/metrics`);
    logger.info(`Turso + Redis + BullMQ + Cleanup ready`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start server');
  process.exit(1);
});
