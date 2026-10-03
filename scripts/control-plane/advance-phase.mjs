import fs from 'node:fs';
import path from 'node:path';
import { validateCloseout } from './validate-closeout.mjs';
import { canonicalText, findRepoRoot, loadPhaseState, parseArg, writeJsonAtomic } from './lib.mjs';

try {
  const args = process.argv.slice(2);
  const root = findRepoRoot(process.cwd());
  const n = Number(parseArg(args, '--phase', { required: true }));
  if (!Number.isInteger(n) || n < 1) throw new Error('usage: node scripts/control-plane/advance-phase.mjs --phase N');
  const statePath = path.join(root, 'docs/control-plane/phase-state.json');
  const state = loadPhaseState(root);
  if (state.active_phase !== n) throw new Error(`phase ${n} is not active; active phase is ${state.active_phase}`);
  const phase = state.phases.find(p => p.id === n);
  const reportPath = path.join(root, phase.report_file);
  if (!fs.existsSync(reportPath)) throw new Error(`missing human report: ${phase.report_file}`);
  const report = canonicalText(fs.readFileSync(reportPath));
  if (!/^[- ]*Phase status:\s*COMPLETE\s*$/mi.test(report)) throw new Error('human report does not declare Phase status: COMPLETE');
  const manifestPath = path.join(root, `verification/phase-reports/phase-${String(n).padStart(2,'0')}.closeout.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`missing machine closeout manifest: ${path.relative(root, manifestPath)}`);
  validateCloseout(root, n, manifestPath);

  phase.status = 'complete';
  const next = state.phases.find(p => p.id === n + 1);
  if (next) { next.status = 'active'; state.active_phase = next.id; }
  else state.active_phase = null;
  writeJsonAtomic(statePath, state);
  console.log(next ? `Advanced: phase ${n} complete; phase ${next.id} active.` : `Advanced: phase ${n} complete; project phase sequence finished.`);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
