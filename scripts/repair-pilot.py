"""Small synthetic multi-file repair pilot; hidden tests never enter model prompts."""
import json,os,sys,subprocess,time,hashlib
from pathlib import Path
from code_sandbox import execute
OUT=Path('docs/benchmark-results/repair-v1')
TASKS=[
 dict(id='ledger',split='development',spec='ledger.apply(events) returns balances. Events are (id, account, integer_delta). Apply only the first event for each id globally, including across accounts. Do not mutate input.',files={'state.py':'def fresh():\n return {}\n','ledger.py':'from state import fresh\ndef apply(events):\n b=fresh()\n for ident,acct,delta in events: b[acct]=b.get(acct,0)+delta\n return b\n'},visible="from ledger import apply\nassert apply([('a','x',3),('a','x',3)])=={'x':3}",hidden="from ledger import apply\nassert apply([('a','x',3),('a','y',9),('b','x',-1)])=={'x':2}\nassert apply([])=={}"),
 dict(id='query',split='development',spec='api.parse(q) parses URL query parameters using percent and plus decoding. Preserve blank values and repeated keys in order as lists. Empty input returns {}.',files={'codec.py':'from urllib.parse import parse_qsl\ndef pairs(s): return parse_qsl(s)\n','api.py':'from codec import pairs\ndef parse(q): return dict(pairs(q))\n'},visible="from api import parse\nassert parse('a=1&a=2')=={'a':['1','2']}",hidden="from api import parse\nassert parse('a=&x=hello+world&x=%2B')=={'a':[''],'x':['hello world','+']}\nassert parse('')=={}"),
 dict(id='cache',split='heldout',spec='cache.Cache stores values with TTL. Constructor receives clock callable. set(key,value,ttl) expiration is clock()+ttl; get returns None at or after expiration or absent. Calls to get must not refresh expiry. Instances isolated. None and falsey values allowed.',files={'clockutil.py':'def expired(now,deadline): return now>deadline\n','cache.py':'from clockutil import expired\nclass Cache:\n data={}\n def __init__(self,clock): self.clock=clock\n def set(self,k,v,ttl): self.data[k]=(v,self.clock()+ttl)\n def get(self,k):\n  if k not in self.data: return None\n  v,end=self.data[k]\n  if expired(self.clock(),end): return None\n  return v\n'},visible="from cache import Cache\nt=[0];c=Cache(lambda:t[0]);c.set('x',7,2);t[0]=2;assert c.get('x') is None",hidden="from cache import Cache\nt=[0];a=Cache(lambda:t[0]);b=Cache(lambda:t[0]);a.set('x',False,3);assert b.get('x') is None;assert a.get('x') is False;t[0]=2;assert a.get('x') is False;t[0]=3;assert a.get('x') is None"),
 dict(id='interval',split='heldout',spec='api.merge(intervals) returns sorted merged half-open integer intervals. Discard empty intervals where start==end. Overlapping OR touching intervals coalesce. Raise ValueError for any start>end. Do not mutate input. Return list of tuples.',files={'checks.py':'def valid(a,b): return a<=b\n','api.py':'from checks import valid\ndef merge(items):\n items.sort()\n out=[]\n for a,b in items:\n  if not valid(a,b): continue\n  if out and a<out[-1][1]: out[-1]=(out[-1][0],b)\n  else: out.append((a,b))\n return out\n'},visible="from api import merge\nassert merge([(1,3),(3,5)])==[(1,5)]",hidden="from api import merge\nx=[(4,5),(1,10),(2,3),(8,8)];old=x[:];assert merge(x)==[(1,10)];assert x==old\ntry: merge([(4,2)])\nexcept ValueError: pass\nelse: raise AssertionError('invalid interval accepted')")]
def validate(files,tests):
 setup='import os,sys,json\nos.chdir("/tmp");sys.path.insert(0,"/tmp")\n'
 setup+='files=json.loads('+repr(json.dumps(files))+')\nfor name,text in files.items():\n with open(name,"w") as f: f.write(text)\n'
 return execute(setup+'\n'+tests)['pass']
def request(model,task,previous=None):
 prompt=task['spec']+'\nProject files:\n'+json.dumps(task['files'])+'\nApplication tests:\n'+task['visible']+'\nReturn a JSON object mapping every original filename to complete corrected Python source. No Markdown. No extra files.'
 if previous:prompt+='\nPrevious attempt failed application validation; repair it:\n'+previous[:20000]
 body={'model':model,'max_tokens':8192,'messages':[{'role':'user','content':prompt}],'provider':{'allow_fallbacks':False,'max_price':{'prompt':1,'completion':4}}}
 cfg='url = "https://openrouter.ai/api/v1/chat/completions"\nheader = "Authorization: Bearer '+os.environ['OPENROUTER_API_KEY']+'"\nheader = "Content-Type: application/json"\n'
 r={'model':model,'costUsd':None,'applicationPass':False};start=time.monotonic()
 try:
  p=subprocess.run(['curl','-sS','--max-time','120','--config','-','--data-binary',json.dumps(body)],input=cfg,text=True,capture_output=True,timeout=130)
  if p.returncode:raise RuntimeError('transport_'+str(p.returncode))
  d=json.loads(p.stdout)
  if 'error' in d:r['error']=d['error'];return r
  ch=d['choices'][0];text=ch['message'].get('content') or '';r.update(response=text,finish=ch.get('finish_reason'),usage=d.get('usage'),costUsd=d.get('usage',{}).get('cost'),provider=d.get('provider'))
  files=json.loads(text)
  if not isinstance(files,dict) or set(files)!=set(task['files']) or not all(isinstance(v,str) for v in files.values()):raise ValueError('invalid files')
  r['files']=files;r['applicationPass']=validate(files,task['visible'])
 except Exception as e:r['error']=type(e).__name__
 r['ms']=round((time.monotonic()-start)*1000);return r
if __name__=='__main__':
 if '--prepare' in sys.argv:
  OUT.mkdir(parents=True,exist_ok=False)
  for t in TASKS:assert not validate(t['files'],t['visible']),t['id']
  (OUT/'manifest.json').write_text(json.dumps({'tasks':TASKS,'policies':['mercury','gemini','cascade'],'repeats':1,'synthetic':True,'budget':8192,'hiddenTestsTriggerRetry':False},indent=2));print('broken baselines fail application tests');sys.exit()
 if (OUT/'results.jsonl').exists():raise RuntimeError('fresh journal required')
 for t in TASKS:
  for policy in ['mercury','gemini','cascade']:
   model='google/gemini-3.8-flash' if policy=='gemini' else 'inception/mercury-2.5';a=request(model,t);attempts=[a]
   if policy=='cascade' and not a['applicationPass'] and a['costUsd'] is not None:attempts.append(request('google/gemini-3.8-flash',t,a.get('response')))
   final=attempts[-1];hidden=validate(final['files'],t['hidden']) if 'files' in final else False
   row={'task':t['id'],'split':t['split'],'policy':policy,'attempts':attempts,'pass':final['applicationPass'] and hidden,'hiddenPass':hidden}
   with (OUT/'results.jsonl').open('a') as f:f.write(json.dumps(row)+'\n');f.flush();os.fsync(f.fileno())
   print(t['id'],policy,row['pass'],len(attempts),flush=True)
