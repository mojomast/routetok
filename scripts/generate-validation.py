import json,hashlib,itertools
from pathlib import Path
cases=[]
for seed in range(3):
 n=seed+4
 cases.append(dict(id=f'ledger-{seed}',family='state',prompt=f'Account starts with {n*31} units. Events in order: id=a deposit 17; id=b withdraw 9; id=a deposit 17; id=c withdraw 6. Apply each distinct event ID only once. Return only the final integer balance.',expected=str(n*31+2)))
 items=[(f'P{i}',(i*3+n)%7+2,(i*7+n)%13+1) for i in range(5)]
 opts=[]
 for bits in itertools.product([0,1],repeat=5):
  cost=sum(x[1]*b for x,b in zip(items,bits));value=sum(x[2]*b for x,b in zip(items,bits));ids=[x[0] for x,b in zip(items,bits) if b]
  if cost<=11:opts.append((-value,cost,ids))
 best=min(opts)
 cases.append(dict(id=f'optimization-{seed}',family='optimization',prompt=f'Projects (id,cost,value): {json.dumps(items)}. Budget 11. Select each at most once to maximize total value, then minimize cost, then choose lexicographically smallest sorted ID list. Return only JSON array of selected IDs.',expected=best[2]))
 records=[dict(id=f'k{i%9}',version=i//9,value=(i*13+n)%101) for i in range(90)]
 target=f'k{seed+1}';expected=[r for r in records if r['id']==target][-1]['value']
 cases.append(dict(id=f'retrieval-{seed}',family='retrieval',prompt=f'Records: {json.dumps(records)}. For {target}, return the value at its highest version. Only output the integer.',expected=str(expected)))
 cases.append(dict(id=f'code-{seed}',family='coding',prompt=f'Python: a=[{n},2]; b=[a,a.copy()]; b[0].append(7); b[1][0]=9; a.pop(1). Return only JSON for b.',expected=[[n,7],[9,2]]))
p=Path('/tmp/fresh-validation-cases.json');data=json.dumps(cases,indent=2);p.write_text(data);print('cases',len(cases),'sha256',hashlib.sha256(data.encode()).hexdigest())
