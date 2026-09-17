import fs from 'node:fs';
const keys={or:process.env.OPENROUTER_API_KEY};if(!keys.or)throw Error('OPENROUTER_API_KEY required');const cases=JSON.parse(fs.readFileSync('/tmp/routetok-hard-cases.json','utf8'));
const models=['google/gemini-2.5-flash-lite','openai/gpt-4.1-nano','deepseek/deepseek-v4.1-flash','deepseek/deepseek-v4-flash-0731'];
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));function canonical(x){return Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;}
const completed=fs.existsSync('/tmp/routetok-hard-results.jsonl')?fs.readFileSync('/tmp/routetok-hard-results.jsonl','utf8').trim().split('\n').map(x=>JSON.parse(x)):[];
const jobs=cases.flatMap((c,i)=>models.map((_,j)=>({c,model:models[(i+j)%models.length]}))).filter(j=>!completed.some(r=>r.id===j.c.id&&r.model===j.model));let index=0;
// <=48 requests, <=16384 output tokens each, prompts < 16000 bytes.
// Provider ceilings $0.30/$1.20 per million: conservative bound < $1 including prior spend.
if(cases.some(c=>Buffer.byteLength(c.prompt)>16000))throw Error('prompt cap');
async function worker(){while(index<jobs.length){const {c,model}=jobs[index++];const t=Date.now();let row;
try{const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${keys.or}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(180000),body:JSON.stringify({model,messages:[{role:'user',content:c.prompt}],max_tokens:8192,provider:{max_price:{prompt:.3,completion:1.2}}})});const d=await r.json();const text=d.choices?.[0]?.message?.content??'';let parsed,valid=false;try{parsed=JSON.parse(text);valid=true;}catch{}row={id:c.id,family:c.family,model,status:r.status,ms:Date.now()-t,validJson:valid,pass:r.ok&&valid&&equal(parsed,c.expected),text,usage:d.usage,finish:d.choices?.[0]?.finish_reason};}catch(e){row={id:c.id,model,status:0,pass:false,error:e.name};}
fs.appendFileSync('/tmp/routetok-hard-results.jsonl',JSON.stringify(row)+'\n');console.log(c.id,model,row.status,row.pass,row.finish);}}
await Promise.all([worker(),worker(),worker(),worker()]);
