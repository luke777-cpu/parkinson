import copy
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path
from uuid import uuid4
from app import Store

class DailyMedicationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.store=Store(Path(self.temp.name)/'life.db')
        self.today=date.today().isoformat()
        self.tomorrow=(date.today()+timedelta(days=1)).isoformat()
        self.later=(date.today()+timedelta(days=2)).isoformat()
    def tearDown(self): self.temp.cleanup()
    def save(self,kind,payload,old=None,deleted=False):
        occurred=payload.get('actual_at') or payload.get('scheduled_at') or self.today+'T00:00:00+09:00'
        return self.store.save(dict(kind=kind,payload=payload,occurred_at=occurred,timezone=occurred[-6:],id=old['id'] if old else None,expected_revision=old['revision_id'] if old else None,deleted=deleted))
    def make_set(self):
        return self.save('medication_set',{'slot':'아침','effective_date':self.today,'enabled':True,'medicines':[{'medicine_id':str(uuid4()),'name':'가상 시험약','form':'정제','dose':'예정 입력값','time':'08:00'}]})
    def plan(self,day=None): return self.store.day(day or self.today,'+09:00')['plans'][0]
    def record_payload(self,plan,status='taken'):
        return dict({k:v for k,v in plan.items() if k!='record'},status=status,dose='직접 입력' if status=='taken' else None,actual_at=plan['scheduled_at'][:10]+'T08:13:00+09:00' if status=='taken' else None,note='시험')
    def test_future_effective_date_preserves_today_and_plan_id(self):
        e=self.make_set(); before=self.plan(); p=copy.deepcopy(e['payload']); p['effective_date']=self.tomorrow;p['medicines'][0]['dose']='내일부터 변경';n=self.save('medication_set',p,e)
        self.assertEqual(self.plan()['planned_dose'],'예정 입력값')
        self.assertEqual(self.plan()['set_revision_id'],e['revision_id'])
        self.assertEqual(self.plan()['plan_id'],before['plan_id'])
        self.assertEqual(self.plan(self.tomorrow)['set_revision_id'],n['revision_id'])
        self.assertEqual(self.plan(self.tomorrow)['planned_dose'],'내일부터 변경')
    def test_missing_is_not_not_taken(self):
        self.make_set(); plan=self.plan();self.assertNotIn('record',plan)
        self.assertEqual([e for e in self.store.state()['events'] if e['kind']=='medication'],[])
    def test_explicit_not_taken_has_no_inferred_dose_or_time(self):
        self.make_set();e=self.save('medication',self.record_payload(self.plan(),'not_taken'))
        self.assertIsNone(e['payload']['dose']);self.assertIsNone(e['payload']['actual_at'])
    def test_taken_needs_actual_fields(self):
        self.make_set(); p=self.record_payload(self.plan());p['dose']=''
        with self.assertRaises(ValueError): self.save('medication',p)
        p['dose']='직접 입력';p['actual_at']=None
        with self.assertRaises(ValueError): self.save('medication',p)
    def test_retry_duplicate_rejected(self):
        self.make_set();p=self.record_payload(self.plan());self.save('medication',p)
        with self.assertRaises(ValueError): self.save('medication',p)
        self.assertEqual(len([e for e in self.store.state()['events'] if e['kind']=='medication']),1)
    def test_change_cannot_rewrite_recorded_day(self):
        e=self.make_set();self.save('medication',self.record_payload(self.plan()));p=copy.deepcopy(e['payload']);p['medicines'][0]['dose']='변경'
        with self.assertRaises(ValueError): self.save('medication_set',p,e)
        p['effective_date']=self.tomorrow;self.save('medication_set',p,e)
        self.assertEqual(self.plan()['planned_dose'],'예정 입력값')
    def test_stop_effective_date(self):
        e=self.make_set();p=copy.deepcopy(e['payload']);p.update(effective_date=self.tomorrow,enabled=False);self.save('medication_set',p,e)
        self.assertEqual(len(self.store.day(self.today,'+09:00')['plans']),1)
        self.assertEqual(self.store.day(self.tomorrow,'+09:00')['plans'],[])
    def test_edit_cancel_and_rerecord_preserve_history(self):
        self.make_set();p=self.record_payload(self.plan());e=self.save('medication',p)
        p['actual_at']=self.today+'T08:15:00+09:00';n=self.save('medication',p,e)
        deleted=self.save('medication',p,n,deleted=True)
        self.assertTrue(self.plan()['record']['deleted'])
        restored=self.save('medication',self.record_payload(self.plan(),'not_taken'),deleted)
        self.assertEqual(restored['version'],4);self.assertEqual(self.store.history(e['id'])[0],e)
    def test_v02_roundtrip_includes_schedule(self):
        self.make_set();self.save('medication',self.record_payload(self.plan()))
        doc=self.store.export();other=Store(Path(self.temp.name)/'other.db');other.import_json(doc)
        self.assertEqual(other.day(self.today,'+09:00'),self.store.day(self.today,'+09:00'))
        self.assertEqual(other.import_json(doc)['added'],0)
    def test_upgrade_backup_preserves_original_revisions(self):
        e=self.make_set()
        with closing(sqlite3.connect(self.store.path)) as c:c.execute('PRAGMA user_version=1')
        upgraded=Store(self.store.path);backups=list(Path(self.temp.name).glob('life-before-v02-*.db'))
        self.assertEqual(len(backups),1);self.assertEqual(upgraded.history(e['id']),[e])
        with closing(sqlite3.connect(backups[0])) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],1)
            self.assertEqual(c.execute('SELECT count(*) FROM revisions').fetchone()[0],1)
        Store(self.store.path);self.assertEqual(len(list(Path(self.temp.name).glob('life-before-v02-*.db'))),1)
    def test_legacy_incomplete_is_preserved(self):
        e=self.save('medication_set',{'slot':'아침','medicines':[{'name':'기존 약','form':'정제','dose':'원래 입력','time':'08:00'}]})
        plan=self.plan();p=dict(set_id=e['id'],set_revision_id=e['revision_id'],slot='아침',name='기존 약',form='정제',dose='원래 입력',scheduled_at=plan['scheduled_at'],actual_at=None,completed=False)
        self.save('medication',p);day=self.store.day(self.today,'+09:00')
        self.assertFalse(day['legacy'][0]['payload']['completed']);self.assertNotIn('status',day['legacy'][0]['payload'])
        with self.assertRaises(ValueError):self.save('medication',self.record_payload(plan))
    def test_new_set_does_not_appear_in_past(self):
        self.make_set();yesterday=(date.today()-timedelta(days=1)).isoformat()
        self.assertEqual(self.store.day(yesterday,'+09:00')['plans'],[])
    def test_reading_daily_plan_does_not_create_medication_events(self):
        self.make_set();before=self.store.export()['events'];self.plan();self.plan(self.tomorrow)
        self.assertEqual(self.store.export()['events'],before)
    def test_stale_plan_rejected_after_same_day_edit(self):
        e=self.make_set();p=self.record_payload(self.plan());new=copy.deepcopy(e['payload']);new['medicines'][0]['time']='09:00';self.save('medication_set',new,e)
        with self.assertRaises(ValueError):self.save('medication',p)

if __name__=='__main__':unittest.main(verbosity=2)
