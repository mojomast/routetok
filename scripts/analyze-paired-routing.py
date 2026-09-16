import json,sys,math
rows=[json.loads(x) for x in open(sys.argv[1])]
decisions=[r for r in rows if r['kind']=='decision'];gens=[r for r in rows if r['kind']=='generation'];models=sorted({r['model'] for r in gens});n=len(decisions)
chosen=[]
for d in decisions:
 chosen.append(next((r for r in gens if r['id']==d['id'] and 'openrouter:'+r['model']==d.get('selected')),{'pass':False,'usage':{},'ms':0}))
def summarize(rs):
 known=[r['usage']['cost'] for r in rs if isinstance(r.get('usage',{}).get('cost'),(int,float))]
 return {'passes':sum(r['pass'] for r in rs),'n':len(rs),'reportedDownstreamUsd':sum(known) if len(known)==len(rs) else None,'knownReportedUsd':sum(known),'missingBills':len(rs)-len(known)}
baseline=[r for r in gens if r['model']=='deepseek/deepseek-v4.1-flash']
losses=sum(b['pass'] and not c['pass'] for b,c in zip(sorted(baseline,key=lambda x:x['id']),[c for _,c in sorted(zip([d['id'] for d in decisions],chosen))]))
a=summarize(chosen);b=summarize(baseline)
report={'routerReplay':a,'models':{m:summarize([r for r in gens if r['model']==m]) for m in models},'discordantQualityLosses':losses,'zeroLossOneSided95UpperBound':1-.05**(1/n) if losses==0 else None,'netSavingsUsd':None,'grossDownstreamDifferenceUsd':b['reportedDownstreamUsd']-a['reportedDownstreamUsd'] if a['reportedDownstreamUsd'] is not None and b['reportedDownstreamUsd'] is not None else None,'totalExperimentalReportedUsd':sum(r.get('usage',{}).get('cost',0) for r in gens),'jevTokens':sum(d.get('input',0)+d.get('output',0) for d in decisions),'limitations':'Offline replay of independently executed candidates after live frozen decisions; not end-to-end latency. Unknown Jev bill. Small authored development sample, not independent representative holdout.'}
print(json.dumps(report,indent=2))
