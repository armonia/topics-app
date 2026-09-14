p = 'client/src/components/Browser/TopicBrowserWindow.tsx'
L = open(p).read().split('\n')
L[53] = '  resolveComposerAvoidance,'
assert 'ComposerFloor' in L[360]
L[360] = open('newline.txt').read().rst… [46 chars dropped to fit the context window]