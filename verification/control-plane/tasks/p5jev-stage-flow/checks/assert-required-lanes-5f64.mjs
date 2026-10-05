import fs from 'node:fs';
const dir='verification/control-plane/tasks/p5jev-stage-flow/';
const candidate='5f64ed4d52886e4eee9eb18d67940cd9fddbc1c6d5c47c011fa872d211dd2fcd';
const expected={task_id:'p5jev-stage-flow',task_bundle_id:'8c81cfc89cd6d50b4cc5823ae11e8ef45f23225b3a46b187479ed418a5db91da',candidate_id:candidate,verdict:'PASS'};
for(const kind of ['review','security-review','verifier','evaluation']){
 const record=JSON.parse(fs.readFileSync(`${dir}${kind}.${candidate}.json`,'utf8'));
 for(const [key,value] of Object.entries(expected)) if(record[key]!==value) throw new Error(`${kind} ${key} mismatch`);
 if(typeof record.evidence!=='string'||!record.evidence.trim()) throw new Error(`${kind} evidence string missing`);
}
console.log(`PASS: four required lanes bind and PASS for candidate ${candidate}.`);
