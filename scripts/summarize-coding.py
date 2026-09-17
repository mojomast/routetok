import json,sys,statistics
rows=[json.loads(s) for s in open(sys.argv[1])];models=sorted({r['model'] for r in rows});report=[]
for m in models:
 rs=[r for r in rows if r['model']==m];known=[r['costUsd'] for r in rs if r['costUsd'] is not None];wins=[]
 for r in rs:
  if r['pass'] and any(o['id']==r['id'] and o['model']!=m and o.get('status')==200 and not o['pass'] for o in rows):wins.append(r['id'])
 report.append({'model':m,'attempts':len(rs),'passed':sum(r['pass'] for r in rs),'http200':sum(r.get('status')==200 for r in rs),'knownCostUsd':sum(known),'missingBills':len(rs)-len(known),'medianMs':statistics.median(r['ms'] for r in rs),'observedWinsAgainstCompletedFailures':wins})
print(json.dumps({'models':report,'routingPromotion':'blocked: single-draw small sample; no reproducible specialist evidence. Availability failures excluded from specialist-win labels.'},indent=2))
