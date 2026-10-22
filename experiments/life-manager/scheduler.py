"""Planning is separate from clinical events. All edits append revisions."""
import copy,json,sqlite3
from datetime import date,datetime,time,timedelta,timezone
from uuid import UUID,uuid4,uuid5

SCHEDULE_KINDS=('schedule','schedule_override','schedule_result','task','routine','routine_application')
CATEGORIES=('운동','진료','외출','개인','휴식')
def ident(value):
    if not isinstance(value,str) or str(UUID(value))!=value:raise ValueError('식별자 오류')
def string(value,required=True):
    if not isinstance(value,str) or len(value)>4000 or (required and not value.strip()):raise ValueError('내용을 확인하세요.')
def instant(value):
    d=datetime.fromisoformat(value)
    if d.tzinfo is None:raise ValueError('일정 시각에는 시간대가 필요합니다.')
    return d
def checklist(items):
    if not isinstance(items,list) or len(items)>50:raise ValueError('준비 항목은 50개까지 가능합니다.')
    ids=set()
    for item in items:
        if not isinstance(item,dict) or set(item)!={'id','text'}:raise ValueError('준비 항목 형식 오류')
        ident(item['id']);string(item['text'])
        if item['id'] in ids:raise ValueError('준비 항목 중복')
        ids.add(item['id'])
def schedule_payload(p):
    if not isinstance(p,dict) or set(p)!={'title','category','starts_at','ends_at','all_day','location','note','recurrence','checklist','reminder_minutes','prep_minutes'}:raise ValueError('일정 필드 오류')
    string(p['title']);string(p['location'],False);string(p['note'],False)
    if p['category'] not in CATEGORIES:raise ValueError('일정 종류 오류. 복약은 복약 세트에서 관리합니다.')
    a,b=instant(p['starts_at']),instant(p['ends_at'])
    if not timedelta(0)<b-a<=timedelta(days=31):raise ValueError('종료는 시작 이후이며 일정 길이는 31일 이하여야 합니다.')
    if a.utcoffset()!=b.utcoffset():raise ValueError('한 일정의 시작과 종료 오프셋은 같아야 합니다.')
    if type(p['all_day']) is not bool:raise ValueError('종일 여부 오류')
    if p['all_day'] and (a.time()!=time(0) or b.time()!=time(0)):raise ValueError('종일 일정의 시작·종료는 자정이어야 합니다. 종료일은 포함하지 않습니다.')
    r=p['recurrence']
    if not isinstance(r,dict) or set(r)!={'frequency','interval','weekdays','until'}:raise ValueError('반복 규칙 오류')
    if r['frequency'] not in ('none','daily','weekly','monthly') or type(r['interval']) is not int or not 1<=r['interval']<=365:raise ValueError('반복 간격 오류')
    if not isinstance(r['weekdays'],list) or len(set(r['weekdays']))!=len(r['weekdays']) or any(type(x) is not int or not 0<=x<=6 for x in r['weekdays']):raise ValueError('요일 선택 오류')
    if r['frequency']=='weekly' and not r['weekdays']:raise ValueError('반복 요일을 선택하세요.')
    if r['until'] is not None and date.fromisoformat(r['until'])<a.date():raise ValueError('반복 종료일은 시작일 이후여야 합니다.')
    for key in ('reminder_minutes','prep_minutes'):
        if p[key] is not None and (type(p[key]) is not int or not 0<=p[key]<=10080):raise ValueError('알림은 0~10080분 전 또는 사용 안 함입니다.')
    checklist(p['checklist'])
