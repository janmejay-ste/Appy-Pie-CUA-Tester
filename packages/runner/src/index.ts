import { connectMongo } from './db/mongo.js';
import { startWorker } from './queue/worker.js';
import { createServer } from './server.js';
import { startCleanupScheduler } from './services/cleanup.service.js';
import { startMetricsScheduler } from './services/metrics.service.js';

const PORT = parseInt(process.env.RUNNER_PORT || '3001', 10);

async function main() {
  // 1. Connect to MongoDB
  await connectMongo();

  // 2. Start BullMQ worker (processes test execution jobs)
  await startWorker();

  // 3. Start retention cleanup scheduler + metrics
  startCleanupScheduler();
  startMetricsScheduler();

  // 4. Start Express API server
  const app = createServer();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  CUA Runner API listening on http://localhost:${PORT}`);
    console.log(`  Health:   http://localhost:${PORT}/health`);
    console.log(`  Tests:    http://localhost:${PORT}/api/tests`);
    console.log(`  Metrics:  http://localhost:${PORT}/api/metrics`);
    console.log(`  MongoDB + Redis + BullMQ + Cleanup ready\n`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
