export function assertLoopbackDatabase(connectionString: string): void {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error('Development seed requires a PostgreSQL loopback database.');
  }
  const hostname = databaseUrl.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new Error('Development seed is restricted to a PostgreSQL loopback database.');
  }
}