def validate_schedule_event(e):
    k,p=e['kind'],e['payload']
    if k=='schedule':schedule_payload(p)
    elif k=='schedule_override':
        if set(p)!={'series_id','original_date','cancelled','details'}:raise ValueError('개별 일정 예외 필드 오류')
        ident(p['series_id']);date.fromisoformat(p['original_date']);schedule_payload(p['details'])
        if type(p['cancelled']) is not bool:raise ValueError('취소 표시 오류')
        if e['id']!=override_id(p['series_id'],p['original_date']):raise ValueError('개별 일정 식별자 오류')
    elif k=='schedule_result':
        if set(p)!={'series_id','original_date','occurrence_id','status','checked','note','snapshot','linked_event_ids'}:raise ValueError('일정 실행 결과 필드 오류')
        ident(p['series_id']);date.fromisoformat(p['original_date']);ident(p['occurrence_id']);schedule_payload(p['snapshot']);string(p['note'],False)
        if p['occurrence_id']!=occurrence_id(p['series_id'],p['original_date']) or e['id']!=result_id(p['occurrence_id']):raise ValueError('일정 결과 식별자 오류')
        if p['status'] not in ('pending','done','not_done'):raise ValueError('일정 실행 상태 오류')
        if not isinstance(p['checked'],list) or len(p['checked'])!=len(set(p['checked'])) or set(p['checked'])-{x['id'] for x in p['snapshot']['checklist']}:raise ValueError('준비 확인 항목 오류')
        if not isinstance(p['linked_event_ids'],list) or len(p['linked_event_ids'])>50:raise ValueError('기록 연결 오류')
        for linked in p['linked_event_ids']:ident(linked)
    elif k=='task':
        if set(p)!={'title','category','due','note','checklist','status','scheduled_id'}:raise ValueError('할 일 필드 오류')
        string(p['title']);string(p['note'],False);checklist(p['checklist'])
        if p['category'] not in CATEGORIES or p['status'] not in ('pending','done','not_done','scheduled'):raise ValueError('할 일 상태 오류')
        if p['due'] is not None:date.fromisoformat(p['due'])
        if p['scheduled_id'] is not None:ident(p['scheduled_id'])
        if (p['status']=='scheduled')!=(p['scheduled_id'] is not None):raise ValueError('할 일의 일정 연결 오류')
    elif k=='routine':
        if set(p)!={'title','items'}:raise ValueError('하루 틀 필드 오류')
        string(p['title'])
        if not isinstance(p['items'],list) or not 1<=len(p['items'])<=30:raise ValueError('하루 틀은 1~30개 일정으로 만드세요.')
        for item in p['items']:
            if set(item)!={'title','category','time','minutes','checklist'}:raise ValueError('하루 틀 일정 오류')
            string(item['title']);time.fromisoformat(item['time']);checklist(item['checklist'])
            if len(item['time'])!=5 or item['category'] not in CATEGORIES or type(item['minutes']) is not int or not 1<=item['minutes']<=1440:raise ValueError('하루 틀 시간 오류')
    elif k=='routine_application':
        if set(p)!={'routine_id','routine_revision_id','date','schedule_ids'}:raise ValueError('하루 틀 적용 오류')
        ident(p['routine_id']);ident(p['routine_revision_id']);date.fromisoformat(p['date'])
        if not isinstance(p['schedule_ids'],list) or len(p['schedule_ids'])>30:raise ValueError('하루 틀 적용 수 오류')
        for value in p['schedule_ids']:ident(value)
        if e['id']!=str(uuid5(UUID(p['routine_id']),'application|'+p['date'])):raise ValueError('하루 틀 적용 식별자 오류')
def occurrence_id(series,day):return str(uuid5(UUID(series),'occurrence|'+day))
def override_id(series,day):return str(uuid5(UUID(series),'override|'+day))
def result_id(occurrence):return str(uuid5(UUID(occurrence),'result'))
def matches(p,day):
    first=instant(p['starts_at']).date();r=p['recurrence']
    if day<first or (r['until'] and day>date.fromisoformat(r['until'])):return False
    if r['frequency']=='none':return day==first
    if r['frequency']=='daily':return (day-first).days%r['interval']==0
    if r['frequency']=='weekly':
        weeks=((day-timedelta(days=day.weekday()))-(first-timedelta(days=first.weekday()))).days//7
        return weeks%r['interval']==0 and day.weekday() in r['weekdays']
    months=(day.year-first.year)*12+day.month-first.month
    return months%r['interval']==0 and day.day==first.day
