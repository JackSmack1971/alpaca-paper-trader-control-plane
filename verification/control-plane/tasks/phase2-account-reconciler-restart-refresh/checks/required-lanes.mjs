import fs from 'node:fs';

const task = 'phase2-account-reconciler-restart-refresh';
const bundle = '5a392ee137b19bb6e9b996f4e1dc4271818f247e9845acf9a81dc973450920b2';
const candidate = '1620669848f244323b8ad3e974e9610e756d1e792b5188c9c772c5c766d5f0ec';
const root = `verification/control-plane/tasks/${task}`;
const lanes = [
  ['review', 'verdict'],
  ['security-review', 'verdict'],
  ['verifier', 'verdict'],
  ['evaluation', 'verdict'],
];

for (const [kind, verdictKey] of lanes) {
  const record = JSON.parse(fs.readFileSync(`${root}/${kind}.${candidate}.json`, 'utf8'));
  if (record.task_id !== task || record.task_bundle_id !== bundle || record.candidate_id !== candidate || record[verdictKey] !== 'PASS') {
    throw new Error(`${kind} record is missing, mismatched, or not PASS`);
  }
}
console.log('PASS: review, security, verifier, and evaluator records bind the exact task bundle and candidate.');
