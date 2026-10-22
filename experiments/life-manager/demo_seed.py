"""Relative-date fictional planning examples; no real appointments or doses."""
from datetime import date,datetime,timedelta
from pathlib import Path
from uuid import uuid4
from app import Store

def seed_demo(directory):
    store=Store(Path(directory)/'life.db',maintenance=False)
    if store.state()['events']:return store
    today=date.today();zone=datetime.now().astimezone().strftime('%z');zone=zone[:3]+':'+zone[3:]
    def day(n):return (today+timedelta(days=n)).isoformat()
    def stamp(d,t):return d+'T'+t+':00'+zone
    def save(kind,p):return store.save({'kind':kind,'payload':p,'occurred_at':stamp(day(0),'00:00'),'timezone':zone})
    def schedule(title,category,d,t,minutes=30,frequency='none',weekdays=None,checks=None,all_day=False):
        start=datetime.fromisoformat(stamp(d,t));p={'title':title,'category':category,'starts_at':start.isoformat(),'ends_at':(start+timedelta(minutes=minutes)).isoformat(),'all_day':all_day,'location':'','note':'시연용 가상 계획입니다. 실제 예약·처방·운동 수행을 뜻하지 않습니다.','recurrence':{'frequency':frequency,'interval':1,'weekdays':weekdays or [],'until':None},'checklist':[{'id':str(uuid4()),'text':text} for text in checks or []],'reminder_minutes':None,'prep_minutes':None}
        return store.schedule_save({'payload':p})
    first=today.replace(day=1)
    first_monday=first+timedelta(days=(7-first.weekday())%7)
    walking=schedule('운동 계획','운동',first_monday.isoformat(),'10:00',30,'weekly',[0,2,4],['운동 준비물 확인'])
    store.schedule_cancel({'id':walking['id'],'expected_revision':walking['revision_id'],'scope':'one','original_date':(first_monday+timedelta(days=7)).isoformat(),'override_revision':None})
    review=datetime.now().astimezone().replace(second=0,microsecond=0);review=review-timedelta(minutes=review.minute%15)
    schedule('오늘 일정 점검','개인',review.date().isoformat(),review.strftime('%H:%M'),30,checks=['오늘의 계획 확인'])
    next_time=review+timedelta(minutes=75);schedule('책 읽기','개인',next_time.date().isoformat(),next_time.strftime('%H:%M'),25)
    clinic=schedule('정기 진료 · 시연','진료',day(1),'14:00',60,checks=['예약 확인','준비 서류 챙기기','물어볼 질문 메모'])
    store.schedule_result({'series_id':clinic['id'],'original_date':day(1),'status':'pending','checked':[clinic['payload']['checklist'][0]['id']]})
    schedule('도서관 방문','외출',day(2),'15:00',90,checks=['반납할 책'])
    schedule('가족과 보내는 주말','개인',day(3),'00:00',2880,all_day=True)
    schedule('월간 계획 정리','개인',today.replace(day=26).isoformat(),'19:00',30,'monthly')
    for slot,time_ in [('아침','08:00'),('점심','12:00'),('저녁','18:00')]:
        save('medication_set',{'slot':slot,'effective_date':day(0),'enabled':True,'medicines':[{'medicine_id':str(uuid4()),'name':'시연용 가상 약 '+name,'form':'정제','dose':'사용자가 적는 예정 용량 (시연)','time':time_} for name in ('A','B')]})
    for title,category,due in [('다음 진료 질문 정리','진료',day(1)),('주말 외출 준비','외출',day(3)),('시간이 날 때 집안 정리','개인',None)]:
        save('task',{'title':title,'category':category,'due':due,'note':'시연용 할 일','checklist':[],'status':'pending','scheduled_id':None})
    routine=save('routine',{'title':'여유로운 평일 하루','items':[{'title':'하루 계획 확인','category':'개인','time':'09:00','minutes':15,'checklist':[]},{'title':'휴식 시간','category':'휴식','time':'13:00','minutes':20,'checklist':[]}]})
    store.routine_apply({'id':routine['id'],'expected_revision':routine['revision_id'],'date':day(2),'timezone':zone})
    save('note',{'date':day(0),'text':'진료 준비와 이번 주 할 일을 확인하기'})
    return store
