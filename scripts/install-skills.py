#!/usr/bin/env python3
"""Install/check complete Hypit project skills without touching global skills."""
import argparse
import hashlib
import json
import shutil
import tempfile
import uuid
from pathlib import Path


def inventory(folder):
    if not folder.is_dir():
        return None
    files = list(folder.rglob('*'))
    if any(p.is_symlink() for p in files):
        raise ValueError('技能必须是完整实体文件，不使用指向其他电脑的链接')
    return {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files if p.is_file()}


def install(root, agents, check_only=False):
    manifest = json.loads((root / 'docs/hypit-skill-files.json').read_text())['sha256']
    canonical = root / 'hypit/skills/hypit'
    if not canonical.is_dir():
        canonical = root / '.agents/skills/hypit'
    if inventory(canonical) != manifest or 'SKILL.md' not in manifest:
        raise ValueError('完整 Hypit 技能或参考文件缺失/已改变，请重新下载配套工具包')
    paths = {'codex': '.agents/skills/hypit', 'claude-code': '.claude/skills/hypit'}
    results = []
    for agent in agents:
        target = root / paths[agent]
        # Avoid writes through a pre-existing link into another project/user scope.
        if any(p.is_symlink() for p in [target, *target.parents] if p != root.parent):
            raise ValueError('技能目标目录含链接，请让 AI 核对实际项目目录后处理')
        if inventory(target) == manifest:
            results.append(f'{agent}：完整技能已就绪（{len(manifest)} 个文件）')
            continue
        if check_only:
            raise ValueError(f'{agent} 技能缺失或不匹配：请执行 python3 scripts/install-skills.py')
        target.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.hypit-install-', dir=target.parent))
        staged_skill = stage / 'hypit'
        backup = None
        try:
            shutil.copytree(canonical, staged_skill)
            if inventory(staged_skill) != manifest:
                raise ValueError('技能复制校验失败，未替换现有技能')
            if target.exists():
                backup = root / '.skill-backups' / uuid.uuid4().hex / agent / 'hypit'
                backup.parent.mkdir(parents=True, exist_ok=True)
                target.rename(backup)
            try:
                staged_skill.rename(target)
            except Exception:
                if backup is not None:
                    backup.rename(target)
                raise
        finally:
            shutil.rmtree(stage)
        results.append(f'{agent}：已安装完整技能（{len(manifest)} 个文件）'
                       + ('；旧版本已保存在 .skill-backups' if backup else ''))
    return results


def main():
    parser = argparse.ArgumentParser(description='安装或检查本项目完整 Hypit Skill，无模型调用、不改全局技能')
    parser.add_argument('--agent', choices=['codex', 'claude-code', 'all'], default='all')
    parser.add_argument('--check', action='store_true', help='仅核对文件，不安装、不覆盖')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    agents = ['codex', 'claude-code'] if args.agent == 'all' else [args.agent]
    try:
        for result in install(root, agents, args.check):
            print(result)
        print('文件检查不等于当前会话已经加载技能。请打开本工具目录，在下一轮选择 hypit；'
              'Codex 可用 $hypit，Claude Code 可用 /hypit。未识别时让 AI 直接读取项目 SKILL.md。')
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f'技能安装/检查失败：{error}\n')


if __name__ == '__main__':
    main()
