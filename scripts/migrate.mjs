import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const migrationsDirectory = path.resolve('migrations');
  const migrationNames = (await fs.readdir(migrationsDirectory)).filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name)).sort();
  for (const name of migrationNames) {
    const sql = await fs.readFile(path.join(migrationsDirectory, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (found.rowCount === 0) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} catch {
  console.error('Database migration failed; connection details are redacted.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
