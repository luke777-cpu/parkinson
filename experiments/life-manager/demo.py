"""Separate demonstration database; never seeds the user's normal life.db."""
import json,sys
from pathlib import Path
import app

root=Path(__file__).resolve().parent
directory=root/'demo-data'
if not (directory/'life.db').exists():
    from demo_seed import seed_demo
    seed_demo(directory)
from diary_bridge import DiaryBridge
from datetime import datetime
bridge=DiaryBridge(app.Store(directory/'life.db',maintenance=False))
if bridge.load()['document'] is None:
    bridge.save({'expected_revision':None,'document':{'events':[{'id':'demonstration-output-only','type':'state','state':'unknown','output':65,'ts':int(datetime.now().timestamp()*1000),'memo':'가상 시연 기록','trend':None,'symptoms':[]}],'meds':[],'settings':{'seen':True,'lang':'ko'},'questions':[],'dayMemos':{},'outputChecks':[]}})
sys.argv=[str(root/'app.py'),'--data-dir',str(directory)]+sys.argv[1:]
app.main()
