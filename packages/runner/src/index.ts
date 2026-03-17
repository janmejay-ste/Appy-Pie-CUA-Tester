import { initDb } from './db.js';
import { createServer } from './server.js';

const PORT = parseInt(process.env.RUNNER_PORT || '3001', 10);

async function main() {
  // Initialize database before starting server
  await initDb();

  const app = createServer();

  app.listen(PORT, () => {
    console.log(`\n  CUA Runner API listening on http://localhost:${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/health`);
    console.log(`  Tests:  http://localhost:${PORT}/api/tests\n`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
