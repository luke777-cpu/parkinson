"""Local backup, deterministic exchange, settings and notification services."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import tempfile
import threading
import time
from datetime import datetime, timezone, timedelta
from uuid import UUID, uuid4
from zipfile import ZipFile, ZIP_DEFLATED

def utc(): return datetime.now(timezone.utc).isoformat()
def canonical(doc): return json.dumps(doc,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
DEFAULTS={'calendar_life':True,'calendar_exercise':True,'calendar_medication':False,'reminders':False,'schedule_reminders':False,'large_text':False,'backup_directory':'','auto_backup':True,'reminder_window_minutes':30}

class PlatformServices:
    def __init__(self,path,maintenance=True):
        self.guard=threading.RLock(); self.tickets={}; self.maintenance=maintenance
        super().__init__(path)
        with self.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS merge_parents(revision_id TEXT NOT NULL,parent_id TEXT NOT NULL,PRIMARY KEY(revision_id,parent_id));
            CREATE TABLE IF NOT EXISTS reminder_log(plan_id TEXT PRIMARY KEY,scheduled_at TEXT NOT NULL,acknowledged_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY,body TEXT NOT NULL,modified_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,action TEXT NOT NULL,recorded_at TEXT NOT NULL,details TEXT NOT NULL);''')
        self.backup_error=None
        if maintenance:
            try:self.auto_backup()
            except (OSError,ValueError,sqlite3.Error) as ex:self.backup_error='자동 백업 실패: '+str(ex)
    def settings(self):
        result=dict(DEFAULTS)
        with self.connect() as c:
            result.update({r[0]:json.loads(r[1]) for r in c.execute('SELECT key,value FROM settings') if r[0] in DEFAULTS})
        return result
    def update_settings(self,values):
        if not isinstance(values,dict) or set(values)-set(DEFAULTS):raise ValueError('설정 항목 오류')
        for k,v in values.items():
            if k in ('calendar_life','calendar_exercise','calendar_medication','reminders','schedule_reminders','large_text','auto_backup') and type(v) is not bool:raise ValueError('설정 값 오류')
            if k=='reminder_window_minutes' and (type(v) is not int or not 1<=v<=120):raise ValueError('알림 확인 범위는 1~120분입니다.')
            if k=='backup_directory' and (not isinstance(v,str) or len(v)>1000 or '\x00' in v):raise ValueError('백업 폴더 오류')
            if k=='backup_directory' and v and not Path(v).is_absolute():raise ValueError('백업 폴더는 전체 경로를 입력하세요.')
        with self.guard,self.connect() as c:
            for k,v in values.items():c.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',(k,json.dumps(v)))
        return self.settings()
    def operation(self,c,action,details):
        c.execute('INSERT INTO operations VALUES(?,?,?,?)',(str(uuid4()),action,utc(),json.dumps(details,ensure_ascii=False)))
    def save(self,data):
        with self.guard:
            result=super().save(data)
            if self.maintenance:
                try:self.auto_backup()
                except (OSError,ValueError,sqlite3.Error) as ex:self.backup_error='자동 백업 실패: '+str(ex)
            return result
    def export(self):
        with self.guard,self.connect() as c:
            return {'schema_version':'plm-1.1','exported_at':utc(),
                'events':[json.loads(r[0]) for r in c.execute('SELECT body FROM revisions ORDER BY version,revision_id')],
                'heads':dict(c.execute('SELECT entity_id,revision_id FROM heads')),
                'merge_parents':[{'revision_id':r[0],'parent_id':r[1]} for r in c.execute('SELECT revision_id,parent_id FROM merge_parents ORDER BY revision_id,parent_id')]}
    def _import(self,doc,dry=False):
        if not isinstance(doc,dict) or doc.get('schema_version') not in ('plm-0.1','plm-0.2','plm-1.0','plm-1.1'):raise ValueError('지원하지 않는 교환 형식입니다.')
        modern=doc['schema_version'] in ('plm-1.0','plm-1.1')
        if set(doc)!=({'schema_version','exported_at','events','heads','merge_parents'} if modern else {'schema_version','exported_at','events'}):raise ValueError('교환 파일 필드 오류')
        d=datetime.fromisoformat(doc['exported_at'])
        if d.tzinfo is None:raise ValueError('내보내기 시각에 시간대가 필요합니다.')
        if not isinstance(doc['events'],list) or len(doc['events'])>100000:raise ValueError('이벤트 수 제한 초과')
        seen={}
        for e in doc['events']:
            self.validate_event(e)
            if e['revision_id'] in seen and seen[e['revision_id']]!=e:raise ValueError('파일 안에서 같은 revision UUID 내용이 다릅니다.')
            seen[e['revision_id']]=e
        heads=doc.get('heads',{}); merges=doc.get('merge_parents',[])
        if not isinstance(heads,dict) or not isinstance(merges,list) or len(merges)>100000:raise ValueError('병합 정보 오류')
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            result={'added':0,'duplicates':0,'conflicts':0,'advanced':0}
            rows={r[0]:json.loads(r[1]) for r in c.execute('SELECT revision_id,body FROM revisions')}
            identities={e['id']:(e['kind'],e['created_at']) for e in rows.values()}
            previous_heads=dict(c.execute('SELECT entity_id,revision_id FROM heads'))
            for e in sorted(seen.values(),key=lambda x:(x['version'],x['revision_id'])):
                rid=e['revision_id']
                if rid in rows:
                    if rows[rid]!=e:raise ValueError('같은 revision UUID 내용이 다릅니다. 가져오기를 취소했습니다.')
                    result['duplicates']+=1;continue
                parent=rows.get(e['parent_revision_id'])
                if e['parent_revision_id'] and not parent:raise ValueError('부모 이력이 없습니다. 전체 이력 파일이 필요합니다.')
                if parent and (parent['id'],parent['kind'],parent['version']+1,parent['created_at'])!=(e['id'],e['kind'],e['version'],e['created_at']):raise ValueError('부모 이력 불일치')
                if e['id'] in identities and identities[e['id']]!=(e['kind'],e['created_at']):raise ValueError('동일 엔티티의 종류 또는 생성시각 불일치')
                if parent and e['kind']=='medication_set' and 'effective_date' in e['payload'] and self.effective(e)<self.effective(parent):raise ValueError('세트 적용일 순서 오류')
                self.insert(c,e,'import');rows[rid]=e;identities[e['id']]=(e['kind'],e['created_at']);result['added']+=1
            for link in merges:
                if not isinstance(link,dict) or set(link)!={'revision_id','parent_id'}:raise ValueError('병합 부모 형식 오류')
                rid,pid=link['revision_id'],link['parent_id']
                if rid not in rows or pid not in rows or rid==pid or rows[rid]['id']!=rows[pid]['id']:raise ValueError('병합 부모 참조 오류')
                c.execute('INSERT OR IGNORE INTO merge_parents VALUES(?,?)',(rid,pid))
            extra={}
            for rid,pid in c.execute('SELECT revision_id,parent_id FROM merge_parents'):extra.setdefault(rid,[]).append(pid)
            parents={rid:([e['parent_revision_id']] if e['parent_revision_id'] else [])+extra.get(rid,[]) for rid,e in rows.items()}
            colors={}
            for root in rows:
                stack=[(root,False)]
                while stack:
                    rid,leaving=stack.pop()
                    if leaving:colors[rid]=2;continue
                    if colors.get(rid)==2:continue
                    if colors.get(rid)==1:raise ValueError('병합 이력 순환 오류')
                    colors[rid]=1;stack.append((rid,True))
                    stack.extend((pid,False) for pid in parents[rid])
            ancestry={}
            def ancestors(rid):
                if rid in ancestry:return ancestry[rid]
                value=set();stack=[rid]
                while stack:
                    current=stack.pop()
                    if current in value:continue
                    value.add(current);stack.extend(parents[current])
                ancestry[rid]=value;return value
            if modern:
                entities={e['id'] for e in seen.values()}
                if set(heads)!=entities:raise ValueError('현재 버전 목록이 이벤트 목록과 다릅니다.')
                for entity,rid in heads.items():
                    if rid not in seen or rows[rid]['id']!=entity:raise ValueError('현재 버전 참조 오류')
            # Reconcile every retained branch using ancestry, never timestamps.
            groups={}
            for rid,e in rows.items():groups.setdefault(e['id'],set()).add(rid)
            for entity,rids in groups.items():
                tips=set(rids)
                for rid in rids:tips.difference_update(parents[rid])
                current=previous_heads.get(entity);remote=heads.get(entity)
                if current and current in tips:chosen=current
                elif current:
                    descendants=sorted(t for t in tips if current in ancestors(t))
                    chosen=remote if remote in descendants else (descendants[0] if descendants else sorted(tips)[0])
                else:chosen=remote if remote in tips else sorted(tips)[0]
                c.execute('INSERT OR REPLACE INTO heads VALUES(?,?)',(entity,chosen))
                if current!=chosen:result['advanced']+=1
                for rid in rids:
                    if rid in tips and rid!=chosen:
                        existing=c.execute('SELECT resolved_by FROM conflicts WHERE revision_id=?',(rid,)).fetchone()
                        c.execute('INSERT OR REPLACE INTO conflicts VALUES(?,?,NULL)',(rid,entity))
                        if existing is None or existing[0] is not None:result['conflicts']+=1
                    elif rid not in tips:
                        successor=chosen if rid in ancestors(chosen) else next((t for t in tips if rid in ancestors(t)),None)
                        if successor:c.execute('UPDATE conflicts SET resolved_by=? WHERE revision_id=?',(successor,rid))
            self.operation(c,'import',result)
            if dry:c.rollback()
            return result
    def import_json(self,doc):
        with self.guard:
            self._import(doc,dry=True)
            if self.maintenance:self.backup('before-import')
            result=self._import(doc)
            if self.maintenance:
                try:self.auto_backup()
                except (OSError,ValueError,sqlite3.Error) as ex:self.backup_error='자동 백업 실패: '+str(ex)
            return result
    def backup_dir(self):
        value=self.settings()['backup_directory']
        return Path(value).resolve() if value else Path(self.path).parent/'backups'
    def backup(self,reason='manual'):
        if reason not in ('manual','auto','rolling','before-import','before-restore'):raise ValueError('백업 구분 오류')
        with self.guard:
            directory=self.backup_dir();directory.mkdir(parents=True,exist_ok=True)
            name='latest-auto.plmbackup' if reason=='rolling' else datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+reason+'-'+secrets.token_hex(4)+'.plmbackup'
            target=directory/name
            with tempfile.TemporaryDirectory(dir=Path(self.path).parent) as tmp:
                raw=Path(tmp)/'life.db'
                with self.connect() as source:
                    dest=sqlite3.connect(raw)
                    try:source.backup(dest)
                    finally:dest.close()
                # Snapshot JSON must describe the same immutable database image.
                snapshot=type(self)(raw,maintenance=False).export()
                contents={'snapshot.json':canonical(snapshot),'life.db':raw.read_bytes()}
                if any(len(value)>64*1024*1024 for value in contents.values()):raise ValueError('백업 원본이 64MB를 초과했습니다. JSON 내보내기로 별도 보관하세요.')
                manifest={'format':'plm-backup-1','created_at':utc(),'reason':reason,'sha256':{k:hashlib.sha256(v).hexdigest() for k,v in contents.items()}}
                temporary=target.with_suffix('.tmp')
                try:
                    with ZipFile(temporary,'w',ZIP_DEFLATED) as z:
                        for k,v in contents.items():z.writestr(k,v)
                        z.writestr('manifest.json',canonical(manifest))
                    if temporary.stat().st_size>20*1024*1024:raise ValueError('백업 파일이 20MB를 초과했습니다. JSON 내보내기로 별도 보관하세요.')
                    os.replace(temporary,target)
                finally:
                    if temporary.exists():temporary.unlink()
            with self.connect() as c:self.operation(c,'backup',{'name':name,'reason':reason})
            self.backup_error=None
            return {'name':name,'path':str(target),'bytes':target.stat().st_size}
    def auto_backup(self):
        if not self.settings()['auto_backup']:return
        today=datetime.now().strftime('%Y%m%d')
        with self.connect() as c:
            if not c.execute('SELECT 1 FROM revisions LIMIT 1').fetchone():return
        directory=self.backup_dir()
        if not directory.exists() or not any(directory.glob(today+'-*-auto-*.plmbackup')):self.backup('auto')
        self.backup('rolling')
        # Retain 30 daily snapshots; explicit/manual/safety backups are never pruned.
        import re
        daily=sorted((p for p in directory.glob('*.plmbackup') if re.fullmatch(r'\d{8}-\d{6}-auto-[0-9a-f]{8}\.plmbackup',p.name)),reverse=True)
        for p in daily[30:]:
            if not p.is_symlink() and p.resolve().parent==directory.resolve():p.unlink()
    def backups(self):
        directory=self.backup_dir()
        try:files=[{'name':p.name,'bytes':p.stat().st_size} for p in sorted(directory.glob('*.plmbackup'),reverse=True) if p.is_file()] if directory.exists() else []
        except OSError as ex:return {'directory':str(directory),'error':'백업 폴더 읽기 실패: '+str(ex),'files':[]}
        return {'directory':str(directory),'error':self.backup_error,'files':files}
    def backup_path(self,name):
        if not isinstance(name,str) or Path(name).name!=name or not name.endswith('.plmbackup'):raise ValueError('백업 파일명 오류')
        p=(self.backup_dir()/name).resolve()
        if p.parent!=self.backup_dir().resolve() or not p.is_file():raise ValueError('백업 파일이 없습니다.')
        return p
    def preview_restore(self,body):
        import io
        if 'name' in body:raw=self.backup_path(body['name']).read_bytes()
        else:
            try:raw=base64.b64decode(body['file_base64'],validate=True)
            except Exception:raise ValueError('백업 파일 인코딩 오류')
        if len(raw)>20*1024*1024:raise ValueError('백업은 20MB 이하로 선택하세요.')
        try:
            with ZipFile(io.BytesIO(raw)) as z:
                if set(z.namelist())!={'manifest.json','snapshot.json','life.db'} or len(z.namelist())!=3:raise ValueError('백업 구성 오류')
                if any(i.file_size>64*1024*1024 for i in z.infolist()):raise ValueError('백업 압축 해제 크기 제한 초과')
                manifest=json.loads(z.read('manifest.json'))
                if manifest['format']!='plm-backup-1':raise ValueError('백업 버전 오류')
                for name in ('snapshot.json','life.db'):
                    if hashlib.sha256(z.read(name)).hexdigest()!=manifest['sha256'][name]:raise ValueError('백업 무결성 검사 실패')
                doc=json.loads(z.read('snapshot.json'))
        except (KeyError,TypeError,ValueError) as ex:raise ValueError('백업 검사 실패: '+str(ex))
        except Exception:raise ValueError('읽을 수 없는 백업 파일입니다.')
        with self.guard:
            result=self._import(doc,dry=True)
            key=secrets.token_urlsafe(24);self.tickets={k:v for k,v in self.tickets.items() if v['expires']>time.time()}
            self.tickets[key]={'doc':doc,'expires':time.time()+300,'fingerprint':self.fingerprint()}
            return {'ticket':key,'created_at':manifest['created_at'],'preview':result,'policy':'이력을 합칩니다. 현재의 다른 기록은 삭제하지 않으며, 갈라진 수정은 충돌로 보관합니다.'}
    def fingerprint(self):
        doc=self.export();doc.pop('exported_at');return hashlib.sha256(canonical(doc)).hexdigest()
    def restore(self,key):
        with self.guard:
            ticket=self.tickets.get(key)
            if not ticket or ticket['expires']<time.time():raise ValueError('복원 미리보기가 만료되었습니다.')
            if ticket['fingerprint']!=self.fingerprint():raise ValueError('미리보기 후 기록이 바뀌었습니다. 다시 검사하세요.')
            safety=self.backup('before-restore')
            result=self._import(ticket['doc']);self.tickets.pop(key,None)
            return {'result':result,'safety_backup':safety['name']}
    def reminder_due(self,instant=None):
        if not self.settings()['reminders']:return []
        current=instant or datetime.now().astimezone()
        if current.tzinfo is None:raise ValueError('알림 시각에 시간대가 필요합니다.')
        zone=current.strftime('%z');zone=zone[:3]+':'+zone[3:]
        window=self.settings()['reminder_window_minutes'];due=[]
        with self.connect() as c:
            logged={r[0] for r in c.execute('SELECT plan_id FROM reminder_log')}
        for day in (current.date(),(current-timedelta(days=1)).date()):
            for p in self.day(day.isoformat(),zone)['plans']:
                r=p.get('record')
                if r and not r['deleted']:continue
                scheduled=datetime.fromisoformat(p['scheduled_at'])
                if timedelta(0)<=current-scheduled<=timedelta(minutes=window) and p['plan_id'] not in logged:due.append(p)
        return due
    def acknowledge_reminder(self,plan_id,scheduled):
        if str(UUID(plan_id))!=plan_id:raise ValueError('알림 식별자 오류')
        datetime.fromisoformat(scheduled)
        with self.guard,self.connect() as c:c.execute('INSERT OR IGNORE INTO reminder_log VALUES(?,?,?)',(plan_id,scheduled,utc()))
        return {'acknowledged':True,'medication_record_created':False}
    def recover(self,entity):
        with self.guard,self.connect() as c:
            row=c.execute('SELECT r.body FROM revisions r JOIN heads h ON h.revision_id=r.revision_id WHERE h.entity_id=?',(entity,)).fetchone()
        if not row:raise ValueError('기록이 없습니다.')
        e=json.loads(row[0])
        if not e['deleted']:raise ValueError('삭제된 기록만 복구할 수 있습니다.')
        return self.save({'id':entity,'expected_revision':e['revision_id'],'kind':e['kind'],'payload':e['payload'],'occurred_at':e['occurred_at'],'timezone':e['timezone'],'deleted':False})
    def draft(self,body):
        key=body.get('key')
        if not isinstance(key,str) or len(key)!=64 or any(c not in '0123456789abcdef' for c in key):raise ValueError('임시 작성 키 오류')
        with self.guard,self.connect() as c:
            if body.get('delete') is True:c.execute('DELETE FROM drafts WHERE key=?',(key,));return {'deleted':True}
            if 'entries' in body:
                entries=body['entries']
                if not isinstance(entries,list) or len(entries)>300 or len(canonical(entries))>100000:raise ValueError('임시 작성 내용 제한 초과')
                c.execute('INSERT OR REPLACE INTO drafts VALUES(?,?,?)',(key,json.dumps(entries,ensure_ascii=False),utc()))
                return {'saved':True}
            row=c.execute('SELECT body,modified_at FROM drafts WHERE key=?',(key,)).fetchone()
            return {'entries':json.loads(row[0]),'modified_at':row[1]} if row else {'entries':None}
    def health(self):
        with self.connect() as c:
            return {'database':str(Path(self.path).parent),'integrity':c.execute('PRAGMA quick_check').fetchone()[0],'events':c.execute('SELECT count(*) FROM heads').fetchone()[0],'revisions':c.execute('SELECT count(*) FROM revisions').fetchone()[0],'settings':self.settings(),'backups':self.backups(),'external_adapter':'not_connected'}
