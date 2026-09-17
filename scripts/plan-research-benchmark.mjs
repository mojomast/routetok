import fs from 'node:fs';
const matrix=JSON.parse(fs.readFileSync('benchmarks/research-matrix.json','utf8'));
const jobs=[];
for(const model of matrix.models){if(!model.source.startsWith('https://')||!model.caveat)throw Error('missing provenance');for(const id of model.slices){const slice=matrix.slices.find(s=>s.id===id);if(!slice)throw Error('unknown slice');for(const budget of slice.budgets)jobs.push({model:model.id,slice:id,...budget,metrics:slice.metrics,source:model.source,status:'planned_not_executed'});}}
console.log(JSON.stringify({version:matrix.version,jobs},null,2));
