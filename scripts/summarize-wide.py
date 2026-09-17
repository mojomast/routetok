import json,sys,statistics
rows=[json.loads(s) for s in open(sys.argv[1])]
report=[]
for model in dict.fromkeys(r['model'] for r in rows):
 rs=[r for r in rows if r['model']==model];costs=[r.get('usage',{}).get('cost') for r in rs];known=[x for x in costs if isinstance(x,(float,int))];ok=[r for r in rs if r.get('status')==200]
 report.append({'model':model,'attempts':len(rs),'strictPasses':sum(r['pass'] for r in rs),'caseInsensitiveTranslationPasses':sum(r['pass'] or (r['id']=='unicode' and r.get('status')==200 and r.get('text','').strip().lower()=='good night') for r in rs),'http200':len(ok),'rateLimited':sum(r.get('status')==429 for r in rs),'knownReportedUsd':sum(known),'missingUsage':len(rs)-len(known),'medianHttp200Ms':statistics.median(r['ms'] for r in ok) if ok else None})
print(json.dumps(report,indent=2))
