import fs from 'node:fs';
const task='phase2-market-frame-hardening';
const bundle='a6675919900adf742882e9bd9e2e6dc1c893f1317ccb014f49a31ecd5fd56c5f';
const candidate='e1038d72baa0f017aac6bf76e679b7893e775fe8cc701b973f825574259c2a33';
const dir=`verification/control-plane/tasks/${task}`;
for (const kind of ['review','security-review','verifier','verification','evaluation']) {
 const record=JSON.parse(fs.readFileSync(`${dir}/${kind}.${candidate}.json`,'utf8'));
 if(record.task_id!==task||record.task_bundle_id!==bundle||record.candidate_id!==candidate) throw new Error(`${kind} record identity mismatch`);
 if(kind==='verification' ? record.status!=='PASS' : record.verdict!=='PASS') throw new Error(`${kind} record did not PASS`);
}
console.log(JSON.stringify({status:'PASS',candidate,lanes:['review','security-review','verifier','verification','evaluation']}));
