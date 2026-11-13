import re
p = r'D:\Users\ErrorAnti\Documents\deepseek-harness\tnv2-ab-20261112\temp\wt-aligned\src\storyboard\cuts.js'
src = open(p, encoding='utf-8').read()
start_marker = '/**\n * **多长的转场才可能是'
i = src.find(start_marker)
assert i > 0, 'block start not found'
end_marker = 'export function isFlashTransition(cut) {'
j = src.find(end_marker, i)
assert j > 0
# 函数体结束：从 j 起找到第一个 "\n}\n"
k = src.find('\n}\n', j)
assert k > 0
block = src[i:k+3]
rest = src[:i] + src[k+3:]
# 插到 resolveCuts 之前
anchor = 'export function resolveCuts({'
m = rest.find(anchor)
assert m > 0, 'resolveCuts not found'
out = rest[:m] + block + '\n' + rest[m:]
open(p, 'w', encoding='utf-8').write(out)
print('moved', len(block), 'chars; new len', len(out))
