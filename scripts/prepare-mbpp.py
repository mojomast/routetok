import hashlib,json,random
from pathlib import Path
raw=Path('/tmp/mbpp-sanitized.json').read_bytes();rows=json.loads(raw);random.Random(314159).shuffle(rows);out=Path('benchmarks/mbpp-v1');out.mkdir(parents=True,exist_ok=True)
manifest={'source':'https://github.com/google-research/google-research/tree/master/mbpp','sourceSha256':hashlib.sha256(raw).hexdigest(),'seed':314159,'limitations':'Public dataset; possible model contamination; source-overlapping but row-disjoint development and heldout.'}
for split,selected in [('development',rows[:4]),('heldout',rows[4:12])]:
 (out/(split+'.json')).write_text(json.dumps(selected,indent=2));manifest[split]=[r['task_id'] for r in selected]
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest))
