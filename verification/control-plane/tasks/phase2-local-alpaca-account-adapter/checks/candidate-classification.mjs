import fs from 'node:fs';

const task = 'phase2-local-alpaca-account-adapter';
const bundle = '8af198f9a5cca633d4203ff316ecbc2eb4df8001247043fbe54364aaaede8162';
const candidateId = '89635b21e947c8b71ba2eb5f4dd38935e78ebcbacf0c6a66bb27a4f3b9e93a2d';
const directory = `verification/control-plane/tasks/${task}`;
const candidate = JSON.parse(fs.readFileSync(`${directory}/candidates/${candidateId}.json`, 'utf8'));
const route = JSON.parse(fs.readFileSync(`${directory}/route.json`, 'utf8'));
const requiredRoles = ['reviewer', 'security_auditor', 'verifier', 'evaluator'];

if (candidate.candidate_id !== candidateId || candidate.task_id !== task || candidate.task_bundle_id !== bundle) throw new Error('frozen candidate binding mismatch');
if (route.task_id !== task || route.bundle_id !== bundle || route.signals.post_diff_risk?.classification_id !== candidate.post_diff_risk?.classification_id) throw new Error('post-diff classification is not synchronized');
if (requiredRoles.some((role) => !candidate.post_diff_risk.required_roles.includes(role))) throw new Error('post-diff classification omitted a required independent lane');
console.log('PASS: frozen candidate classification matches the route and retains every post-diff-required lane.');
