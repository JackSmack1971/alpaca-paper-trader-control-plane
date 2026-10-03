import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('src');
if (!fs.existsSync(src)) {
  console.log('SKIP: src/ does not exist yet (expected before Phase 1 implementation).');
  process.exit(0);
}
const prohibited = [
  { label: 'Alpaca live REST host', re: /https:\/\/api\.alpaca\.markets/i },
  { label: 'Alpaca live trading stream', re: /wss:\/\/api\.alpaca\.markets\/stream/i },
  { label: 'environment-selectable live trading mode', re: /(?:TRADING_MODE|ALPACA_MODE|BROKER_MODE)[^\n]{0,80}\blive\b/i },
  { label: 'explicit live-trading flag', re: /(?:liveTrading|live_trading|enableLiveTrading)\s*[:=]\s*(?:true|1|['"]true['"])/i }
];
const allowedExt = new Set(['.ts','.tsx','.js','.mjs','.cjs','.json']);
const findings = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (allowedExt.has(path.extname(ent.name))) {
      const text = fs.readFileSync(p, 'utf8');
      for (const rule of prohibited) if (rule.re.test(text)) findings.push({file:path.relative(process.cwd(),p), value:rule.label});
    }
  }
}
walk(src);
if (findings.length) {
  console.error('FAIL: PAPER-only static invariant violated in production src/:');
  for (const f of findings) console.error(`- ${f.file}: ${f.value}`);
  process.exit(1);
}
console.log('PASS: no prohibited live-trading endpoint/mode material found in production src/.');
