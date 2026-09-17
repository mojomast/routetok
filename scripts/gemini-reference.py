"""Add Gemini to the frozen six-task comparison without altering prior results."""
import runpy,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
ns=runpy.run_path(str(Path(__file__).with_name('strong-reference.py')))
out=Path('docs/benchmark-results/gemini-reference-v1')
if '--prepare' in sys.argv:
 out.mkdir(parents=True,exist_ok=False)
 manifest=json.loads(Path('docs/benchmark-results/strong-reference-v1/manifest.json').read_text())
 manifest['models']=['google/gemini-3.8-flash'];manifest['note']='Same inspected six tasks; incremental comparison, not new holdout.'
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2))
else:
 ns['run'].__globals__['out']=out
 ns['run']()
