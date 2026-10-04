import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

export async function applyMigrations(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const migrationDirectory = path.resolve('migrations');
  const migrations = (await fs.readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name))
    .sort();
  for (const name of migrations) {
    const sql = await fs.readFile(path.join(migrationDirectory, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (result.rowCount === 0) {
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
}
