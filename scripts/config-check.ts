import { loadConfig, publicConfig } from '../src/infra/config.js';

try {
  const config = await loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://local:local@127.0.0.1:5432/alpaca_paper_dev',
  });
  console.log(JSON.stringify(publicConfig(config), null, 2));
} catch {
  console.error('Invalid application configuration; values are redacted.');
  process.exitCode = 1;
}
