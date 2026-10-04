from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'文件校验清单.json').read_text())
errors=[]
for rel,expected in manifest['sha256'].items():
 p=root/rel
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected: errors.append(rel)
if errors:
 print('校验失败：'+'、'.join(errors));sys.exit(1)
print(f"源码与文档校验通过，共 {len(manifest['sha256'])} 个文件。未检查 API 配置或出片质量。")
