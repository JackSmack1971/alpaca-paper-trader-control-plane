import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src/api');
const files = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(root, entry.name));
const violations = files.filter((file) => /\/orders\b|\/trading\b|live-api\.alpaca\.markets/i.test(fs.readFileSync(file, 'utf8')));
if (violations.length) {
  console.error(`Forbidden trading route found: ${violations.map((file) => path.relative(process.cwd(), file)).join(', ')}`);
  process.exit(1);
}
console.log('PASS: no live-trading endpoint or trading route is registered.');
