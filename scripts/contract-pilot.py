"""Public development-only contract/validator pilot. No hidden tests trigger repair."""
import argparse,json,os,urllib.request,urllib.error,time,hashlib
from pathlib import Path
from code_sandbox import execute
ROOT=Path(__file__).resolve().parents[1]
CASES=[dict(id='unset-bit',contract='Implement set_left_most_unset_bit(n) for nonnegative integers. Set the most significant zero bit WITHIN the existing binary width. If every bit is one, return n unchanged. For zero return zero.',reference='def set_left_most_unset_bit(n):\n for i in range(n.bit_length()-1,-1,-1):\n  if not n & (1<<i): return n | (1<<i)\n return n',application='assert set_left_most_unset_bit(10)==14\nassert set_left_most_unset_bit(15)==15\nassert set_left_most_unset_bit(0)==0',hidden='assert set_left_most_unset_bit(12)==14\nassert set_left_most_unset_bit(31)==31\nassert set_left_most_unset_bit(32)==48'),dict(id='ludic',contract='Implement get_ludic(n) for nonnegative integers. Return ludic numbers <=n: start with list 1..n. Keep 1. Starting at index 1, let k be that element; delete every kth subsequent element, first at index index+k, counting in the list BEFORE this deletion pass. Advance index by one and repeat until past the remaining list. For n=0 return [].',reference='def get_ludic(n):\n a=list(range(1,n+1));i=1\n while i<len(a):\n  k=a[i];a=[v for j,v in enumerate(a) if j<=i or (j-i)%k];i+=1\n return a',application='assert get_ludic(0)==[]\nassert get_ludic(1)==[1]\nassert get_ludic(10)==[1,2,3,5,7]',hidden='assert get_ludic(25)==[1,2,3,5,7,11,13,17,23,25]\nassert get_ludic(45)==[1,2,3,5,7,11,13,17,23,25,29,37,41,43]')]
def validate(code,tests):
 if not code.strip():return False
 try:compile(code,'candidate','exec')
 except SyntaxError:return False
 return execute(code+'\n'+tests)['pass']
def selftest():
 for c in CASES:
  assert validate(c['reference'],c['application'])
  assert validate(c['reference'],c['hidden'])
  assert not validate('',c['application'])
 weak='def set_left_most_unset_bit(n):\n return 14'
 assert validate(weak,'assert set_left_most_unset_bit(10)==14')
 assert not validate(weak,CASES[0]['application'])
 print('reference, hidden-score, empty-output and weak-validator regression checks passed')
def run(out):
 key=os.environ.get('OPENROUTER_API_KEY')
 if not key:raise SystemExit('Missing OPENROUTER_API_KEY; no requests dispatched')
 out.mkdir(parents=True,exist_ok=False)
 manifest={'developmentOnly':True,'cases':CASES,'policies':[['inception/mercury-2.5',8192],['qwen/qwen3.8-flash',16384]],'repeats':2,'repair':'one same-model repair after application failure only','publicResponseRetention':True,'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2))
 for repeat in range(2):
  for c in CASES:
   for model,budget in manifest['policies']:
    attempts=[];prompt=c['contract']+'\nApplication tests:\n'+c['application']+'\nReturn Python code only, no Markdown.'
    for step in range(2):
     row={'step':step,'model':model,'budget':budget,'costUsd':None};start=time.monotonic()
     try:
      payload={'model':model,'max_tokens':budget,'messages':[{'role':'user','content':prompt}],'provider':{'allow_fallbacks':False,'max_price':{'prompt':.15,'completion':.6}}}
      req=urllib.request.Request('https://openrouter.ai/api/v1/chat/completions',data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
      with urllib.request.urlopen(req,timeout=240) as response:data=json.load(response)
      choice=data['choices'][0];text=choice['message'].get('content') or '';row.update(response=text,provider=data.get('provider'),actualModel=data.get('model'),usage=data.get('usage'),finish=choice.get('finish_reason'),costUsd=data.get('usage',{}).get('cost'),applicationPass=validate(text,c['application']))
     except urllib.error.HTTPError as e:row['httpStatus']=e.code
     except Exception as e:row['error']=type(e).__name__
     row['ms']=round((time.monotonic()-start)*1000);attempts.append(row)
     with (out/'attempts.jsonl').open('a') as f:f.write(json.dumps(dict(case=c['id'],repeat=repeat,**row))+'\n');f.flush();os.fsync(f.fileno())
     if row.get('applicationPass') or row['costUsd'] is None:break
     prompt+='\nPrevious attempt failed application tests. Correct it:\n'+row.get('response','')[:24000]
    result={'case':c['id'],'repeat':repeat,'model':model,'attempts':len(attempts),'applicationPass':attempts[-1].get('applicationPass',False),'hiddenPass':validate(attempts[-1].get('response',''),c['hidden']),'knownCostUsd':sum(a['costUsd'] or 0 for a in attempts),'missingBills':sum(a['costUsd'] is None for a in attempts)}
    with (out/'results.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
    print(json.dumps(result),flush=True)
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--run',type=Path);args=parser.parse_args();selftest()
 if args.run:run(args.run)
