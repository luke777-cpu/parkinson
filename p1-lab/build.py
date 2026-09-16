from pathlib import Path
p=Path(__file__).resolve().parent
s=(p/'shell.html').read_text(encoding='utf-8')
for tag,file in [('ENGINE','engine.js'),('CORE','core.js'),('MEDICATION','medication.js'),('APP','app.js')]:
    s=s.replace('<!--'+tag+'-->','<script>\n'+(p/file).read_text(encoding='utf-8')+'\n</script>')
(p/'P1-Lab.html').write_text(s, encoding='utf-8')
if (p/'pwa.js').exists():
    web=s.replace('<title>P1','<link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon.svg"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="P1 실험실"><title>P1',1)
    web=web.replace('</html>','<script>\n'+(p/'pwa.js').read_text(encoding='utf-8')+'\n</script></html>')
    (p/'index.html').write_text(web, encoding='utf-8')
