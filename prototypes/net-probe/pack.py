# 打包给公司网络测试用的压缩包（含 materials.json，压缩包不提交，只私下发送）。
# 用法：先把 ../suggest-hit/materials.json 复制到 extension/，再 python -X utf8 pack.py
import os
import zipfile

with zipfile.ZipFile('网络诊断包.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in ['安装步骤.md', '回填表.md']:
        z.write(f, '网络诊断包/' + f)
    for f in sorted(os.listdir('extension')):
        z.write('extension/' + f, '网络诊断包/extension/' + f)
