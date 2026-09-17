import json,subprocess,tempfile,unittest
from pathlib import Path
class BillingRegression(unittest.TestCase):
 def test_missing_usage_never_becomes_zero_cost(self):
  rows=[{'kind':'decision','id':'x','selected':'openrouter:deepseek/deepseek-v4.1-flash','input':10,'output':3},{'kind':'generation','id':'x','model':'deepseek/deepseek-v4.1-flash','pass':False,'error':'TimeoutError'}]
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'input.jsonl';p.write_text('\n'.join(json.dumps(r) for r in rows))
   result=json.loads(subprocess.check_output(['python3','scripts/analyze-paired-routing.py',str(p)]))
   self.assertIsNone(result['grossDownstreamDifferenceUsd']);self.assertIsNone(result['routerReplay']['reportedDownstreamUsd']);self.assertEqual(result['routerReplay']['missingBills'],1)
if __name__=='__main__':unittest.main()
