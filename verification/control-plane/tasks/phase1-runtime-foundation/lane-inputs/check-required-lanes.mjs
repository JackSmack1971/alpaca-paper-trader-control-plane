import fs from 'node:fs';

const taskId = 'phase1-runtime-foundation';
const taskBundleId = '88e26fe33f47b4b0cdf5ab5f9a3a90efa4503841f4b111979d3be8981aa2cf75';
const candidateId = 'fe02735524ddb090e021f58eb38360054dc6b6e7f7a4991c73a87963c1542999';
const directory = 'verification/control-plane/tasks/phase1-runtime-foundation';
for (const lane of ['review', 'security-review', 'verifier', 'evaluation']) {
  const record = JSON.parse(fs.readFileSync(`${directory}/${lane}.${candidateId}.json`, 'utf8'));
  if (record.task_id !== taskId || record.task_bundle_id !== taskBundleId || record.candidate_id !== candidateId || record.verdict !== 'PASS' || !record.evidence?.trim()) {
    throw new Error(`required ${lane} evidence is missing or mismatched`);
  }
}
console.log('PASS: all four required candidate-bound lanes passed.');
