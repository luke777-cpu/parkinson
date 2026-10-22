import copy,tempfile,unittest
from pathlib import Path
from uuid import uuid4
from datetime import datetime,timedelta,timezone
from app import Store

def payload(start='2026-10-26T09:00:00+09:00',minutes=60,title='시험 일정',frequency='none',interval=1,weekdays=None,until=None):
    return {'title':title,'category':'개인','starts_at':start,'ends_at':(datetime.fromisoformat(start)+timedelta(minutes=minutes)).isoformat(),'all_day':False,'location':'시험 장소','note':'','recurrence':{'frequency':frequency,'interval':interval,'weekdays':weekdays or [],'until':until},'checklist':[{'id':str(uuid4()),'text':'준비물'}],'reminder_minutes':None,'prep_minutes':None}
class SchedulerTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.store=Store(Path(self.temp.name)/'life.db',maintenance=False)
    def tearDown(self):self.temp.cleanup()
    def create(self,p=None):return self.store.schedule_save({'payload':p or payload()})
    def items(self,a='2026-10-26',b='2026-11-02'):return self.store.scheduler_range(a,b,include_meds=False)['items']
    def save(self,master,p,scope='all',day=None,override=None):return self.store.schedule_save({'id':master['id'],'expected_revision':master['revision_id'],'payload':p,'scope':scope,'original_date':day,'override_revision':override})
    def cancel(self,master,scope='one',day='2026-10-26',override=None):return self.store.schedule_cancel({'id':master['id'],'expected_revision':master['revision_id'],'scope':scope,'original_date':day,'override_revision':override})
    def test_weekly_and_biweekly_selected_days(self):
        self.create(payload(frequency='weekly',weekdays=[0,2,4]));self.assertEqual(len(self.items('2026-10-26','2026-11-09')),6)
        other=self.create(payload(title='격주',frequency='weekly',interval=2,weekdays=[0,2,4]));self.assertEqual(len([x for x in self.items('2026-10-26','2026-11-09') if x['series_id']==other['id']]),3)
    def test_monthly_skips_nonexistent_date(self):
        self.create(payload('2027-01-31T09:00:00+09:00',frequency='monthly'))
        dates=[x['original_date'] for x in self.items('2027-01-01','2027-04-01')];self.assertEqual(dates,['2027-01-31','2027-03-31'])
    def test_once_moved_occurrence_enters_new_date_window(self):
        e=self.create(payload(frequency='weekly',weekdays=[0,2,4]));p=copy.deepcopy(e['payload']);p.update(starts_at='2026-10-27T11:00:00+09:00',ends_at='2026-10-27T12:00:00+09:00');self.save(e,p,'one','2026-10-26')
        self.assertEqual(self.items('2026-10-26','2026-10-27'),[])
        moved=self.items('2026-10-27','2026-10-28');self.assertEqual(len(moved),1);self.assertEqual(moved[0]['original_date'],'2026-10-26')
        self.assertEqual(len(self.items()),3)
    def test_stale_exception_edit_rejected(self):
        e=self.create();p=copy.deepcopy(e['payload']);o=self.save(e,p,'one','2026-10-26')
        with self.assertRaises(ValueError):self.save(e,p,'one','2026-10-26')
        self.save(e,p,'one','2026-10-26',o['revision_id'])
    def test_following_split_preserves_earlier_occurrence(self):
        e=self.create(payload(frequency='weekly',weekdays=[0,2,4]));p=copy.deepcopy(e['payload']);p.update(title='이후 새 일정',starts_at='2026-10-28T10:00:00+09:00',ends_at='2026-10-28T11:00:00+09:00');new=self.save(e,p,'following','2026-10-28')
        items=self.items();self.assertEqual([x['details']['title'] for x in items],['시험 일정','이후 새 일정','이후 새 일정']);self.assertEqual(items[0]['series_id'],e['id']);self.assertEqual(items[1]['series_id'],new['id']);self.assertEqual(len(self.store.history(e['id'])),2)
    def test_following_cancels_future_exceptions_without_erasing_history(self):
        e=self.create(payload(frequency='daily'));p=copy.deepcopy(e['payload']);p.update(starts_at='2026-11-01T10:00:00+09:00',ends_at='2026-11-01T11:00:00+09:00');o=self.save(e,p,'one','2026-10-29')
        self.cancel(e,'following','2026-10-28');self.assertEqual(len(self.items()),2);self.assertEqual(len(self.store.history(o['id'])),2)
    def test_single_cancel_keeps_other_repeats(self):
        e=self.create(payload(frequency='daily'));self.cancel(e);self.assertEqual(len(self.items()),6)
    def test_completed_snapshot_survives_all_edit_and_cancel(self):
        e=self.create(payload(frequency='daily'));item=self.items()[0];r=self.store.schedule_result({'series_id':e['id'],'original_date':item['original_date'],'status':'done','checked':[]})
        p=copy.deepcopy(e['payload']);p['title']='새 제목';n=self.save(e,p);self.assertEqual(self.items()[0]['details']['title'],'시험 일정');self.assertEqual(self.items()[1]['details']['title'],'새 제목')
        self.cancel(n,'all');self.assertEqual(len(self.items()),1);self.assertEqual(self.items()[0]['result']['revision_id'],r['revision_id'])
    def test_cannot_move_completed_single_occurrence(self):
        e=self.create();self.store.schedule_result({'series_id':e['id'],'original_date':'2026-10-26','status':'done','checked':[]})
        with self.assertRaises(ValueError):self.save(e,e['payload'],'one','2026-10-26')
    def test_checklist_does_not_mark_done_or_create_clinical_record(self):
        e=self.create();self.store.schedule_result({'series_id':e['id'],'original_date':'2026-10-26','status':'pending','checked':[e['payload']['checklist'][0]['id']]})
        self.assertEqual(self.items()[0]['result']['payload']['status'],'pending');self.assertFalse(any(x['kind'] in ('medication','exercise') for x in self.store.state()['events']))
    def test_explicit_clinical_link(self):
        e=self.create();clinical=self.store.save({'kind':'exercise','payload':{'name':'실제 걷기','minutes':12,'note':''},'occurred_at':'2026-10-26T10:00:00+09:00','timezone':'+09:00'})
        r=self.store.schedule_result({'series_id':e['id'],'original_date':'2026-10-26','status':'done','checked':[],'linked_event_ids':[clinical['id']]});self.assertEqual(r['payload']['linked_event_ids'],[clinical['id']]);self.assertEqual(clinical['payload']['minutes'],12)
    def test_task_placement_atomic_and_repeat_guard(self):
        task=self.store.save({'kind':'task','payload':{'title':'진료 예약','category':'진료','due':None,'note':'','checklist':[],'status':'pending','scheduled_id':None},'occurred_at':'2026-10-26T00:00:00+09:00','timezone':'+09:00'})
        body={'task_id':task['id'],'expected_revision':task['revision_id'],'payload':payload(title='진료 예약')};s=self.store.task_schedule(body)
        with self.assertRaises(ValueError):self.store.task_schedule(body)
        state=self.store.state()['events'];updated=next(x for x in state if x['id']==task['id']);self.assertEqual(updated['payload']['scheduled_id'],s['id']);self.assertEqual(len([x for x in state if x['kind']=='schedule']),1)
    def test_routine_apply_idempotency_and_original_template_unchanged(self):
        r=self.store.save({'kind':'routine','payload':{'title':'평일','items':[{'title':'독서','category':'개인','time':'10:00','minutes':20,'checklist':[]}]},'occurred_at':'2026-10-26T00:00:00+09:00','timezone':'+09:00'})
        body={'id':r['id'],'expected_revision':r['revision_id'],'date':'2026-10-26','timezone':'+09:00'};self.store.routine_apply(body)
        with self.assertRaises(ValueError):self.store.routine_apply(body)
        self.assertEqual(len(self.items()),1);self.assertEqual(self.store.history(r['id']),[r])
    def test_overlaps_and_adjacent_time_boundary(self):
        a=self.create();self.create(payload('2026-10-26T09:30:00+09:00',title='겹침'));self.create(payload('2026-10-26T10:30:00+09:00',title='다음'))
        self.assertEqual(len(self.store.scheduler_range('2026-10-26','2026-10-27',include_meds=False)['overlaps']),1)
        p=payload('2026-10-26T09:40:00+09:00');self.assertEqual(self.store.schedule_preview(p,a['id'])['overlaps'],['겹침','다음'])
    def test_all_day_multiple_dates_end_exclusive(self):
        p=payload('2026-10-26T00:00:00+09:00',minutes=2880);p['all_day']=True;self.create(p)
        self.assertEqual(len(self.items('2026-10-27','2026-10-28')),1);self.assertEqual(self.items('2026-10-28','2026-10-29'),[])
    def test_range_does_not_write_or_infer_missed(self):
        self.create();before=self.store.export()['events'];self.items('2026-12-01','2026-12-02');self.items();self.assertEqual(self.store.export()['events'],before);self.assertIsNone(self.items()[0]['result'])
    def test_restore_and_exchange_include_schedules_and_results(self):
        e=self.create(payload(frequency='daily'));self.cancel(e);backup=self.store.backup();other=Store(Path(self.temp.name)/'other.db',maintenance=False);p=other.preview_restore({'file_base64':__import__('base64').b64encode(Path(backup['path']).read_bytes()).decode()});other.restore(p['ticket']);self.assertEqual(other.scheduler_range('2026-10-26','2026-11-02',include_meds=False),self.store.scheduler_range('2026-10-26','2026-11-02',include_meds=False))
    def test_preparation_and_execution_reminders_are_separate(self):
        p=payload('2026-10-26T09:00:00+09:00');p.update(reminder_minutes=0,prep_minutes=30);self.create(p);self.store.update_settings({'schedule_reminders':True})
        a=self.store.scheduler_reminders(datetime.fromisoformat('2026-10-26T08:30:00+09:00'));self.assertEqual([x['label'] for x in a],['준비 알림']);self.store.acknowledge_reminder(a[0]['id'],a[0]['at']);b=self.store.scheduler_reminders(datetime.fromisoformat('2026-10-26T09:00:00+09:00'));self.assertEqual([x['label'] for x in b],['일정 알림']);self.assertFalse(any(x['kind']=='schedule_result' for x in self.store.state()['events']))
    def test_invalid_time_and_generic_medication_category_rejected(self):
        p=payload();p['ends_at']=p['starts_at']
        with self.assertRaises(ValueError):self.create(p)
        p=payload();p['category']='복약'
        with self.assertRaises(ValueError):self.create(p)
    def test_clear_exception_then_edit_again_uses_tombstone_revision(self):
        e=self.create();o=self.save(e,e['payload'],'one','2026-10-26');cleared=self.store.clear_exception({'id':o['id'],'expected_revision':o['revision_id']})
        item=self.items()[0];self.assertTrue(item['override']['deleted']);self.assertEqual(item['override']['revision_id'],cleared['revision_id']);self.save(e,e['payload'],'one','2026-10-26',cleared['revision_id'])
    def test_deleted_result_can_be_recorded_again(self):
        e=self.create();r=self.store.schedule_result({'series_id':e['id'],'original_date':'2026-10-26','status':'done','checked':[]});deleted=self.store.save({'kind':r['kind'],'payload':r['payload'],'id':r['id'],'expected_revision':r['revision_id'],'occurred_at':r['occurred_at'],'timezone':r['timezone'],'deleted':True})
        self.assertTrue(self.items()[0]['result']['deleted']);new=self.store.schedule_result({'series_id':e['id'],'original_date':'2026-10-26','status':'pending','checked':[],'expected_revision':deleted['revision_id']});self.assertEqual(new['version'],3)
    def test_medication_overlay_groups_set_without_actual_record(self):
        day=datetime.now().date().isoformat();meds=[{'medicine_id':str(uuid4()),'name':'가상 약 '+str(i),'form':'정제','dose':'입력값','time':'08:00'} for i in range(2)]
        self.store.save({'kind':'medication_set','payload':{'slot':'아침','effective_date':day,'enabled':True,'medicines':meds},'occurred_at':day+'T00:00:00+09:00','timezone':'+09:00'})
        items=self.store.scheduler_range(day,(datetime.fromisoformat(day)+timedelta(days=1)).date().isoformat())['items'];self.assertEqual(len(items),1);self.assertEqual(len(items[0]['medications']),2);self.assertFalse(any(e['kind']=='medication' for e in self.store.state()['events']))

if __name__=='__main__':unittest.main(verbosity=2)
