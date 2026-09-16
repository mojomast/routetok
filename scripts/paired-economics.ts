import fs from 'node:fs';import {routingEconomics} from '../src/routing-economics.js';
const path=process.argv[2];if(!path)throw Error('paired results path required');const rows=fs.readFileSync(path,'utf8').trim().split('\n').map(x=>JSON.parse(x));
const decisions=rows.filter(r=>r.kind==='decision');const generations=rows.filter(r=>r.kind==='generation');
let reference=0,selected=0,input=0,output=0;
for(const d of decisions){const baseline=generations.find(r=>r.id===d.id&&r.model==='deepseek/deepseek-v4.1-flash');const chosen=generations.find(r=>r.id===d.id&&'openrouter:'+r.model===d.selected);if(!baseline?.usage||!chosen?.usage||!Number.isSafeInteger(d.input)||!Number.isSafeInteger(d.output))throw Error('incomplete_paired_billing');reference+=baseline.usage.cost;selected+=chosen.usage.cost;input+=d.input;output+=d.output;}
console.log(JSON.stringify({source:'https://typesafe.ai/blog/introducing-system-one-models-and-jev',inputUsdPerMillion:.042,outputUsdPerMillion:0,tasks:decisions.length,...routingEconomics(reference,selected,input,output,.042,0)},null,2));
