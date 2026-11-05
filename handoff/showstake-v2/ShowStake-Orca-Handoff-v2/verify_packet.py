"""Static packet checks; not a substitute for PostgreSQL or application tests."""
from pathlib import Path
import re,json
root=Path(__file__).resolve().parent
required=['00-START-HERE.md','01-PRODUCT.md','02-ARCHITECTURE.md','03-DATABASE.md','schema.sql','04-DESIGN-SYSTEM.md','tokens.css','05-EXECUTION-AND-TESTS.md','06-DECISIONS-AND-SOURCES.md']
for name in required:
    assert (root/name).is_file(),name
tests=re.findall(r'^\| ([A-Z]\d{2}) \|', (root/'05-EXECUTION-AND-TESTS.md').read_text(encoding='utf-8'),re.M)
assert len(tests)==len(set(tests))
for p in root.glob('*.md'):
    assert len(re.findall(r'^```',p.read_text(encoding='utf-8'),re.M))%2==0,p.name
css=(root/'tokens.css').read_text(encoding='utf-8')
colors=dict(re.findall(r'--color-([\w-]+):\s*(#[0-9a-fA-F]{6})',css))
def lum(h):
    v=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    v=[c/12.92 if c<=0.04045 else ((c+.055)/1.055)**2.4 for c in v]
    return sum(c*w for c,w in zip(v,[.2126,.7152,.0722]))
pairs=[('text','canvas',4.5),('muted','canvas',4.5),('text','surface',4.5),('muted','surface',4.5),('on-primary','primary',4.5),('on-primary','primary-hover',4.5),('success','success-bg',4.5),('warning','warning-bg',4.5),('error','error-bg',4.5),('control-border','surface',3),('control-border','canvas',3),('focus','surface',3)]
out=[]
for fg,bg,minimum in pairs:
    a,b=sorted([lum(colors[fg]),lum(colors[bg])]);ratio=(b+.05)/(a+.05)
    out.append({'foreground':fg,'background':bg,'ratio':round(ratio,2),'minimum':minimum,'pass':ratio>=minimum})
assert all(x['pass'] for x in out),out
sql=(root/'schema.sql').read_text(encoding='utf-8')
tables=re.findall(r'CREATE TABLE (\w+)',sql)
assert len(tables)==len(set(tables))
result={'files_present':len(required),'unique_acceptance_tests':len(tests),'tables':len(tables),'contrast_checks':out,'sql_runtime_validation':'NOT_RUN','application_tests':'NOT_RUN'}
try:
    from pglast import parse_sql
    result['sql_parser_statements']=len(parse_sql(sql))
    result['sql_syntax_parser']='PASS'
except ImportError:
    result['sql_syntax_parser']='NOT_RUN (pglast unavailable)'
(root/'VALIDATION.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,indent=2))
