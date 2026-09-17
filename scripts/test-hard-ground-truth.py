import json,unittest
from pathlib import Path
class GroundTruth(unittest.TestCase):
 def test_invariants(self):
  cases=json.loads(Path('/tmp/routetok-hard-cases.json').read_text())
  for c in cases:
   if c['family']=='state-tracking':
    self.assertEqual(sum(c['expected'].values()),8000)
    self.assertTrue(all(x>=0 for x in c['expected'].values()))
   elif c['family']=='constraint-optimization':
    items=json.loads(c['prompt'].split('Projects: ')[1]); states={(0,(0,0,0,0)):0}
    for x in items:
     for (cost,counts),value in list(states.items()):
      if cost+x['cost']<=65 and counts[x['group']]<2:
       counts=list(counts);counts[x['group']]+=1;k=(cost+x['cost'],tuple(counts))
       states[k]=max(states.get(k,0),value+x['value'])
    self.assertEqual(max(states.values()),c['expected']['value'])
if __name__=='__main__':unittest.main()
