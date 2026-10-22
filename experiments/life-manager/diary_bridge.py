"""Experimental legacy diary snapshot journal and explicit Output-only bridge."""
import json,hashlib,math
from uuid import uuid4,uuid5,UUID
from datetime import datetime,timezone,timedelta

NAMESPACE=UUID('984913f8-cb46-4fb6-b49f-002b967e0408')
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def current_time():return datetime.now(timezone.utc).isoformat()
def output_value(e):
    value=e.get('output')
    return e.get('type')=='state' and type(value) in (int,float) and math.isfinite(value) and value==int(value) and 0<=value<=100 and type(e.get('ts')) in (int,float) and math.isfinite(e['ts'])
def output_hash(e):return digest({k:e.get(k) for k in ('output','ts','memo')})

class DiaryBridge:
    def __init__(self,store):
        self.store=store
        with store.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS diary_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,revision_id TEXT UNIQUE NOT NULL,parent_revision_id TEXT,created_at TEXT NOT NULL,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS diary_output_map(source_id TEXT PRIMARY KEY,entity_id TEXT UNIQUE NOT NULL,source_hash TEXT NOT NULL,plm_revision TEXT NOT NULL);''')
    def _load(self,c):
        row=c.execute('SELECT revision_id,body FROM diary_journal ORDER BY seq DESC LIMIT 1').fetchone()
        return {'revision':row[0] if row else None,'document':json.loads(row[1]) if row else None}
    def load(self):
        with self.store.connect() as c:return self._load(c)
    def validate(self,doc):
        if not isinstance(doc,dict) or not isinstance(doc.get('events'),list) or len(doc['events'])>50000:raise ValueError('약효일지 events 배열을 확인하세요.')
        ids=set()
        for e in doc['events']:
            if not isinstance(e,dict) or not isinstance(e.get('id'),str) or not e['id'] or e['id'] in ids:raise ValueError('약효일지 기록 ID가 없거나 중복됩니다.')
            ids.add(e['id'])
        if len(json.dumps(doc,ensure_ascii=False).encode())>20*1024*1024:raise ValueError('약효일지는 20MB 이하로 사용하세요.')
    def _save(self,c,doc,expected):
        self.validate(doc);old=self._load(c)
        if old['revision']!=expected:raise ValueError('다른 창에서 약효일지를 수정했습니다. 원본 JSON을 내보내고 다시 열어 주세요.')
        if old['document']==doc:return old
        rid=str(uuid4());c.execute('INSERT INTO diary_journal(revision_id,parent_revision_id,created_at,body) VALUES(?,?,?,?)',(rid,expected,current_time(),json.dumps(doc,ensure_ascii=False,allow_nan=False)))
        return {'revision':rid,'document':doc}
    def save(self,body):
        with self.store.connect() as c:
            c.execute('BEGIN IMMEDIATE');return self._save(c,body['document'],body.get('expected_revision'))
    def history(self):
        with self.store.connect() as c:return [{'revision':r[0],'parent':r[1],'created_at':r[2],'document':json.loads(r[3])} for r in c.execute('SELECT revision_id,parent_revision_id,created_at,body FROM diary_journal ORDER BY seq')]
    def sync(self,body):
        # Conflict checks, clinical revisions and diary snapshot commit atomically.
        with self.store.connect() as c:
            c.execute('BEGIN IMMEDIATE');loaded=self._load(c)
            if loaded['revision']!=body.get('expected_revision'):raise ValueError('약효일지가 변경되었습니다. 다시 열어 주세요.')
            doc=loaded['document']
            if doc is None:raise ValueError('약효일지를 먼저 열어 저장하세요.')
            events={e['id']:e for e in doc['events']};maps={r[0]:r for r in c.execute('SELECT source_id,entity_id,source_hash,plm_revision FROM diary_output_map')}
            plm={json.loads(r[0])['id']:json.loads(r[0]) for r in c.execute("SELECT r.body FROM revisions r JOIN heads h ON r.revision_id=h.revision_id WHERE kind='output'")}
            added=updated=pulled=0;skipped=[]
            for sid,entry in list(events.items()):
                if not output_value(entry):continue
                if entry.get('deleted'):skipped.append(sid);continue
                mapping=maps.get(sid);entity=mapping[1] if mapping else str(uuid5(NAMESPACE,'legacy-output|'+sid));old=plm.get(entity)
                if mapping and old and old['deleted']:skipped.append(sid);continue
                source_changed=not mapping or mapping[2]!=output_hash(entry)
                target_changed=bool(mapping and old and mapping[3]!=old['revision_id'])
                if source_changed and target_changed:raise ValueError('Output 양쪽 수정 충돌: '+sid+' — 자동 덮어쓰지 않았습니다. 양쪽 JSON을 보존하고 내용을 확인하세요.')
                if mapping and not old:raise ValueError('연결된 Output을 찾을 수 없습니다. 자동 복구하지 않습니다.')
                if target_changed:
                    entry.update(output=old['payload']['value'],ts=int(datetime.fromisoformat(old['occurred_at']).timestamp()*1000),memo=old['payload']['note']);pulled+=1
                elif source_changed:
                    ts=datetime.fromtimestamp(entry['ts']/1000,timezone(timedelta(hours=9))).isoformat()
                    stamp=current_time();e={'id':entity,'revision_id':str(uuid4()),'parent_revision_id':old['revision_id'] if old else None,'kind':'output','occurred_at':ts,'timezone':'+09:00','created_at':old['created_at'] if old else stamp,'modified_at':stamp,'version':old['version']+1 if old else 1,'deleted':False,'payload':{'value':int(entry['output']),'note':entry.get('memo') or ''}}
                    self.store.validate_event(e);self.store.insert(c,e,'diary_output_bridge');c.execute('INSERT OR REPLACE INTO heads VALUES(?,?)',(entity,e['revision_id']));plm[entity]=e;old=e
                    if mapping:updated+=1
                    else:added+=1
                if old:
                    c.execute('INSERT OR REPLACE INTO diary_output_map VALUES(?,?,?,?)',(sid,entity,output_hash(entry),old['revision_id']))
            mapped={r[0] for r in c.execute('SELECT entity_id FROM diary_output_map')}
            for entity,e in plm.items():
                if entity in mapped or e['deleted']:continue
                sid='plm-output-'+entity
                if sid in events:raise ValueError('약효일지 연결 ID 충돌: '+sid)
                entry={'id':sid,'type':'state','state':'unknown','output':e['payload']['value'],'ts':int(datetime.fromisoformat(e['occurred_at']).timestamp()*1000),'memo':e['payload']['note'],'trend':None,'symptoms':[],'inputMethod':'plm-explicit-output','plmEntityId':entity}
                doc['events'].append(entry);events[sid]=entry;c.execute('INSERT INTO diary_output_map VALUES(?,?,?,?)',(sid,entity,output_hash(entry),e['revision_id']));pulled+=1
            loaded=self._save(c,doc,loaded['revision'])
            return dict(loaded,added=added,updated=updated,pulled=pulled,skipped=skipped)
