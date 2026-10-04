import { loadConfig } from '../src/infra/config.js';
import { createDatabase } from '../src/infra/db/client.js';
import { applyMigrations } from '../src/infra/migrations.js';

try {
  const config = await loadConfig();
  const { pool } = createDatabase(config.databaseUrl);
  try {
    await applyMigrations(pool);
    console.log('Database migrations are current.');
  } finally {
    await pool.end();
  }
} catch {
  console.error('Database migration failed; connection details are redacted.');
  process.exitCode = 1;
}
