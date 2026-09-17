import json,hashlib,random
from pathlib import Path
raw=Path('/tmp/gsm8k-test.jsonl').read_bytes();rows=[json.loads(s) for s in raw.splitlines()];ids=list(range(len(rows)));random.Random(726193).shuffle(ids)
out=Path('benchmarks/gsm8k-v1');out.mkdir(parents=True,exist_ok=True)
manifest={'source':'https://github.com/openai/grade-school-math','sourceSha256':hashlib.sha256(raw).hexdigest(),'seed':726193,'sampling':'24 unique test-set rows, first 8 development and next 16 heldout; frozen before inference','limitations':'Public benchmark contamination possible; arithmetic domain only. No claims of source-disjointness within GSM8K. Separate rows, not paraphrase variants.'}
for name,selected in [('development',ids[:8]),('heldout',ids[8:24])]:
 cases=[]
 for i in selected:
  r=rows[i];expected=r['answer'].split('####')[-1].strip().replace(',','')
  cases.append({'id':f'gsm8k-test-{i}','prompt':r['question']+'\nReturn only the final numeric answer, without units, commas, or explanation.','expected':expected})
 data=json.dumps(cases,indent=2);(out/(name+'.json')).write_text(data);manifest[name]={'ids':selected,'sha256':hashlib.sha256(data.encode()).hexdigest()}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2));(out/'LICENSE').write_bytes(Path('/tmp/gsm8k-license').read_bytes());print(json.dumps(manifest,indent=2))
