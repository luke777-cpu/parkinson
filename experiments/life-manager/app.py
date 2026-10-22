"""Parkinson Life Manager 1.1 scheduler — standard-library local application."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
import webbrowser
import subprocess
import time
from datetime import date
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID, uuid4, uuid5

from scheduler import SCHEDULE_KINDS, validate_schedule_event, SchedulerServices
KINDS = ('medication_set', 'medication', 'output', 'motor_state', 'dyskinesia', 'dystonia', 'freezing', 'exercise', 'note') + SCHEDULE_KINDS
MAX_BYTES = 32 * 1024 * 1024
def now(): return datetime.now(timezone.utc).isoformat()
def uid(s):
    if not isinstance(s, str) or str(UUID(s)) != s: raise ValueError('UUID 형식이 올바르지 않습니다.')
def stamp(s):
    if not isinstance(s, str): raise ValueError('시간은 문자열이어야 합니다.')
    d = datetime.fromisoformat(s)
    if d.tzinfo is None: raise ValueError('시간대가 포함된 시각이 필요합니다.')
    return d
def text(v, name, required=True):
    if not isinstance(v, str) or len(v) > 4000 or (required and not v.strip()): raise ValueError(name + ' 값을 확인하세요.')
def validate(e):
    if not isinstance(e, dict) or set(e) != {'id','revision_id','parent_revision_id','kind','occurred_at','timezone','created_at','modified_at','version','deleted','payload'}: raise ValueError('이벤트 필드가 올바르지 않습니다.')
    uid(e['id']); uid(e['revision_id'])
    if e['parent_revision_id'] is not None: uid(e['parent_revision_id'])
    if e['kind'] not in KINDS: raise ValueError('지원하지 않는 이벤트 종류입니다.')
    for k in ('occurred_at','created_at','modified_at'): stamp(e[k])
    text(e['timezone'], '시간대')
    if not __import__('re').fullmatch(r'[+-](?:0\d|1[0-4]):[0-5]\d', e['timezone']): raise ValueError('timezone은 +09:00 같은 UTC 오프셋이어야 합니다.')
    if stamp(e['occurred_at']).utcoffset().total_seconds() != (1 if e['timezone'][0]=='+' else -1)*(int(e['timezone'][1:3])*60+int(e['timezone'][4:]))*60: raise ValueError('이벤트 시각과 시간대가 다릅니다.')
    if type(e['version']) is not int or e['version'] < 1 or type(e['deleted']) is not bool: raise ValueError('버전 또는 삭제 표시 오류')
    if (e['version']==1) != (e['parent_revision_id'] is None): raise ValueError('부모 버전 오류')
    if stamp(e['modified_at']) < stamp(e['created_at']): raise ValueError('수정시각 오류')
    p=e['payload']
    if not isinstance(p,dict): raise ValueError('payload 객체가 필요합니다.')
    kind=e['kind']
    if kind in SCHEDULE_KINDS:
        validate_schedule_event(e);return
    fields={'medication_set':{'slot','medicines'},'medication':{'set_id','set_revision_id','slot','name','form','dose','scheduled_at','actual_at','completed'},'output':{'value','note'},'motor_state':{'state','note'},'exercise':{'name','minutes','note'},'note':{'date','text'},'dyskinesia':{'severity','note'},'dystonia':{'severity','note'},'freezing':{'severity','note'}}
    modern_set = kind=='medication_set' and 'effective_date' in p
    modern_med = kind=='medication' and 'status' in p
    if modern_set: fields[kind] = {'slot','medicines','effective_date','enabled'}
    if modern_med: fields[kind] = {'plan_id','medicine_id','set_id','set_revision_id','slot','name','form','planned_dose','dose','scheduled_at','actual_at','status','note'}
    if set(p)!=fields[kind]: raise ValueError('payload 필드 오류: '+kind)
    if kind in ('medication','medication_set') and p['slot'] not in ('아침','점심','저녁'): raise ValueError('복약 세트 구분 오류')
    if kind=='medication_set':
        if modern_set:
            date.fromisoformat(p['effective_date'])
            if type(p['enabled']) is not bool: raise ValueError('세트 사용 여부 오류')
        medicine_ids=set()
        if not isinstance(p['medicines'],list) or not 1<=len(p['medicines'])<=50: raise ValueError('세트에는 약을 1~50개 입력하세요.')
        for m in p['medicines']:
            if not isinstance(m,dict) or set(m)!=({'medicine_id','name','form','dose','time'} if modern_set else {'name','form','dose','time'}): raise ValueError('약 항목 오류')
            if modern_set:
                uid(m['medicine_id'])
                if m['medicine_id'] in medicine_ids: raise ValueError('세트 안의 약 식별자가 중복됩니다.')
                medicine_ids.add(m['medicine_id'])
            for k in ('name','form','dose'): text(m[k],k)
            if not __import__('re').fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',m['time']): raise ValueError('예정시간 오류')
    elif kind=='medication':
        uid(p['set_id']); uid(p['set_revision_id'])
        for k in ('name','form'): text(p[k],k)
        if modern_med:
            uid(p['plan_id']); uid(p['medicine_id']); text(p['planned_dose'],'예정 용량'); text(p['note'],'메모',False)
            if p['plan_id']!=str(uuid5(UUID(p['set_id']),p['scheduled_at'][:10]+'|'+p['medicine_id'])) or e['id']!=str(uuid5(UUID(p['plan_id']),'medication-record')): raise ValueError('복약 기록 식별자 불일치')
            if p['status'] not in ('taken','not_taken'): raise ValueError('복용 완료 또는 미복용을 직접 선택하세요.')
            if p['status']=='taken':
                text(p['dose'],'실제 용량')
                if p['actual_at'] is None: raise ValueError('실제 복용시간을 직접 입력하세요.')
            elif p['dose'] is not None or p['actual_at'] is not None: raise ValueError('미복용에는 실제 용량과 시각을 저장하지 않습니다.')
        else: text(p['dose'],'실제 용량')
        stamp(p['scheduled_at'])
        if p['actual_at'] is not None: stamp(p['actual_at'])
        if not modern_med and (type(p['completed']) is not bool or (p['completed'] and not p['actual_at'])): raise ValueError('완료 기록에는 직접 입력한 실제 복용시간이 필요합니다.')
    elif kind=='output':
        if type(p['value']) is not int or not 0<=p['value']<=100: raise ValueError('Output은 0~100 정수입니다.')
        text(p['note'],'메모',False)
    elif kind=='motor_state':
        if p['state'] not in ('ON','OFF'): raise ValueError('명시적인 ON/OFF만 기록합니다.')
        text(p['note'],'메모',False)
    elif kind=='exercise':
        text(p['name'],'운동명'); text(p['note'],'메모',False)
        if type(p['minutes']) is not int or not 1<=p['minutes']<=1440: raise ValueError('운동 시간은 1~1440분입니다.')
    elif kind=='note':
        __import__('datetime').date.fromisoformat(p['date']); text(p['text'],'메모',False)
    else:
        if p['severity'] not in ('기록함','경도','중등도','심함'): raise ValueError('증상 정도 오류')
        text(p['note'],'메모',False)

class CoreStore:
    def __init__(self,path):
        self.path=str(Path(path).resolve())
        Path(path).parent.mkdir(parents=True,exist_ok=True)
        if Path(self.path).exists():
            source=sqlite3.connect(self.path)
            try:
                version=source.execute('PRAGMA user_version').fetchone()[0]
                if version>4: raise ValueError('더 새로운 DB입니다. 최신 앱으로 여세요.')
                if version in (1,2,3):
                    backup=Path(self.path).with_name(('life-before-v02-' if version==1 else 'life-before-v1-' if version==2 else 'life-before-v11-')+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(uuid4())[:8]+'.db')
                    dest=sqlite3.connect(backup)
                    try: source.backup(dest)
                    finally: dest.close()
            finally: source.close()
        with self.connect() as c:
            c.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS revisions(revision_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, kind TEXT NOT NULL, parent_id TEXT, version INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS entity_revisions ON revisions(entity_id);
            CREATE TABLE IF NOT EXISTS heads(entity_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS conflicts(revision_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, resolved_by TEXT);
            CREATE TABLE IF NOT EXISTS change_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, revision_id TEXT NOT NULL, action TEXT NOT NULL, recorded_at TEXT NOT NULL);
            PRAGMA user_version=4;''')
            for kind in KINDS:
                c.execute(f'CREATE TABLE IF NOT EXISTS {kind}_events(revision_id TEXT PRIMARY KEY REFERENCES revisions(revision_id), entity_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL)')
    @contextmanager
    def connect(self):
        c=sqlite3.connect(self.path,timeout=10)
        try:
            c.execute('PRAGMA foreign_keys=ON')
            with c: yield c
        finally: c.close()
    def insert(self,c,e,action):
        c.execute('INSERT INTO revisions VALUES(?,?,?,?,?,?)',(e['revision_id'],e['id'],e['kind'],e['parent_revision_id'],e['version'],json.dumps(e,ensure_ascii=False,sort_keys=True)))
        c.execute(f"INSERT INTO {e['kind']}_events VALUES(?,?,?,?)",(e['revision_id'],e['id'],e['occurred_at'],json.dumps(e['payload'],ensure_ascii=False)))
        c.execute('INSERT INTO change_log(revision_id,action,recorded_at) VALUES(?,?,?)',(e['revision_id'],action,now()))
    def state(self):
        with self.connect() as c:
            return {'events':[json.loads(r[0]) for r in c.execute('SELECT r.body FROM revisions r JOIN heads h ON r.revision_id=h.revision_id')], 'conflicts':[{'revision_id':r[0],'entity_id':r[1]} for r in c.execute('SELECT revision_id,entity_id FROM conflicts WHERE resolved_by IS NULL')]}
    def save(self,data):
        kind=data['kind']; payload=json.loads(json.dumps(data['payload']))
        entity=data.get('id') or (str(uuid5(UUID(payload['plan_id']),'medication-record')) if kind=='medication' and 'plan_id' in payload else str(uuid4()))
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            row=c.execute('SELECT r.body FROM heads h JOIN revisions r ON h.revision_id=r.revision_id WHERE h.entity_id=?',(entity,)).fetchone()
            old=json.loads(row[0]) if row else None
            if (old and data.get('expected_revision')!=old['revision_id']) or (not old and data.get('expected_revision')): raise ValueError('다른 수정이 있습니다. 새로 고침 후 확인하세요.')
            if old and old['kind']!=kind: raise ValueError('종류 변경 불가')
            e={'id':entity,'revision_id':str(uuid4()),'parent_revision_id':old['revision_id'] if old else None,'kind':kind,'occurred_at':data['occurred_at'],'timezone':data['timezone'],'created_at':old['created_at'] if old else now(),'modified_at':now(),'version':old['version']+1 if old else 1,'deleted':data.get('deleted',False),'payload':payload}
            validate(e)
            self.check_local(c,e,old,bool(data.get('resolve')))
            self.insert(c,e,'local_edit' if old else 'local_create')
            c.execute('INSERT OR REPLACE INTO heads VALUES(?,?)',(entity,e['revision_id']))
            for rid in data.get('resolve',[]):
                if not c.execute('SELECT 1 FROM conflicts WHERE revision_id=? AND entity_id=? AND resolved_by IS NULL',(rid,entity)).fetchone(): raise ValueError('해결할 충돌이 없습니다.')
                c.execute('UPDATE conflicts SET resolved_by=? WHERE revision_id=?',(e['revision_id'],rid))
                c.execute('INSERT OR IGNORE INTO merge_parents VALUES(?,?)',(e['revision_id'],rid))
            return e
    def export(self):
        with self.connect() as c:
            return {'schema_version':'plm-0.2','exported_at':now(),'events':[json.loads(r[0]) for r in c.execute('SELECT body FROM revisions ORDER BY version,revision_id')]}
    def import_json(self,doc):
        if not isinstance(doc,dict) or set(doc)!={'schema_version','exported_at','events'} or doc['schema_version'] not in ('plm-0.1','plm-0.2') or not isinstance(doc['events'],list) or len(doc['events'])>10000: raise ValueError('지원하지 않는 JSON 형식입니다.')
        stamp(doc['exported_at'])
        for e in doc['events']: validate(e)
        result={'added':0,'duplicates':0,'conflicts':0}
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            for e in sorted(doc['events'],key=lambda x:x['version']):
                r=c.execute('SELECT body FROM revisions WHERE revision_id=?',(e['revision_id'],)).fetchone()
                if r:
                    if json.loads(r[0])!=e: raise ValueError('같은 revision UUID의 내용이 다릅니다. 전체 가져오기를 취소했습니다.')
                    result['duplicates']+=1; continue
                parent=c.execute('SELECT body FROM revisions WHERE revision_id=?',(e['parent_revision_id'],)).fetchone() if e['parent_revision_id'] else None
                if e['parent_revision_id'] and not parent: raise ValueError('부모 이력이 없습니다. 전체 이력 파일을 가져오세요.')
                if parent:
                    p=json.loads(parent[0])
                    if (p['id'],p['kind'],p['version']+1,p['created_at'])!=(e['id'],e['kind'],e['version'],e['created_at']): raise ValueError('부모 이력 불일치')
                    if e['kind']=='medication_set' and 'effective_date' in e['payload'] and self.effective(e)<self.effective(p): raise ValueError('세트 적용 시작일이 부모 버전보다 빠릅니다.')
                head=c.execute('SELECT revision_id FROM heads WHERE entity_id=?',(e['id'],)).fetchone()
                if head:
                    h=json.loads(c.execute('SELECT body FROM revisions WHERE revision_id=?',head).fetchone()[0])
                    if h['kind']!=e['kind']: raise ValueError('동일 UUID 종류 불일치')
                self.insert(c,e,'import'); result['added']+=1
                if not head or head[0]==e['parent_revision_id']:
                    c.execute('INSERT OR REPLACE INTO heads VALUES(?,?)',(e['id'],e['revision_id']))
                else:
                    c.execute('INSERT INTO conflicts VALUES(?,?,NULL)',(e['revision_id'],e['id'])); result['conflicts']+=1
        return result
    @staticmethod
    def effective(e):
        return e['payload'].get('effective_date', e['occurred_at'][:10])
    @staticmethod
    def medicine_id(e,m,index):
        return m.get('medicine_id') or str(uuid5(UUID(e['id']), 'legacy-medicine-'+str(index)))
    def set_chains(self,c):
        rows={r[0]:json.loads(r[1]) for r in c.execute("SELECT revision_id,body FROM revisions WHERE kind='medication_set'")}
        chains=[]
        for (rid,) in c.execute("SELECT h.revision_id FROM heads h JOIN revisions r ON r.revision_id=h.revision_id WHERE r.kind='medication_set'"):
            chain=[]; seen=set()
            while rid and rid in rows and rid not in seen:
                seen.add(rid); e=rows[rid]; chain.append(e); rid=e['parent_revision_id']
            chains.append(chain)
        return chains
    def day(self,day,zone):
        date.fromisoformat(day); stamp(day+'T00:00:00'+zone)
        with self.connect() as c: return self.day_in(c,day,zone)
    def day_in(self,c,day,zone):
        sets=[]; plans=[]
        for chain in self.set_chains(c):
            applicable=[e for e in chain if self.effective(e)<=day]
            if not applicable: continue
            e=max(applicable,key=lambda x:(self.effective(x),x['version']))
            if e['deleted'] or not e['payload'].get('enabled',True): continue
            sets.append(e)
            for index,m in enumerate(e['payload']['medicines']):
                mid=self.medicine_id(e,m,index)
                pid=str(uuid5(UUID(e['id']),day+'|'+mid))
                plans.append({'plan_id':pid,'medicine_id':mid,'set_id':e['id'],'set_revision_id':e['revision_id'],'slot':e['payload']['slot'],'name':m['name'],'form':m['form'],'planned_dose':m['dose'],'scheduled_at':day+'T'+m['time']+':00'+zone})
        records=[json.loads(r[0]) for r in c.execute("SELECT r.body FROM revisions r JOIN heads h ON h.revision_id=r.revision_id WHERE r.kind='medication'")]
        legacy=[]
        for e in records:
            p=e['payload']
            if p['scheduled_at'][:10]!=day: continue
            if 'plan_id' not in p:
                if not e['deleted']:
                    legacy.append(e)
                    plans=[plan for plan in plans if not (plan['set_id']==p['set_id'] and plan['name']==p['name'] and plan['scheduled_at']==p['scheduled_at'])]
                continue
            # Recorded snapshot always remains visible even after imported schedule conflicts.
            plan=next((x for x in plans if x['plan_id']==p['plan_id']),None)
            snapshot={k:p[k] for k in ('plan_id','medicine_id','set_id','set_revision_id','slot','name','form','planned_dose','scheduled_at')}
            if plan:
                if not e['deleted']: plan.update(snapshot)
                plan['record']=e
            elif not e['deleted']: plans.append(dict(snapshot,record=e))
        plans.sort(key=lambda x:(x['scheduled_at'],x['name']))
        return {'date':day,'sets':sets,'plans':plans,'legacy':legacy}
    def check_local(self,c,e,old,resolving=False):
        p=e['payload']
        if e['kind']=='medication_set' and 'effective_date' in p:
            if e['deleted']: raise ValueError('세트는 적용일을 지정하여 사용 중지하세요.')
            if p['effective_date']<date.today().isoformat(): raise ValueError('세트 변경은 오늘 또는 이후 날짜부터 적용하세요. 과거 계획은 보존됩니다.')
            if old and p['effective_date']<self.effective(old): raise ValueError('최근 변경 적용일보다 앞당길 수 없습니다. 예약된 변경을 먼저 확인하세요.')
            # Applying a changed plan cannot rewrite dates which already have a medication record.
            for (body,) in c.execute("SELECT r.body FROM revisions r JOIN heads h ON h.revision_id=r.revision_id WHERE r.kind='medication'"):
                other=json.loads(body); op=other['payload']
                if not other['deleted'] and op['set_id']==e['id'] and op['scheduled_at'][:10]>=p['effective_date']:
                    raise ValueError('해당 적용일 이후에 복용 기록이 있습니다. 마지막 기록 다음 날부터 적용하세요.')
        if e['kind']=='medication' and 'plan_id' in p:
            expected=str(uuid5(UUID(p['plan_id']),'medication-record'))
            if e['id']!=expected: raise ValueError('날짜별 복용 기록 식별자가 올바르지 않습니다.')
            if old and not old['deleted'] and not resolving:
                for key in ('plan_id','medicine_id','set_id','set_revision_id','slot','name','form','planned_dose','scheduled_at'):
                    if old['payload'].get(key)!=p[key]: raise ValueError('예정 내역은 변경할 수 없습니다. 실제 기록만 수정하세요.')
            elif not resolving:
                day=self.day_in(c,p['scheduled_at'][:10],p['scheduled_at'][-6:])
                for prior in day['legacy']:
                    lp=prior['payload']
                    if (lp['set_id'],lp['name'],lp['scheduled_at'])==(p['set_id'],p['name'],p['scheduled_at']): raise ValueError('같은 약의 v0.1 기록이 있습니다. 기존 기록을 확인하세요.')
                plan=next((x for x in day['plans'] if x['plan_id']==p['plan_id']),None)
                if not plan or any(plan[k]!=p[k] for k in plan if k!='record'): raise ValueError('복약 계획이 변경되었습니다. 새로 고침하세요.')
    def history(self,entity):
        with self.connect() as c:
            return [json.loads(r[0]) for r in c.execute('SELECT body FROM revisions WHERE entity_id=? ORDER BY version,revision_id',(entity,))]

from platform_services import PlatformServices
class Store(SchedulerServices,PlatformServices,CoreStore):
    validate_event=staticmethod(validate)

class SyncAdapter:
    """Future external adapters translate to/from validated plm-1.0 envelopes."""
    def pull(self): raise NotImplementedError
    def push(self,envelope): raise NotImplementedError
class JsonFileAdapter(SyncAdapter):
    def __init__(self,path): self.path=Path(path)
    def pull(self): return json.loads(self.path.read_text(encoding='utf-8-sig'))
    def push(self,envelope): self.path.write_text(json.dumps(envelope,ensure_ascii=False,indent=2),encoding='utf-8')

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--data-dir'); parser.add_argument('--port',type=int,default=0); parser.add_argument('--no-browser',action='store_true'); parser.add_argument('--desktop',action='store_true'); args=parser.parse_args()
    root=Path(getattr(sys,'_MEIPASS',Path(__file__).parent))
    data=Path(args.data_dir) if args.data_dir else Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'.local/share')))/'ParkinsonLifeManager-DiaryExperiment'
    store=Store(data/'life.db'); from diary_bridge import DiaryBridge; diary=DiaryBridge(store); token=secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def send(self,obj,status=200,ctype='application/json; charset=utf-8'):
            b=obj if isinstance(obj,bytes) else json.dumps(obj,ensure_ascii=False).encode()
            self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(b))); self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.end_headers(); self.wfile.write(b)
        def allowed(self): return self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
        def do_GET(self):
            if not self.allowed(): return self.send({'error':'Host rejected'},403)
            if self.path=='/': return self.send((root/'ui.html').read_bytes().replace(b'/*__EXTRA__*/',(root/'platform_ui.js').read_bytes()).replace(b'/*__SCHEDULER__*/',(root/'scheduler_ui.js').read_bytes()).replace(b'__TOKEN__',token.encode()),ctype='text/html; charset=utf-8')
            if self.path.startswith('/diary/'):
                from urllib.parse import unquote,urlsplit
                from mimetypes import guess_type
                relative=unquote(urlsplit(self.path).path[len('/diary/'):]) or 'index.html'
                target=(root/'diary'/relative).resolve()
                if not target.is_relative_to((root/'diary').resolve()) or not target.is_file() or target.name=='sw.js':return self.send({'error':'Not found'},404)
                if relative=='index.html':
                    loaded=diary.load();boot=json.dumps(dict(loaded,token=token),ensure_ascii=True).replace('<','\u003c')
                    html=target.read_text(encoding='utf-8').replace('if("serviceWorker" in navigator)', 'if(false)')
                    preload='<script>window.__DIARY_BOOT__='+boot+';localStorage.removeItem("yakhyo_log_v1");if(window.__DIARY_BOOT__.document)localStorage.setItem("yakhyo_log_v1",JSON.stringify(window.__DIARY_BOOT__.document));</script>'
                    html=html.replace('<head>','<head>'+preload).replace('</body>','<script src="/diary-host.js"></script></body>')
                    return self.send(html.encode(),ctype='text/html; charset=utf-8')
                return self.send(target.read_bytes(),ctype=guess_type(str(target))[0] or 'application/octet-stream')
            if self.path=='/diary-host.js':return self.send((root/'diary_host.js').read_bytes(),ctype='application/javascript; charset=utf-8')
            if self.headers.get('X-PLM-Token')!=token: return self.send({'error':'Unauthorized'},403)
            if self.path=='/api/diary/load':return self.send(diary.load())
            if self.path=='/api/diary/history':return self.send(diary.history())
            if self.path=='/api/state': return self.send(store.state())
            if self.path=='/api/export': return self.send(store.export())
            if self.path=='/api/settings': return self.send(store.settings())
            if self.path=='/api/backups': return self.send(store.backups())
            if self.path=='/api/health': return self.send(store.health())
            if self.path=='/api/reminders': return self.send(store.reminder_due())
            if self.path=='/api/scheduler/reminders': return self.send(store.scheduler_reminders())
            if self.path.startswith('/api/history/'):
                return self.send(store.history(self.path.rsplit('/',1)[1]))
            self.send({'error':'Not found'},404)
        def do_POST(self):
            if not self.allowed() or self.headers.get('X-PLM-Token')!=token: return self.send({'error':'Unauthorized'},403)
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=MAX_BYTES: raise ValueError('요청은 32MB 이하여야 합니다.')
                body=json.loads(self.rfile.read(length))
                if self.path=='/api/diary/save':result=diary.save(body)
                elif self.path=='/api/diary/sync':result=diary.sync(body)
                elif self.path=='/api/save': result=store.save(body)
                elif self.path=='/api/import': result=store.import_json(body)
                elif self.path=='/api/day': result=store.day(body['date'],body['timezone'])
                elif self.path=='/api/settings': result=store.update_settings(body)
                elif self.path=='/api/scheduler/range': result=store.scheduler_range(body['start'],body['end'],body.get('timezone','+09:00'))
                elif self.path=='/api/scheduler/preview': result=store.schedule_preview(body['payload'],body.get('exclude_series'),body.get('exclude_occurrence'))
                elif self.path=='/api/scheduler/save': result=store.schedule_save(body)
                elif self.path=='/api/scheduler/cancel': result=store.schedule_cancel(body)
                elif self.path=='/api/scheduler/result': result=store.schedule_result(body)
                elif self.path=='/api/scheduler/task-schedule': result=store.task_schedule(body)
                elif self.path=='/api/scheduler/exception-clear': result=store.clear_exception(body)
                elif self.path=='/api/scheduler/routine-apply': result=store.routine_apply(body)
                elif self.path=='/api/backup': result=store.backup()
                elif self.path=='/api/backup-download':
                    return self.send(store.backup_path(body['name']).read_bytes(),ctype='application/octet-stream')
                elif self.path=='/api/restore-preview': result=store.preview_restore(body)
                elif self.path=='/api/restore': result=store.restore(body['ticket'])
                elif self.path=='/api/recover': result=store.recover(body['id'])
                elif self.path=='/api/draft': result=store.draft(body)
                elif self.path=='/api/reminder-ack': result=store.acknowledge_reminder(body['plan_id'],body['scheduled_at'])
                elif self.path=='/api/shutdown':
                    self.send({'ok':True}); threading.Thread(target=server.shutdown,daemon=True).start(); return
                else: return self.send({'error':'Not found'},404)
                self.send(result)
            except (ValueError,KeyError,TypeError,OverflowError,sqlite3.IntegrityError) as ex: self.send({'error':str(ex)},400)
            except Exception: self.send({'error':'저장 실패. 원본 파일을 보존하고 다시 시도하세요.'},500)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    url=f'http://127.0.0.1:{server.server_port}/'
    print(f'Parkinson Life Manager v1.2 diary experiment\n{url}\nData: {data}\nClose this console / Ctrl+C to stop.',flush=True)
    desktop_process=None
    if not args.no_browser:
        if args.desktop:
            candidates=[Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Google/Chrome/Application/chrome.exe',Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Microsoft/Edge/Application/msedge.exe']
            executable=next((x for x in candidates if x.exists()),None)
            if not executable: raise RuntimeError('Chrome 또는 Microsoft Edge가 필요합니다.')
            desktop_process=subprocess.Popen([str(executable),'--app='+url,'--user-data-dir='+str(data/'desktop-profile'),'--no-first-run','--disable-background-mode','--start-maximized'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        else: threading.Timer(.5,lambda:webbrowser.open(url)).start()
    if desktop_process:
        def watch_window():
            desktop_process.wait()
            server.shutdown()
        threading.Thread(target=watch_window,daemon=True).start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        server.server_close()
        if desktop_process and desktop_process.poll() is None:
            subprocess.run(['taskkill','/PID',str(desktop_process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if __name__=='__main__': main()
