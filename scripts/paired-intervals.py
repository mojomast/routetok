import json,sys,random,statistics
rows=[json.loads(s) for s in open(sys.argv[1])];latest=list({r['key']:r for r in rows}.values());models=sorted({r['model'] for r in latest});base='openrouter:deepseek/deepseek-v4.1-flash';index={(r['model'],r['id']):r for r in latest};ids=sorted({r['id'] for r in latest});result=[]
for model in models:
 pairs=[(index[(model,i)],index[(base,i)]) for i in ids];diff=[int(a['pass'])-int(b['pass']) for a,b in pairs];complete=all(a['costUsd'] is not None and b['costUsd'] is not None for a,b in pairs)
 row={'model':model,'tasks':len(pairs),'qualityDifference':statistics.mean(diff),'lossesVsReference':sum(d<0 for d in diff),'gainsVsReference':sum(d>0 for d in diff),'costDifferenceUsd':None,'pairedBootstrap95CostDifferenceUsd':None,'zeroLossUpper95':1-.05**(1/len(diff)) if all(d>=0 for d in diff) else None}
 if complete:
  costs=[b['costUsd']-a['costUsd'] for a,b in pairs];rng=random.Random(614);boot=sorted(sum(rng.choices(costs,k=len(costs))) for _ in range(10000));row.update(costDifferenceUsd=sum(costs),pairedBootstrap95CostDifferenceUsd=[boot[249],boot[9749]])
 result.append(row)
print(json.dumps({'comparisons':result,'limitations':'Paired task bootstrap exploratory small sample; no multiple-comparison correction; public arithmetic only. Zero-loss bound assumes independent representative pairs, not general workload proof.'},indent=2))
