import {readFileSync} from 'node:fs';
import {summarize, type Trial} from '../src/routing-benchmark.js';
// Replay prior paired run, objectively scorable subset only. Known examples are development, NEVER heldout.
const rows=JSON.parse(readFileSync(process.argv[2],'utf8'));
const expected:Record<string,string>={extract:'ana@example.com',debug:'3',math:'391',logic:'no',multilingual:'good morning.'};
const trials:Trial[]=rows.filter((r:any)=>r.id in expected).map((r:any)=>({task:r.id,split:'development',family:r.id,route:r.route,answered:r.status===200,success:r.status===200&&typeof r.text==='string'&&r.text.trim().toLowerCase()===expected[r.id],latencyMs:r.ms,downstreamUsd:r.usage?.cost??(r.status===503?0:null),classifierUsd:r.route==='jev-auto'?null:0}));
console.log(JSON.stringify(summarize(trials),null,2));
