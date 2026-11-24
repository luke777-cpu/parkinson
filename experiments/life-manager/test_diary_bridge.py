import unittest,tempfile,copy
from pathlib import Path
from app import Store
from diary_bridge import DiaryBridge

def document():return {'events':[{'id':'legacy-1','type':'state','state':'on','output':60,'ts':1792627200000,'memo':'원본 <메모>','custom':{'a':1}},{'id':'med-1','type':'med','drug':'가상 약','dose':None,'ts':1792627200000,'assumed':True}], 'meds':[],'settings':{'seen':True},'unknown_root':{'future':1}}
class DiaryBridgeTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.store=Store(Path(self.tmp.name)/'life.db',maintenance=False);self.bridge=DiaryBridge(self.store)
 def tearDown(self):self.tmp.cleanup()
 def seed(self):return self.bridge.save({'document':document(),'expected_revision':None})
 def sync(self):return self.bridge.sync({'expected_revision':self.bridge.load()['revision']})
 def output(self):return next(e for e in self.store.state()['events'] if e['kind']=='output')
 def edit(self,value):
  e=self.output();return self.store.save({'id':e['id'],'expected_revision':e['revision_id'],'kind':'output','payload':{'value':value,'note':'수정'},'occurred_at':e['occurred_at'],'timezone':e['timezone']})
 def test_snapshot_preserves_unknown_and_history(self):
  a=self.seed();doc=copy.deepcopy(a['document']);doc['events'][0]['memo']='수정';self.bridge.save({'document':doc,'expected_revision':a['revision']});self.assertEqual(self.bridge.history()[0]['document'],document());self.assertEqual(len(self.bridge.history()),2)
 def test_stale_save_rejected(self):
  self.seed()
  with self.assertRaises(ValueError):self.bridge.save({'document':document(),'expected_revision':None})
 def test_source_output_only_and_idempotent(self):
  self.seed();self.assertEqual(self.sync()['added'],1);self.assertEqual(self.sync()['added'],0);self.assertEqual(len(self.store.state()['events']),1);self.assertEqual(self.bridge.load()['document'],document())
 def test_diary_edit_adds_revision(self):
  self.seed();self.sync();a=self.bridge.load();a['document']['events'][0]['output']=70;self.bridge.save({'document':a['document'],'expected_revision':a['revision']});self.sync();self.assertEqual(self.output()['version'],2);self.assertEqual(self.output()['payload']['value'],70)
 def test_plm_edit_returns_to_diary(self):
  self.seed();self.sync();self.edit(80);self.sync();self.assertEqual(self.bridge.load()['document']['events'][0]['output'],80);self.assertEqual(self.bridge.load()['document']['events'][0]['custom'],{'a':1})
 def test_both_edit_conflict_rolls_back(self):
  self.seed();self.sync();self.edit(80);a=self.bridge.load();a['document']['events'][0]['output']=90;self.bridge.save({'document':a['document'],'expected_revision':a['revision']});before=self.bridge.load()
  with self.assertRaises(ValueError):self.sync()
  self.assertEqual(self.bridge.load(),before);self.assertEqual(self.output()['payload']['value'],80)
 def test_new_plm_output_has_no_inferred_state(self):
  self.bridge.save({'document':{'events':[]},'expected_revision':None});self.store.save({'kind':'output','payload':{'value':50,'note':''},'occurred_at':'2026-10-22T12:00:00+09:00','timezone':'+09:00'});self.sync();e=self.bridge.load()['document']['events'][0];self.assertEqual(e['state'],'unknown');self.assertIsNone(e['trend']);self.assertEqual(self.sync()['pulled'],0)
 def test_deletion_not_propagated_or_resurrected(self):
  self.seed();self.sync();a=self.bridge.load();a['document']['events']=[];self.bridge.save({'document':a['document'],'expected_revision':a['revision']});self.sync();self.assertEqual(self.bridge.load()['document']['events'],[]);self.assertFalse(self.output()['deleted'])
 def test_duplicate_source_id_rejected(self):
  d=document();d['events'].append(copy.deepcopy(d['events'][0]))
  with self.assertRaises(ValueError):self.bridge.save({'document':d,'expected_revision':None})
 def test_null_output_not_zero_and_state_not_converted(self):
  d=document();d['events'][0]['output']=None;self.bridge.save({'document':d,'expected_revision':None});self.sync();self.assertEqual(self.store.state()['events'],[])
if __name__=='__main__':unittest.main()
