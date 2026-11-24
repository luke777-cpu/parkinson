"""Explicit offline file adapter. No external app or network connection is implied."""
import argparse,json,os
from pathlib import Path
from app import Store,SyncAdapter

class EnvelopeFileAdapter(SyncAdapter):
    def __init__(self,path):self.path=Path(path)
    def pull(self):
        if self.path.stat().st_size>20*1024*1024:raise ValueError('교환 파일은 20MB 이하로 사용하세요.')
        return json.loads(self.path.read_text(encoding='utf-8-sig'))
    def push(self,envelope):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temporary=self.path.with_name(self.path.name+'.writing')
        try:
            temporary.write_text(json.dumps(envelope,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temporary,self.path)
        finally:
            if temporary.exists():temporary.unlink()

def exchange(store,inbox,outbox):
    if Path(inbox).resolve()==Path(outbox).resolve():raise ValueError('받는 파일과 보내는 파일은 다르게 지정하세요.')
    result=store.import_json(EnvelopeFileAdapter(inbox).pull())
    try:EnvelopeFileAdapter(outbox).push(store.export())
    except OSError as ex:raise RuntimeError('가져오기는 저장되었습니다. 내보내기 파일 저장이 실패했습니다. 같은 입력으로 재시도해도 중복되지 않습니다: '+str(ex))
    return result

def main():
    p=argparse.ArgumentParser(description='PLM offline adapter; external diary mapping not connected')
    p.add_argument('--db',required=True);sub=p.add_subparsers(dest='command',required=True)
    for name in ('export','preview','import'):
        action=sub.add_parser(name);action.add_argument('file')
    action=sub.add_parser('exchange');action.add_argument('inbox');action.add_argument('outbox')
    args=p.parse_args();store=Store(args.db)
    if args.command=='export':EnvelopeFileAdapter(args.file).push(store.export());result={'exported':args.file}
    elif args.command=='preview':result=store._import(EnvelopeFileAdapter(args.file).pull(),dry=True)
    elif args.command=='import':result=store.import_json(EnvelopeFileAdapter(args.file).pull())
    else:result=exchange(store,args.inbox,args.outbox)
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
