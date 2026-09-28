#!/usr/bin/env python3
"""Manage the independent local proxy LaunchAgents without printing credentials."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
# Labels and the state directory are per-installation, so they are not written
# into this file. An install migrates from whatever label it finds in LEGACY.
PREFIX = os.environ.get('GATEWAY_LAUNCHD_PREFIX', 'subscription-gateway')
STATE = Path(os.environ.get('GATEWAY_STATE_DIR', Path.home() / '.local/share/subscription-gateway'))
AGENTS = Path.home() / 'Library/LaunchAgents'
# An installation that already runs these services under an older label sets
# GATEWAY_LEGACY_LAUNCHD_PREFIX so `install` adopts and replaces it. Empty means
# there is nothing to migrate from, which is the case on a new computer.
LEGACY_PREFIX = os.environ.get('GATEWAY_LEGACY_LAUNCHD_PREFIX', '').strip()
SERVICES = {
    'codex': (f'{PREFIX}.codex', 'codex-openai-proxy', 11435),
    'claude': (f'{PREFIX}.claude', 'claude-print-proxy', 11446),
    'router': (f'{PREFIX}.router', 'router', 11400),
}

def legacy_label(name):
    """The label an earlier install of this service used, or '' when there is none."""
    return f'{LEGACY_PREFIX}.{name}' if LEGACY_PREFIX else ''

def launch(*args, check=True):
    return subprocess.run(['launchctl', *args], check=check, capture_output=True, text=True)

def install(name):
    label, directory, port = SERVICES[name]
    legacy = legacy_label(name)
    target = AGENTS / (label + '.plist')
    old = AGENTS / (legacy + '.plist') if legacy else None
    existing = target if target.exists() or not old else old
    previous = existing.read_bytes() if existing.exists() else None
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    (STATE/'logs').mkdir(exist_ok=True, mode=0o700)
    (STATE/'backups').mkdir(exist_ok=True, mode=0o700)
    if existing.exists():
        data = plistlib.loads(existing.read_bytes())
        backup = STATE/'backups'/existing.name
        if not backup.exists():
            backup.write_bytes(existing.read_bytes()); backup.chmod(0o600)
    else:
        data = {'RunAtLoad': True, 'KeepAlive': True, 'EnvironmentVariables': {
            'HOST': '127.0.0.1', 'PORT': str(port), 'PATH': os.environ['PATH'], 'HOME': str(Path.home())}}
        if name == 'claude':
            data['EnvironmentVariables']['CLAUDE_BIN'] = shutil.which('claude') or 'claude'
    data.update(Label=label, ProgramArguments=[shutil.which('node') or '/opt/homebrew/bin/node', str(ROOT/directory/'server.mjs')],
                WorkingDirectory=str(ROOT/directory), StandardOutPath=str(STATE/'logs'/f'{name}.log'),
                StandardErrorPath=str(STATE/'logs'/f'{name}.error.log'))
    # Preserve existing OAuth source and shared keys; never copy credentials into the repository.
    tmp = target.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as f: f.write(plistlib.dumps(data))
    domain = f'gui/{os.getuid()}'
    launch('bootout', f'{domain}/{label}', check=False)
    if legacy: launch('bootout', f'{domain}/{legacy}', check=False)
    tmp.replace(target)
    result = launch('bootstrap', domain, str(target), check=False)
    healthy = False
    if result.returncode == 0:
        for _ in range(30):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{data["EnvironmentVariables"].get("PORT", port)}/health', timeout=1) as response:
                    healthy = json.load(response).get('status') == 'ok'
                if healthy:
                    break
            except Exception:
                pass
            time.sleep(0.2)
    if not healthy:
        launch('bootout', f'{domain}/{label}', check=False)
        target.unlink(missing_ok=True)
        if previous:
            existing.write_bytes(previous)
            existing.chmod(0o600)
            launch('bootstrap', domain, str(existing), check=False)
        raise SystemExit(f'{name}: startup health check failed; previous configuration restored')
    if old and old.exists(): old.unlink()
    print(f'{name}: installed {label}')

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('command', choices=['install', 'status', 'start', 'stop', 'restart', 'logs'])
    ap.add_argument('service', choices=['all', *SERVICES], nargs='?', default='all')
    args = ap.parse_args()
    for name in SERVICES if args.service == 'all' else [args.service]:
        label, _, port = SERVICES[name]
        target = f'gui/{os.getuid()}/{label}'
        if args.command == 'install': install(name)
        elif args.command == 'status':
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=5) as r: health = json.load(r)
            except Exception: health = {'status': 'unreachable'}
            print(json.dumps({'service': name, 'managed': launch('print', target, check=False).returncode == 0, 'port': port, 'health': health}))
        elif args.command == 'stop': launch('bootout', target)
        elif args.command == 'start': launch('bootstrap', f'gui/{os.getuid()}', str(AGENTS/(label+'.plist')))
        elif args.command == 'restart': launch('kickstart', '-k', target)
        elif args.command == 'logs':
            for suffix in ['log','error.log']:
                p=STATE/'logs'/f'{name}.{suffix}'
                print(f'{name}: {p}')
                if p.exists(): subprocess.run(['tail','-n','30',str(p)],check=True)

if __name__ == '__main__': main()
