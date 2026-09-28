#!/usr/bin/env python3
"""Local source update only. No Git/network calls. Dry-run unless explicitly approved.
Never run against a VPS or a working production directory. See docs/SAFE-UPDATE.md.
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path, PurePosixPath

SOURCE = Path(__file__).resolve().parents[1]
BLOCKED_DIRS = {'.git', 'node_modules', 'uploads', 'backups', 'nova-sms-backups', 'logs', 'exports', '.ssh'}
PLACEHOLDERS = {'data/chat_uploads/.gitkeep', 'data/chat_voice/.gitkeep'}

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def validate_name(name, deletion=False):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '\\' in name or ':' in name or '..' in p.parts:
        raise ValueError('Unsafe manifest path: ' + name)
    if set(p.parts) & BLOCKED_DIRS or ('data' in p.parts and name not in PLACEHOLDERS):
        raise ValueError('Protected directory in manifest: ' + name)
    n = p.name.lower()
    if n.startswith('.env') and n != '.env.example':
        raise ValueError('Environment file in source manifest: ' + name)
    if any(x in n for x in ['.sqlite', '.db-wal', '.db-shm']) or n.endswith(('.db', '.pem', '.key', '.p12', '.pfx', '.jks')):
        raise ValueError('Persistent/secret path in manifest: ' + name)
    if n.endswith('.keystore') and not (deletion and name == 'mobile-app/galaxy-release.keystore'):
        raise ValueError('Secret path in manifest: ' + name)
    return p

def ensure_plain(root, name):
    p = root
    for part in PurePosixPath(name).parts:
        p = p / part
        if p.is_symlink():
            raise ValueError('Refusing symlink: ' + str(p))
    if p.exists() and not p.is_file():
        raise ValueError('Expected file, found directory: ' + str(p))
    return p

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--target', required=True, help='Separate local clean clone, NOT VPS')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--confirm-local-clone', action='store_true')
    args = ap.parse_args()
    raw = Path(args.target).expanduser().absolute()
    if any(p.is_symlink() for p in [raw, *raw.parents]):
        raise ValueError('Target/ancestor symlinks are not allowed')
    target = raw.resolve()
    if not (target / '.git').is_dir() or (target / '.git').is_symlink():
        raise ValueError('Target must be a separate local clone with a real .git directory')
    if target == SOURCE or SOURCE in target.parents or target in SOURCE.parents:
        raise ValueError('Source and target must be separate, non-nested directories')
    # Fail closed for obvious runtime/config data. Never inspect secret contents.
    for p in target.rglob('*'):
        relative = p.relative_to(target)
        if '.git' in relative.parts or 'node_modules' in relative.parts:
            continue
        if p.is_symlink():
            raise ValueError('Target contains a symlink; review manually: ' + str(relative))
        n = p.name.lower()
        if p.is_file() and ((n.startswith('.env') and n != '.env.example') or '.sqlite' in n or n.endswith(('.db', '.pem', '.key', '.p12', '.pfx')) or (set(relative.parts) & {'uploads', 'backups', 'nova-sms-backups', 'exports'}) or ('data' in relative.parts and p.name != '.gitkeep')):
            raise ValueError('Target contains potential persistent data/secrets. STOP; use a separate clean local clone: ' + str(relative))
    manifest_path = SOURCE / 'release/source-manifest.json'
    entries = json.loads(manifest_path.read_text(encoding='utf-8'))['files']
    names = [e['path'] for e in entries]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate source manifest paths')
    for e in entries:
        validate_name(e['path'])
        src = ensure_plain(SOURCE, e['path'])
        if not src.is_file() or digest(src) != e['sha256']:
            raise ValueError('Source missing/changed: ' + e['path'] + '; use intact release')
    # Manifest omits its own digest; include the manifest itself in the copy plan.
    names.append('release/source-manifest.json')
    obsolete = [s.strip() for s in (SOURCE / 'release/obsolete-code-paths.txt').read_text(encoding='utf-8').splitlines() if s.strip() and not s.startswith('#')]
    plan = []
    for name in names:
        validate_name(name)
        src, dst = ensure_plain(SOURCE, name), ensure_plain(target, name)
        if not dst.exists():
            plan.append(('ADD', name))
        elif digest(src) != digest(dst):
            plan.append(('UPDATE', name))
    for name in sorted(set(obsolete)):
        validate_name(name, deletion=True)
        if name in names:
            raise ValueError('Path appears in both source and deletion manifest: ' + name)
        dst = ensure_plain(target, name)
        if dst.exists():
            plan.append(('DELETE', name))
    for op, name in plan:
        print(op.ljust(8), name)
    print('PRESERVE all paths outside the source/deletion manifests; no recursive directory deletion.')
    print('Planned:', len(plan), 'file operations. Review Git status/diff yourself before and after.')
    if not args.apply:
        print('DRY RUN ONLY. No files changed. Back up your clone before approved application.')
        return
    if not args.confirm_local_clone:
        raise ValueError('--apply also requires --confirm-local-clone after review; never use on VPS')
    # Recheck all destinations before any writes. Still not a substitute for an offline backup.
    for _, name in plan:
        ensure_plain(target, name)
    for op, name in plan:
        dst = target / name
        if op == 'DELETE':
            dst.unlink()  # exact reviewed file only; no rmtree or glob
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE / name, dst)
    print('Local files updated. NOTHING staged, committed, pushed or deployed.')
    print('Review every change in GitHub Desktop. Never commit data or secrets.')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('STOP:', exc, file=sys.stderr)
        sys.exit(1)
