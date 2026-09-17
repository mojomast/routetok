import fs from 'node:fs';
import {jevSelect} from '../src/jev.ts';
const key=process.env.OPENROUTER_API_KEY,output=process.env.BENCH_OUTPUT;if(!key||!output||fs.existsSync(output))throw Error('fresh output and credentials required');
const cases=[
 {id:'parse',family:'writing',prompt:'Extract the final approved code only. Draft code: AX7. Revision: draft AX8. Approval: use BX9; AX8 is canceled. Return code only.',expected:'BX9'},
 {id:'unicode',family:'writing',prompt:'Translate to English, exactly two words without punctuation: buenas noches',expected:'good night'},
 {id:'alias',family:'coding',prompt:'Python: x=[[0],[1]]; y=x[:]; y[0].append(2); y[1]=[9]. Return only JSON for x.',expected:[[0,2],[1]]},
 {id:'scope',family:'coding',prompt:'Python: nums=[1,2,3]; result=[i*i for i in nums if i%2]; nums[0]=9. Return only JSON for result.',expected:[1,9]},
 {id:'probability',family:'reasoning',prompt:'A bag has 3 red and 2 blue balls. Two draws without replacement. Probability both red? Return only the reduced fraction a/b.',expected:'3/10'},
 {id:'schedule',family:'reasoning',prompt:'Tasks A=3h, B=5h start together with separate workers. C=2h starts after both A and B. D=4h starts after A and has another worker. Earliest time all tasks finish? Return only integer hours.',expected:'7'},
 {id:'dedupe',family:'writing',prompt:'Rows: id=p,v=1,active=true; id=q,v=3,active=true; id=p,v=2,active=false; id=q,v=2,active=false. Choose highest v per id and retain active only. Return only JSON array of sorted IDs.',expected:['q']},
 {id:'boolean',family:'coding',prompt:'Python: bool("0"), bool([]), (0 == False), (0 is False). Return only JSON array of these four booleans.',expected:[true,false,true,false]}
];
const models=['z-ai/glm-5.3-flash','qwen/qwen3.8-flash','deepseek/deepseek-v4.1-flash','google/gemini-2.5-flash-lite'];
fs.writeFileSync(output+'.cases.json',JSON.stringify(cases,null,2));
const canon=(x:any):any=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
for(const c of cases){let observation={};let selected:string|undefined;const start=Date.now();let error;
try{selected=await jevSelect({messages:[{role:'user',content:c.prompt}]},models.map(m=>'openrouter:'+m),undefined,fetch,u=>observation=u);}catch(e){error=(e as Error).message;}
fs.appendFileSync(output,JSON.stringify({kind:'decision',id:c.id,selected,error,ms:Date.now()-start,...observation})+'\n');
// Every candidate sees same prompt; decision frozen before candidate outputs. No retries.
await Promise.all(models.map(async model=>{const t=Date.now();let row;
try{const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(90000),body:JSON.stringify({model,messages:[{role:'user',content:c.prompt}],max_tokens:2048,provider:{max_price:{prompt:.3,completion:1.2}}})});const d=await r.json();const text=d.choices?.[0]?.message?.content??'';let value:any=text.trim();if(typeof c.expected!=='string'){try{value=JSON.parse(text);}catch{}}const pass=r.ok&&JSON.stringify(canon(value))===JSON.stringify(canon(c.expected));row={kind:'generation',id:c.id,model,status:r.status,pass,ms:Date.now()-t,text,usage:d.usage,finish:d.choices?.[0]?.finish_reason};}catch(e){row={kind:'generation',id:c.id,model,pass:false,ms:Date.now()-t,error:(e as Error).name};}fs.appendFileSync(output,JSON.stringify(row)+'\n');console.log(c.id,model,row.pass);}));}
