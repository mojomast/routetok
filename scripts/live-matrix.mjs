import fs from 'node:fs';
const out=process.env.BENCH_OUTPUT;if(!out)throw Error('BENCH_OUTPUT required');
const key=process.env.OPENROUTER_API_KEY;if(!key)throw Error('OPENROUTER_API_KEY required');
const models=['google/gemini-2.5-flash-lite','openai/gpt-4.1-nano','deepseek/deepseek-v4.1-flash','deepseek/deepseek-v4-flash-0731'];
const catalog=await(await fetch('https://openrouter.ai/api/v1/models')).json();
for(const id of models){const m=catalog.data.find(m=>m.id===id);if(!m||Number(m.pricing.prompt)>.0000003||Number(m.pricing.completion)>.0000012)throw Error('price ceiling '+id);}
const cases=[
['extract','Extract the email only: Contact Mira via mira@example.org.','mira@example.org'],
['extract','Return only the order ID from: Order ZX-481 ships tomorrow.','ZX-481'],
['arithmetic','Compute 19 times 7. Reply only with the integer.','133'],
['arithmetic','What is 144 divided by 12? Reply only with the integer.','12'],
['logic','All mips are green. No green things are square. Can a mip be square? Answer only no or yes.','no'],
['logic','Some cats are black. Does that imply all cats are black? Answer only no or yes.','no'],
['code-reading','Python: what is len([False, 0, None, ""])? Reply only with the integer.','4'],
['code-reading','Python: what is list(range(2, 8, 2))? Reply only with the list.','[2, 4, 6]'],
['translation','Translate Buenos días into English. Return only the translation.','good morning'],
['translation','Translate Merci into English. Return only the translation.','thank you'],
['format','Return exactly this JSON, without Markdown: {"ok":true}','{"ok":true}'],
['format','Return exactly the word READY without any other text.','READY']
].map(([family,prompt,expected],i)=>({id:String(i),split:i%2?'heldout':'development',family,prompt,expected}));
fs.writeFileSync(out+'.cases.json',JSON.stringify(cases,null,2),{flag:'wx'});
const jobs=cases.flatMap(c=>models.map(model=>({c,model}))).sort((a,b)=>((Number(a.c.id)*7+models.indexOf(a.model)*13)%53)-((Number(b.c.id)*7+models.indexOf(b.model)*13)%53));
// Hard ceilings: 48 requests, <=512 generated tokens each, server-side max price.
// Reserve $0.002 per request, <=$0.096 this run; no automatic retries.
let spend=0;let index=0;
async function worker(){while(index<jobs.length){const {c,model}=jobs[index++];const t=Date.now();let record;
try{const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model,messages:[{role:'user',content:c.prompt}],max_tokens:512,provider:{max_price:{prompt:.3,completion:1.2}}})});const data=await r.json();const text=data.choices?.[0]?.message?.content??'';const normalize=x=>x.trim().toLowerCase().replace(/[.!]$/,'');record={id:c.id,split:c.split,family:c.family,model,status:r.status,ms:Date.now()-t,text,pass:r.ok&&normalize(text)===normalize(c.expected),usage:data.usage,finish:data.choices?.[0]?.finish_reason};spend+=data.usage?.cost??0;}catch(e){record={id:c.id,model,status:0,pass:false,error:e.name};}
fs.appendFileSync(out,JSON.stringify(record)+'\n');console.log(c.id,model,record.status,record.pass);if(spend>.096)throw Error('spend stop');}}
await Promise.all([worker(),worker(),worker()]);console.log(JSON.stringify({reportedUsd:spend,requests:jobs.length}));
