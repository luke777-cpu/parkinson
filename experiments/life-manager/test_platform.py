import base64,copy,io,json,sqlite3,tempfile,unittest
from contextlib import closing
from datetime import datetime,timedelta,timezone
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile,ZIP_DEFLATED
from app import Store

class PlatformTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.root=Path(self.temp.name);self.a=Store(self.root/'a'/'life.db',maintenance=False)
    def tearDown(self):self.temp.cleanup()
    def create(self,store=None):
        store=store or self.a;return store.save({'kind':'output','payload':{'value':40,'note':'원본'},'occurred_at':'2026-10-21T10:00:00+09:00','timezone':'+09:00'})
    def edit(self,store,e,value,resolve=None):
        return store.save({'id':e['id'],'expected_revision':e['revision_id'],'kind':e['kind'],'payload':{'value':value,'note':'수정'},'occurred_at':e['occurred_at'],'timezone':e['timezone'],'resolve':resolve or []})
    def branch(self):
        e=self.create();b=Store(self.root/'b'/'life.db',maintenance=False);b.import_json(self.a.export());a2=self.edit(self.a,e,60);b2=self.edit(b,e,20);self.a.import_json(b.export());return e,b,a2,b2
    def test_resolved_branch_converges_both_directions(self):
        e,b,a2,b2=self.branch();a3=self.edit(self.a,a2,55,[b2['revision_id']]);b.import_json(self.a.export());self.assertEqual(b.state()['conflicts'],[]);self.assertEqual(b.state()['events'],[a3]);self.a.import_json(b.export());self.assertEqual(self.a.state()['conflicts'],[])
        self.assertEqual(self.a.export()['heads'],b.export()['heads']);self.assertEqual(len(b.history(e['id'])),4)
    def test_old_branch_does_not_reopen_conflict(self):
        e,b,a2,b2=self.branch();old=b.export();self.edit(self.a,a2,55,[b2['revision_id']]);self.a.import_json(old);self.assertEqual(self.a.state()['conflicts'],[])
    def test_chained_remote_changes_advance(self):
        e=self.create();b=Store(self.root/'b'/'life.db',maintenance=False);b.import_json(self.a.export());n=self.edit(b,e,50);n=self.edit(b,n,65);self.a.import_json(b.export());self.assertEqual(self.a.state()['events'],[n]);self.assertEqual(self.a.state()['conflicts'],[])
    def test_import_conflicting_create_time_rejected_atomically(self):
        self.create();doc=self.a.export();e=copy.deepcopy(doc['events'][0]);e['revision_id']=str(uuid4());e['created_at']='2026-01-01T00:00:00+00:00';doc['events'].append(e)
        with self.assertRaises(ValueError):self.a.import_json(doc)
        self.assertEqual(len(self.a.export()['events']),1)
    def test_merge_cycle_rejected(self):
        e=self.create();n=self.edit(self.a,e,50);doc=self.a.export();doc['merge_parents']=[{'revision_id':e['revision_id'],'parent_id':n['revision_id']}]
        with self.assertRaises(ValueError):self.a.import_json(doc)
        self.assertEqual(self.a.export()['merge_parents'],[])
    def test_backup_restore_new_machine_equivalent(self):
        self.branch();backup=self.a.backup();raw=Path(backup['path']).read_bytes();b=Store(self.root/'fresh'/'life.db',maintenance=False);preview=b.preview_restore({'file_base64':base64.b64encode(raw).decode()});self.assertEqual(b.export()['events'],[]);result=b.restore(preview['ticket']);self.assertTrue(b.backup_path(result['safety_backup']).exists());self.assertEqual(b.export()['heads'],self.a.export()['heads']);self.assertEqual(b.state()['conflicts'],self.a.state()['conflicts'])
    def test_restore_preserves_newer_local_data(self):
        e=self.create();backup=self.a.backup();self.edit(self.a,e,70);preview=self.a.preview_restore({'name':backup['name']});self.a.restore(preview['ticket']);self.assertEqual(self.a.state()['events'][0]['payload']['value'],70);self.assertEqual(len(self.a.history(e['id'])),2)
    def test_restore_preview_stale_rejected(self):
        e=self.create();backup=self.a.backup();p=self.a.preview_restore({'name':backup['name']});self.edit(self.a,e,80)
        with self.assertRaises(ValueError):self.a.restore(p['ticket'])
    def test_corrupt_backup_rejected_without_data_change(self):
        self.create();backup=self.a.backup();raw=io.BytesIO()
        with ZipFile(backup['path']) as source,ZipFile(raw,'w',ZIP_DEFLATED) as dest:
            for name in source.namelist():dest.writestr(name,b'bad' if name=='snapshot.json' else source.read(name))
        with self.assertRaises(ValueError):self.a.preview_restore({'file_base64':base64.b64encode(raw.getvalue()).decode()})
        self.assertEqual(len(self.a.state()['events']),1)
    def test_backup_path_traversal_rejected(self):
        for name in ('../x.plmbackup','C:/outside.plmbackup'):
            with self.assertRaises(ValueError):self.a.backup_path(name)
    def test_auto_backup_once_daily_and_manual_current(self):
        e=self.create();self.a.auto_backup();self.a.auto_backup();self.assertEqual(len(self.a.backups()['files']),2);n=self.edit(self.a,e,70);self.a.auto_backup()
        with ZipFile(self.a.backup_path('latest-auto.plmbackup')) as z:self.assertEqual(json.loads(z.read('snapshot.json'))['heads'][e['id']],n['revision_id'])
        self.a.backup();self.assertEqual(len(self.a.backups()['files']),3)
    def test_custom_backup_directory(self):
        custom=str((self.root/'외장 시험').resolve());self.a.update_settings({'backup_directory':custom});self.create();b=self.a.backup();self.assertEqual(Path(b['path']).parent,Path(custom))
    def test_draft_is_not_medication_and_survives_restart(self):
        key='a'*64;entries=[{'selector':'#actual','value':'2026-10-21T08:13'}];self.a.draft({'key':key,'entries':entries});b=Store(self.a.path,maintenance=False);self.assertEqual(b.draft({'key':key})['entries'],entries);self.assertEqual(b.state()['events'],[]);b.draft({'key':key,'delete':True});self.assertIsNone(b.draft({'key':key})['entries'])
    def test_settings_opt_in_persisted(self):
        self.assertFalse(self.a.settings()['reminders']);self.a.update_settings({'reminders':True,'large_text':True});self.assertTrue(Store(self.a.path,maintenance=False).settings()['large_text'])
    def test_reminder_ack_never_creates_medication(self):
        current=datetime.now().astimezone().replace(hour=12,minute=5,second=0,microsecond=0);zone=current.strftime('%z');zone=zone[:3]+':'+zone[3:]
        payload={'slot':'점심','effective_date':current.date().isoformat(),'enabled':True,'medicines':[{'medicine_id':str(uuid4()),'name':'가상 알림약','form':'정제','dose':'예정 시험값','time':'12:00'}]}
        self.a.save({'kind':'medication_set','payload':payload,'occurred_at':current.isoformat(),'timezone':zone});self.a.update_settings({'reminders':True});due=self.a.reminder_due(current);self.assertEqual(len(due),1);self.a.acknowledge_reminder(due[0]['plan_id'],due[0]['scheduled_at']);self.assertEqual(self.a.reminder_due(current),[]);self.assertFalse(any(e['kind']=='medication' for e in self.a.state()['events']))
    def test_deleted_record_recovery_appends(self):
        e=self.create();deleted=self.a.save({'id':e['id'],'expected_revision':e['revision_id'],'kind':e['kind'],'payload':e['payload'],'occurred_at':e['occurred_at'],'timezone':e['timezone'],'deleted':True});n=self.a.recover(e['id']);self.assertFalse(n['deleted']);self.assertEqual(n['version'],3);self.assertEqual(len(self.a.history(e['id'])),3)
    def test_v02_migration_backup(self):
        self.create()
        with closing(sqlite3.connect(self.a.path)) as c:c.execute('PRAGMA user_version=2')
        b=Store(self.a.path,maintenance=False);self.assertEqual(len(list(Path(b.path).parent.glob('life-before-v1-*.db'))),1);self.assertEqual(b.health()['integrity'],'ok')
    def test_offline_adapter_two_way_and_retry(self):
        from exchange import EnvelopeFileAdapter,exchange
        e=self.create();b=Store(self.root/'b'/'life.db',maintenance=False)
        inbox=self.root/'A to B.json';outbox=self.root/'B to A.json';EnvelopeFileAdapter(inbox).push(self.a.export())
        original=inbox.read_bytes();exchange(b,inbox,outbox);self.assertEqual(inbox.read_bytes(),original)
        n=self.edit(b,e,75);EnvelopeFileAdapter(outbox).push(b.export());exchange(self.a,outbox,inbox)
        self.assertEqual(self.a.state()['events'],[n]);self.assertEqual(exchange(b,inbox,outbox)['added'],0)
        with self.assertRaises(ValueError):exchange(b,inbox,inbox)
    def test_failed_safety_backup_blocks_import(self):
        self.create();b=Store(self.root/'b'/'life.db',maintenance=False);self.create(b)
        block=self.root/'not-a-directory';block.write_text('blocked');self.a.update_settings({'backup_directory':str(block.resolve())});self.a.maintenance=True
        with self.assertRaises(OSError):self.a.import_json(b.export())
        self.assertEqual(len(self.a.state()['events']),1)
    def test_long_revision_chain_import_avoids_recursive_stack(self):
        e=self.create()
        for i in range(1050):e=self.edit(self.a,e,i%101)
        b=Store(self.root/'b'/'life.db',maintenance=False);b.import_json(self.a.export());self.assertEqual(b.state()['events'],[e]);self.assertEqual(len(b.history(e['id'])),1051)

if __name__=='__main__':unittest.main(verbosity=2)