def materialize(p,day):
    first=instant(p['starts_at']);end=instant(p['ends_at']);start=datetime.combine(day,first.timetz())
    result=copy.deepcopy(p);result['starts_at']=start.isoformat();result['ends_at']=(start+(end-first)).isoformat();return result

class SchedulerServices:
    def _head(self,c,entity):
        row=c.execute('SELECT r.body FROM revisions r JOIN heads h ON h.revision_id=r.revision_id WHERE h.entity_id=?',(entity,)).fetchone()
        return json.loads(row[0]) if row else None
    def _write(self,c,kind,payload,entity,expected=None,deleted=False):
        old=self._head(c,entity)
        if (old['revision_id'] if old else None)!=expected:raise ValueError('다른 수정이 있습니다. 다시 열어 확인하세요.')
        if old and old['kind']!=kind:raise ValueError('기록 종류 변경 불가')
        now=datetime.now(timezone.utc).isoformat()
        e={'id':entity,'revision_id':str(uuid4()),'parent_revision_id':old['revision_id'] if old else None,'kind':kind,'occurred_at':now,'timezone':'+00:00','created_at':old['created_at'] if old else now,'modified_at':now,'version':old['version']+1 if old else 1,'deleted':deleted,'payload':copy.deepcopy(payload)}
        self.validate_event(e);self.insert(c,e,'scheduler_edit' if old else 'scheduler_create');c.execute('INSERT OR REPLACE INTO heads VALUES(?,?)',(entity,e['revision_id']));return e
    def _scheduler_backup(self):
        if self.maintenance:
            try:self.auto_backup()
            except (OSError,ValueError,sqlite3.Error) as ex:self.backup_error='자동 백업 실패: '+str(ex)
    def scheduler_range(self,start,end,zone='+09:00',include_meds=True):
        a,b=date.fromisoformat(start),date.fromisoformat(end)
        if not 0<(b-a).days<=93:raise ValueError('일정 조회는 1~93일 범위로 선택하세요.')
        instant(start+'T00:00:00'+zone)
        state=self.state();events=[e for e in state['events'] if not e['deleted']]
        series={e['id']:e for e in events if e['kind']=='schedule'}
        override_heads={e['id']:e for e in state['events'] if e['kind']=='schedule_override'}
        overrides={eid:e for eid,e in override_heads.items() if not e['deleted']}
        result_heads={e['payload']['occurrence_id']:e for e in state['events'] if e['kind']=='schedule_result'}
        results={eid:e for eid,e in result_heads.items() if not e['deleted']}
        occurrences={}
        def add(s,day,p,override=None):
            oid=occurrence_id(s['id'],day);r=results.get(oid)
            if r and r['payload']['status']!='pending':p=r['payload']['snapshot']
            if instant(p['starts_at']).date()<b and instant(p['ends_at'])>instant(start+'T00:00:00'+zone):
                occurrences[oid]={'id':oid,'series_id':s['id'],'original_date':day,'details':p,'series_revision':s['revision_id'],'override':override or override_heads.get(override_id(s['id'],day)),'result':r or result_heads.get(oid),'source':'schedule'}
        for s in series.values():
            p=s['payload'];duration=(instant(p['ends_at'])-instant(p['starts_at'])).days+1
            day=max(instant(p['starts_at']).date(),a-timedelta(days=duration))
            while day<b:
                original=day.isoformat()
                if matches(p,day):
                    override=overrides.get(override_id(s['id'],original))
                    if not override:add(s,original,materialize(p,day))
                    elif not override['payload']['cancelled']:add(s,original,override['payload']['details'],override)
                day+=timedelta(days=1)
        # A moved occurrence can enter the range from a different original date.
        for o in overrides.values():
            p=o['payload'];s=series.get(p['series_id'])
            if s and not p['cancelled']:add(s,p['original_date'],p['details'],o)
        # Completed/explicitly not-done snapshots survive series edits and cancellation.
        for r in results.values():
            p=r['payload']
            if p['status']!='pending' and p['occurrence_id'] not in occurrences:
                s=series.get(p['series_id']) or {'id':p['series_id'],'revision_id':None}
                add(s,p['original_date'],p['snapshot'])
        items=list(occurrences.values())
        if include_meds:
            day=a
            while day<b:
                groups={}
                for p in self.day(day.isoformat(),zone)['plans']:groups.setdefault((p['set_id'],p['scheduled_at']),[]).append(p)
                for (sid,scheduled),medicines in groups.items():
                    p=medicines[0]
                    items.append({'id':str(uuid5(UUID(sid),'calendar|'+scheduled)),'source':'medication','details':{'title':p['slot']+' 복약 세트 · '+str(len(medicines))+'개 약','category':'복약','starts_at':scheduled,'ends_at':(instant(scheduled)+timedelta(minutes=1)).isoformat(),'all_day':False,'location':'','note':'예정시각 표시. 실제 기록은 복약 화면에서 확인합니다.','checklist':[]},'medication':p,'medications':medicines})
                day+=timedelta(days=1)
        items.sort(key=lambda x:(instant(x['details']['starts_at']),x['id']))
        conflicts=[]
        for i,x in enumerate(items):
            if x['details']['all_day']:continue
            for y in items[i+1:]:
                if instant(y['details']['starts_at'])>=instant(x['details']['ends_at']):break
                if not y['details']['all_day'] and x['id']!=y['id'] and not (x['source']=='medication' and y['source']=='medication'):conflicts.append([x['id'],y['id']])
        return {'start':start,'end':end,'items':items,'overlaps':conflicts,'tasks':[e for e in events if e['kind']=='task'],'routines':[e for e in events if e['kind']=='routine']}
    def schedule_preview(self,payload,exclude_series=None,exclude_occurrence=None):
        schedule_payload(payload);day=instant(payload['starts_at']).date();end=min(instant(payload['ends_at']).date()+timedelta(days=1),day+timedelta(days=32))
        zone=payload['starts_at'][-6:];data=self.scheduler_range(day.isoformat(),end.isoformat(),zone)
        return {'overlaps':sorted({x['details']['title'] for x in data['items'] if x['id']!=exclude_occurrence and (exclude_occurrence is not None or exclude_series is None or x.get('series_id')!=exclude_series) and not payload['all_day'] and not x['details']['all_day'] and instant(x['details']['starts_at'])<instant(payload['ends_at']) and instant(x['details']['ends_at'])>instant(payload['starts_at'])})}
    def schedule_save(self,body):
        p=copy.deepcopy(body['payload']);schedule_payload(p);scope=body.get('scope','all');entity=body.get('id') or str(uuid4());ident(entity)
        if scope not in ('all','one','following'):raise ValueError('변경 범위 오류')
        with self.guard,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');old=self._head(c,entity)
            if old and (old['kind']!='schedule' or old['deleted']):raise ValueError('활성 일정이 아닙니다.')
            if (old['revision_id'] if old else None)!=body.get('expected_revision'):raise ValueError('일정이 변경되었습니다. 다시 열어 주세요.')
            if not old or scope=='all':result=self._write(c,'schedule',p,entity,body.get('expected_revision'))
            else:
                day=date.fromisoformat(body['original_date']);oid=occurrence_id(entity,day.isoformat());record=self._head(c,result_id(oid))
                if record and not record['deleted'] and record['payload']['status']!='pending':raise ValueError('실행 결과가 있는 개별 일정은 계획을 이동할 수 없습니다. 실행 결과를 먼저 기록 전으로 변경하세요.')
                override=self._head(c,override_id(entity,day.isoformat()))
                if not matches(old['payload'],day) and not override:raise ValueError('반복 규칙에 없는 날짜입니다.')
                if scope=='one':
                    expected=body.get('override_revision')
                    result=self._write(c,'schedule_override',{'series_id':entity,'original_date':day.isoformat(),'cancelled':False,'details':p},override_id(entity,day.isoformat()),expected)
                else:
                    cutoff=copy.deepcopy(old['payload']);cutoff['recurrence']['until']=(day-timedelta(days=1)).isoformat()
                    self._write(c,'schedule',old['payload'] if day<=instant(old['payload']['starts_at']).date() else cutoff,entity,old['revision_id'],deleted=day<=instant(old['payload']['starts_at']).date())
                    for (raw,) in c.execute("SELECT r.body FROM revisions r JOIN heads h ON h.revision_id=r.revision_id WHERE r.kind='schedule_override'").fetchall():
                        e=json.loads(raw)
                        if not e['deleted'] and e['payload']['series_id']==entity and e['payload']['original_date']>=day.isoformat():self._write(c,'schedule_override',e['payload'],e['id'],e['revision_id'],deleted=True)
                    new_id=body.get('new_id') or str(uuid4());ident(new_id);result=self._write(c,'schedule',p,new_id)
            self.operation(c,'schedule_save',{'id':entity,'scope':scope})
        self._scheduler_backup();return result
    def schedule_cancel(self,body):
        entity=body['id'];scope=body.get('scope','one')
        if scope not in ('one','following','all'):raise ValueError('취소 범위 오류')
        with self.guard,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');e=self._head(c,entity)
            if not e or e['kind']!='schedule' or e['deleted'] or e['revision_id']!=body['expected_revision']:raise ValueError('일정이 변경되었습니다.')
            if scope=='all':result=self._write(c,'schedule',e['payload'],entity,e['revision_id'],True)
            else:
                day=date.fromisoformat(body['original_date']);o=self._head(c,override_id(entity,day.isoformat()))
                if not matches(e['payload'],day) and not o:raise ValueError('취소할 일정이 없습니다.')
                if scope=='one':result=self._write(c,'schedule_override',{'series_id':entity,'original_date':day.isoformat(),'cancelled':True,'details':copy.deepcopy(o['payload']['details'] if o and not o['deleted'] else materialize(e['payload'],day))},override_id(entity,day.isoformat()),body.get('override_revision'))
                else:
                    p=copy.deepcopy(e['payload']);p['recurrence']['until']=(day-timedelta(days=1)).isoformat()
                    result=self._write(c,'schedule',e['payload'] if day<=instant(e['payload']['starts_at']).date() else p,entity,e['revision_id'],day<=instant(e['payload']['starts_at']).date())
                    for (raw,) in c.execute("SELECT r.body FROM revisions r JOIN heads h ON h.revision_id=r.revision_id WHERE r.kind='schedule_override'").fetchall():
                        override=json.loads(raw)
                        if not override['deleted'] and override['payload']['series_id']==entity and override['payload']['original_date']>=day.isoformat():self._write(c,'schedule_override',override['payload'],override['id'],override['revision_id'],True)
        self._scheduler_backup();return result
    def schedule_result(self,body):
        series,day=body['series_id'],body['original_date'];ident(series);date.fromisoformat(day)
        oid=occurrence_id(series,day);rid=result_id(oid)
        with self.guard,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');master=self._head(c,series);old=self._head(c,rid)
            if body.get('series_revision') is not None and (not master or master['revision_id']!=body['series_revision']):raise ValueError('일정이 변경되었습니다. 다시 열어 실행 결과를 확인하세요.')
            if old and not old['deleted'] and old['payload']['status']!='pending':snapshot=old['payload']['snapshot']
            else:
                if not master or master['kind']!='schedule' or master['deleted']:raise ValueError('일정이 없습니다.')
                override=self._head(c,override_id(series,day))
                if override and not override['deleted']:
                    if override['payload']['cancelled']:raise ValueError('취소된 일정입니다.')
                    snapshot=override['payload']['details']
                elif matches(master['payload'],date.fromisoformat(day)):snapshot=materialize(master['payload'],date.fromisoformat(day))
                else:raise ValueError('일정이 없습니다.')
            linked=body.get('linked_event_ids',old['payload']['linked_event_ids'] if old else [])
            for eid in linked:
                clinical=self._head(c,eid)
                if not clinical or clinical['deleted'] or clinical['kind'] not in ('exercise','medication','output','motor_state','dyskinesia','dystonia','freezing'):raise ValueError('연결할 실제 기록이 없습니다.')
            result=self._write(c,'schedule_result',{'series_id':series,'original_date':day,'occurrence_id':oid,'status':body['status'],'checked':body.get('checked',[]),'note':body.get('note',''),'snapshot':snapshot,'linked_event_ids':linked},rid,body.get('expected_revision'))
        self._scheduler_backup();return result
    def task_schedule(self,body):
        p=body['payload'];schedule_payload(p)
        with self.guard,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');task=self._head(c,body['task_id'])
            if not task or task['kind']!='task' or task['deleted'] or task['revision_id']!=body['expected_revision'] or task['payload']['status']!='pending':raise ValueError('할 일이 변경되었거나 이미 배치되었습니다.')
            sid=body.get('schedule_id') or str(uuid4());ident(sid);created=self._write(c,'schedule',p,sid)
            tp=copy.deepcopy(task['payload']);tp.update(status='scheduled',scheduled_id=sid);self._write(c,'task',tp,task['id'],task['revision_id'])
        self._scheduler_backup();return created
    def clear_exception(self,body):
        with self.guard,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');old=self._head(c,body['id'])
            if not old or old['kind']!='schedule_override' or old['deleted']:raise ValueError('해제할 개별 변경이 없습니다.')
            result=self._write(c,old['kind'],old['payload'],old['id'],body['expected_revision'],True)
        self._scheduler_backup();return result
    def routine_apply(self,body):
        day=date.fromisoformat(body['date']);zone=body['timezone'];instant(day.isoformat()+'T00:00:00'+zone)
        with self.guard,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');r=self._head(c,body['id'])
            if not r or r['kind']!='routine' or r['deleted'] or r['revision_id']!=body['expected_revision']:raise ValueError('하루 틀이 변경되었습니다.')
            application=str(uuid5(UUID(r['id']),'application|'+day.isoformat()))
            if self._head(c,application):raise ValueError('이 날짜에 이미 적용한 하루 틀입니다.')
            ids=[]
            for index,item in enumerate(r['payload']['items']):
                start=instant(day.isoformat()+'T'+item['time']+':00'+zone);sid=str(uuid5(UUID(application),str(index)));ids.append(sid)
                p={'title':item['title'],'category':item['category'],'starts_at':start.isoformat(),'ends_at':(start+timedelta(minutes=item['minutes'])).isoformat(),'all_day':False,'location':'','note':'하루 틀: '+r['payload']['title'],'recurrence':{'frequency':'none','interval':1,'weekdays':[],'until':None},'checklist':item['checklist'],'reminder_minutes':None,'prep_minutes':None}
                self._write(c,'schedule',p,sid)
            result=self._write(c,'routine_application',{'routine_id':r['id'],'routine_revision_id':r['revision_id'],'date':day.isoformat(),'schedule_ids':ids},application)
        self._scheduler_backup();return result
    def scheduler_reminders(self,current=None):
        if not self.settings().get('schedule_reminders'):return []
        now=current or datetime.now().astimezone();zone=now.strftime('%z');zone=zone[:3]+':'+zone[3:]
        data=self.scheduler_range((now.date()-timedelta(days=1)).isoformat(),(now.date()+timedelta(days=8)).isoformat(),zone,False)
        with self.connect() as c:logged={r[0] for r in c.execute('SELECT plan_id FROM reminder_log')}
        due=[]
        for item in data['items']:
            if item['result'] and not item['result']['deleted'] and item['result']['payload']['status']!='pending':continue
            p=item['details']
            for key,label in (('reminder_minutes','일정 알림'),('prep_minutes','준비 알림')):
                if p[key] is None:continue
                at=instant(p['starts_at'])-timedelta(minutes=p[key]);rid=str(uuid5(UUID(item['id']),key))
                if rid not in logged and timedelta(0)<=now-at<=timedelta(minutes=30):due.append({'id':rid,'occurrence_id':item['id'],'title':p['title'],'label':label,'at':at.isoformat(),'starts_at':p['starts_at'],'series_id':item['series_id'],'original_date':item['original_date']})
        return due
