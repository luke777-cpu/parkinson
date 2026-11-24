import copy
import tempfile
import unittest
from pathlib import Path
from app import Store, validate, now

class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).parent); self.store=Store(Path(self.tmp.name)/'a.db')
    def tearDown(self): self.tmp.cleanup()
    def create(self,kind='output',payload=None):
        return self.store.save({'kind':kind,'payload':payload or {'value':42,'note':''},'occurred_at':'2026-10-20T09:00:00+09:00','timezone':'+09:00'})
    def edit(self,e,**kwargs):
        return self.store.save(dict(kind=e['kind'],payload={'value':60,'note':'수정'},occurred_at=e['occurred_at'],timezone=e['timezone'],id=e['id'],expected_revision=e['revision_id'],**kwargs))
    def test_append_only_and_restart(self):
        e=self.create(); n=self.edit(e)
        self.assertEqual(n['version'],2); self.assertEqual(self.store.history(e['id'])[0],e)
        self.assertEqual(Store(self.store.path).state()['events'],[n])
    def test_stale_edit_rejected(self):
        e=self.create(); self.edit(e)
        with self.assertRaises(ValueError): self.edit(e)
    def test_roundtrip_duplicate(self):
        self.edit(self.create()); b=Store(Path(self.tmp.name)/'b.db'); doc=self.store.export()
        self.assertEqual(b.import_json(doc)['added'],2); self.assertEqual(b.import_json(doc)['duplicates'],2)
        self.assertEqual(b.export()['events'],doc['events'])
    def test_conflict_and_explicit_resolution(self):
        e=self.create(); b=Store(Path(self.tmp.name)/'b.db'); b.import_json(self.store.export())
        local=self.edit(e)
        remote=b.save(dict(kind=e['kind'],payload={'value':20,'note':''},occurred_at=e['occurred_at'],timezone=e['timezone'],id=e['id'],expected_revision=e['revision_id']))
        result=self.store.import_json(b.export()); self.assertEqual(result['conflicts'],1)
        self.assertEqual(self.store.state()['events'],[local])
        resolved=self.edit(local,resolve=[remote['revision_id']]); self.assertEqual(self.store.state()['conflicts'],[])
        self.assertEqual(len(self.store.history(e['id'])),4)
    def test_atomic_import_tampering(self):
        e=self.create(); doc=self.store.export(); doc['events'][0]['payload']['value']=1
        with self.assertRaises(ValueError): self.store.import_json(doc)
        self.assertEqual(self.store.state()['events'],[e])
    def test_no_actual_time_inference(self):
        from uuid import uuid4
        p=dict(set_id=str(uuid4()),set_revision_id=str(uuid4()),slot='아침',name='시험약',form='정제',dose='사용자 입력 1정',scheduled_at='2026-10-20T08:00:00+09:00',actual_at=None,completed=True)
        with self.assertRaises(ValueError): self.create('medication',p)
        p['actual_at']='2026-10-20T08:12:00+09:00'; e=self.create('medication',p)
        self.assertEqual(e['payload']['actual_at'],p['actual_at'])
    def test_output_does_not_create_on_off(self):
        self.create(); self.assertEqual([e['kind'] for e in self.store.state()['events']],['output'])
        for v in (-1,101,True,42.5):
            with self.assertRaises(ValueError): self.create(payload={'value':v,'note':''})
    def test_tombstone_preserves_history(self):
        e=self.create(); self.edit(e,deleted=True)
        self.assertTrue(self.store.state()['events'][0]['deleted']); self.assertEqual(len(self.store.history(e['id'])),2)
    def test_all_separate_event_tables(self):
        self.create('medication_set',{'slot':'아침','medicines':[{'name':'시험약','form':'정제','dose':'입력값','time':'08:00'}]})
        self.create('exercise',{'name':'걷기','minutes':15,'note':''})
        for k in ('dyskinesia','dystonia','freezing'): self.create(k,{'severity':'기록함','note':''})
        self.create('motor_state',{'state':'OFF','note':''}); self.create('note',{'date':'2026-10-20','text':'메모'})
        with self.store.connect() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM exercise_events').fetchone()[0],1)
    def test_missing_parent_rolls_back(self):
        self.edit(self.create()); doc=self.store.export(); doc['events']=doc['events'][1:]
        b=Store(Path(self.tmp.name)/'b.db')
        with self.assertRaises(ValueError): b.import_json(doc)
        self.assertEqual(b.export()['events'],[])
if __name__=='__main__': unittest.main(verbosity=2)
