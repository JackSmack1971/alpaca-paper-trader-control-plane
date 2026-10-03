import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync('docs/control-plane/phase-state.json', 'utf8'));
const phase = state.phases.find(p => p.id === state.active_phase);
if (!phase) throw new Error(`active phase ${state.active_phase} is not defined`);
console.log(`Phase ${phase.id}: ${phase.title}`);
console.log(`Status: ${phase.status}`);
console.log(`Goal: ${phase.goal_file}`);
console.log(`Report: ${phase.report_file}`);
