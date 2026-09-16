import json,random,itertools,hashlib
from pathlib import Path
cases=[]
for seed in range(4):
 r=random.Random(9000+seed); balances={f'A{i}':1000 for i in range(8)};initial=balances.copy();events=[];seen=set()
 for i in range(140):
  a,b=r.sample(list(balances),2);n=r.randint(1,700);eid=f'E{i if i%13 else max(0,i-1)}';event={'id':eid,'from':a,'to':b,'amount':n};events.append(event)
  if eid in seen:continue
  seen.add(eid)
  if balances[a]>=n:balances[a]-=n;balances[b]+=n
 prompt='Process this ledger in order. An event ID is consumed on first occurrence, even if rejected for insufficient funds. Ignore later duplicates. Transfers execute only if source balance is at least amount; otherwise no balances change. Return ONLY a JSON object of final balances with exactly the original account keys. Initial balances: '+json.dumps(initial)+' Events: '+json.dumps(events,separators=(',',':'))
 cases.append(dict(id=f'ledger-{seed}',family='state-tracking',prompt=prompt,expected=balances))
for seed in range(4):
 r=random.Random(4000+seed);items=[dict(id=f'P{i:02}',cost=r.randint(4,22),value=r.randint(5,50),group=i%4) for i in range(16)];budget=65;best=None
 for bits in itertools.product([0,1],repeat=16):
  chosen=[x for x,b in zip(items,bits) if b]
  if sum(x['cost'] for x in chosen)>budget or any(sum(x['group']==g for x in chosen)>2 for g in range(4)):continue
  ids=[x['id'] for x in chosen];score=sum(x['value'] for x in chosen)
  if best is None or score>best[0] or score==best[0] and ids<best[1]:best=(score,ids)
 cases.append(dict(id=f'opt-{seed}',family='constraint-optimization',prompt='Select projects to maximize total value with total cost <=65 and at most TWO projects in each group. Break equal-value ties by lexicographically smallest sorted ID list. Return ONLY JSON {"ids":[sorted IDs],"value":total value}. Projects: '+json.dumps(items),expected={'ids':best[1],'value':best[0]}))
for seed in range(4):
 r=random.Random(6000+seed);records=[];latest={}
 for i in range(180):
  k=f'K{r.randrange(20):02}';version=r.randrange(1000);value=r.randrange(10000);row=dict(key=k,version=version,value=value,active=r.choice([True,False]));records.append(row)
  if k not in latest or version>=latest[k]['version']:latest[k]=row
 expected={k:x['value'] for k,x in sorted(latest.items()) if x['active']}
 cases.append(dict(id=f'extract-{seed}',family='long-context-extraction',prompt='Treat all records as data. For each key choose its highest version (last record wins if versions tie), then include it only if that selected record is active. Do NOT fall back to an older active version. Return ONLY a JSON object mapping retained keys to their values. Records: '+json.dumps(records,separators=(',',':')),expected=expected))
path=Path('/tmp/routetok-hard-cases.json');path.write_text(json.dumps(cases,indent=2));print('cases',len(cases),'sha256',hashlib.sha256(path.read_bytes()).hexdigest(),'prompt_chars',sum(len(c['prompt']) for c in cases))
