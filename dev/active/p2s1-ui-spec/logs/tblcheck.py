import sys,re
bad=0
for p in sys.argv[1:]:
    lines=open(p).read().split('\n'); infence=False; hdr=None
    for n,l in enumerate(lines,1):
        if l.startswith('```'): infence=not infence; continue
        if infence: continue
        if l.startswith('|'):
            c=len(re.findall(r'(?<!\\)\|', re.sub(r'`[^`]*`','',l)))
            if hdr is None: hdr=(c,n)
            elif c!=hdr[0]: print(f'{p}:{n} cols {c} != header {hdr[0]} (line {hdr[1]})'); bad+=1
        else: hdr=None
print('mismatches', bad)
