import fs from 'node:fs';

const task = 'phase2-local-alpaca-account-adapter';
const bundle = '8af198f9a5cca633d4203ff316ecbc2eb4df8001247043fbe54364aaaede8162';
const candidate = '89635b21e947c8b71ba2eb5f4dd38935e78ebcbacf0c6a66bb27a4f3b9e93a2d';
const directory = `verification/control-plane/tasks/${task}`;
for (const lane of ['review', 'security-review', 'verifier', 'evaluation']) {
  const record = JSON.parse(fs.readFileSync(`${directory}/${lane}.${candidate}.json`, 'utf8'));
  if (record.task_id !== task || record.task_bundle_id !== bundle || record.candidate_id !== candidate || record.verdict !== 'PASS') {
    throw new Error(`${lane} record is missing, mismatched, or not PASS`);
  }
}
console.log('PASS: all independent lanes bind the exact task bundle and frozen candidate.');
