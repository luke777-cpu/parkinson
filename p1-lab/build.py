"""Build the single-file download and the versioned, offline-capable web app."""
import argparse
from pathlib import Path

VERSION = '1.1.1'
p = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--web-only', action='store_true', help='Build web entry without bundling the standalone download')
args = parser.parse_args()
shell = (p / 'shell.html').read_text(encoding='utf-8').replace('v1.1.0', 'v' + VERSION)
files = [('ENGINE', 'engine.js'), ('CORE', 'core.js'), ('MEDICATION', 'medication.js'), ('APP', 'app.js')]

def inject(source, inline):
    for tag, file in files:
        script = '<script>\n' + (p / file).read_text(encoding='utf-8') + '\n</script>' if inline else f'<script src="./{file}?v={VERSION}"></script>'
        if tag == 'APP':
            script += '\n' + ('<script>\n' + (p / 'dedup-ui.js').read_text(encoding='utf-8') + '\n</script>' if inline else f'<script src="./dedup-ui.js?v={VERSION}"></script>')
        source = source.replace('<!--' + tag + '-->', script)
    return source

if not args.web_only:
    (p / 'P1-Lab.html').write_text(inject(shell, True), encoding='utf-8')
if (p / 'pwa.js').exists():
    web = inject(shell, False)
    web = web.replace('<title>P1', '<link rel="manifest" href="./manifest.webmanifest"><link rel="icon" href="./icon.svg"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="P1 실험실"><title>P1', 1)
    web = web.replace('</html>', f'<script src="./pwa.js?v={VERSION}"></script></html>')
    (p / 'index.html').write_text(web, encoding='utf-8')
