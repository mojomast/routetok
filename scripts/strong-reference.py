import json,random,hashlib,os,subprocess,time,concurrent.futures
from pathlib import Path
from code_sandbox import execute
out=Path('docs/benchmark-results/strong-reference-v1')
def prepare():
 used=set()
 for p in Path('benchmarks/mbpp-v1').glob('*.json'):
  d=json.loads(p.read_text())
  if isinstance(d,list):used.update(c['task_id'] for c in d)
 raw=Path('/tmp/rt-mbpp.json').read_bytes();rows=[c for c in json.loads(raw) if c['task_id'] not in used];random.Random(561290).shuffle(rows);cases=rows[:6]
 for c in cases:assert execute('\n'.join(c['test_imports'])+'\n'+c['code']+'\n'+'\n'.join(c['test_list']))['pass']
 out.mkdir(parents=True,exist_ok=False);(out/'manifest.json').write_text(json.dumps({'sourceSha256':hashlib.sha256(raw).hexdigest(),'cases':cases,'models':['inception/mercury-2.5','openai/gpt-4.1'],'budget':8192,'timeoutSeconds':120,'noRetries':True,'publicResponses':True},indent=2))
def run():
 key=os.environ['OPENROUTER_API_KEY'];manifest=json.loads((out/'manifest.json').read_text())
 if (out/'results.jsonl').exists():raise RuntimeError('no overwrite')
 def call(job):
  m,c=job;start=time.monotonic();r={'model':m,'id':c['task_id'],'costUsd':None,'pass':False}
  body={'model':m,'max_tokens':8192,'messages':[{'role':'user','content':c['prompt']+'\nExample interface:\n'+c['test_list'][0]+'\nReturn only executable Python, no Markdown.'}],'provider':{'allow_fallbacks':False,'max_price':{'prompt':2,'completion':8}}}
  # curl hard wall limit; credentials supplied over stdin, not process argv.
  cfg='url = "https://openrouter.ai/api/v1/chat/completions"\nheader = "Authorization: Bearer '+key+'"\nheader = "Content-Type: application/json"\n'
  try:
   p=subprocess.run(['curl','--silent','--show-error','--max-time','120','--config','-','--data-binary',json.dumps(body)],input=cfg,text=True,capture_output=True,timeout=130)
   if p.returncode:r['error']='transport_'+str(p.returncode)
   else:
    d=json.loads(p.stdout)
    if 'error' in d:r['error']=d['error']
    else:
     ch=d['choices'][0];text=ch['message'].get('content') or '';r.update(response=text,provider=d.get('provider'),finish=ch.get('finish_reason'),usage=d.get('usage'),costUsd=d.get('usage',{}).get('cost'))
     if text.strip():
      try:compile(text,'candidate','exec');r['formatValid']=True
      except SyntaxError:r['formatValid']=False
      if r['formatValid']:r.update(execute('\n'.join(c['test_imports'])+'\n'+text+'\n'+'\n'.join(c['test_list'])))
  except Exception as e:r['error']=type(e).__name__
  r['ms']=round((time.monotonic()-start)*1000);return r
 jobs=[(m,c) for c in manifest['cases'] for m in manifest['models']]
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  for r in pool.map(call,jobs):
   with (out/'results.jsonl').open('a') as f:f.write(json.dumps(r)+'\n');f.flush();os.fsync(f.fileno())
   print(r['model'],r['id'],r['pass'],r.get('error'),flush=True)
if __name__=='__main__':
 import sys
 prepare() if '--prepare' in sys.argv else run()
