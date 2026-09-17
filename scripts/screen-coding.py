import json,os,sys,urllib.request,urllib.error,time,concurrent.futures,random,threading
from pathlib import Path
from code_sandbox import execute
split=sys.argv[1];out=Path(sys.argv[2]);key=os.environ['OPENROUTER_API_KEY']
if out.exists():raise RuntimeError('fresh output required')
cases=json.loads(Path('benchmarks/mbpp-v1/'+split+'.json').read_text())
models=['inception/mercury-2.5','qwen/qwen3.8-flash','deepseek/deepseek-v4.1-flash','qwen/qwen3-coder-30b-a3b-instruct']
for c in cases:
 assert execute('\n'.join(c['test_imports'])+'\n'+c['code']+'\n'+'\n'.join(c['test_list']))['pass'],('invalid reference',c['task_id'])
jobs=[(m,c) for m in models for c in cases];random.Random(192).shuffle(jobs);lock=threading.Lock()
def run(job):
 m,c=job;t=time.monotonic();row={'model':m,'id':c['task_id'],'split':split,'pass':False,'costUsd':None}
 prompt=c['prompt']+'\nRequired example assertion (defines interface):\n'+c['test_list'][0]+'\nReturn only executable Python code, no Markdown or prose.'
 try:
  payload={'model':m,'messages':[{'role':'user','content':prompt}],'max_tokens':8192,'provider':{'allow_fallbacks':False,'max_price':{'prompt':.15,'completion':.6}}}
  req=urllib.request.Request('https://openrouter.ai/api/v1/chat/completions',data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
  with urllib.request.urlopen(req,timeout=180) as res:data=json.load(res)
  text=data.get('choices',[{}])[0].get('message',{}).get('content','') or '';row.update(status=200,finish=data.get('choices',[{}])[0].get('finish_reason'),usage=data.get('usage'),response=text,costUsd=data.get('usage',{}).get('cost'))
  # Public benchmark-only explicit response retention. No markdown repair.
  valid=True
  try:compile(text,'<candidate>','exec')
  except SyntaxError:valid=False
  row['formatValid']=valid
  if valid:row.update(execute('\n'.join(c['test_imports'])+'\n'+text+'\n'+'\n'.join(c['test_list'])))
 except urllib.error.HTTPError as e:row.update(status=e.code,error='http')
 except Exception as e:row['error']=type(e).__name__
 row['ms']=round((time.monotonic()-t)*1000)
 with lock:
  with out.open('a') as f:f.write(json.dumps(row)+'\n')
  print(m,c['task_id'],row['pass'],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(run,jobs))
