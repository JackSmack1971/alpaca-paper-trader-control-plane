import path from 'node:path';
import { validateCloseout } from './validate-closeout.mjs';
import { findRepoRoot, parseArg } from './lib.mjs';
try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(parseArg(args, '--repo-root') ?? process.cwd());
  const phase = Number(parseArg(args, '--phase', { required: true }));
  const manifestArg = parseArg(args, '--manifest') ?? `verification/phase-reports/phase-${String(phase).padStart(2,'0')}.closeout.json`;
  validateCloseout(root, phase, path.isAbsolute(manifestArg) ? manifestArg : path.join(root, manifestArg));
  console.log('PASS: closeout manifest reconciles with current candidate and control-plane evidence.');
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
