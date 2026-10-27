#!/usr/bin/env python3
"""Inventory an unchanged official Runtime build from an exact public checkout.

Does not fetch, install dependencies, enroll, start a runtime or change trust.
CI runs the locked official build and endpoint's session-factory entry build.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def regular(file):
    if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
        raise ValueError('unsafe Runtime build file')
    return file.read_bytes()


def source_file(source, commit, name):
    expected = git(source, 'show', f'{commit}:{name}')
    actual = regular(source / name)
    if actual.replace(b'\r\n', b'\n') != expected.replace(b'\r\n', b'\n'):
        raise ValueError('Runtime source differs from exact commit')
    return expected


def collect(source, commit, output):
    if not re.fullmatch('[a-f0-9]{40}', commit) or git(source, 'rev-parse', 'HEAD').decode().strip() != commit:
        raise ValueError('exact Runtime source checkout required')
    package_name = 'packages/runtime'
    source_names = git(source, 'ls-tree', '-r', '--name-only', commit, f'{package_name}/src', f'{package_name}/scripts').decode().splitlines()
    source_names += ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'LICENSE',
                     f'{package_name}/package.json', f'{package_name}/tsconfig.json', f'{package_name}/tsconfig.build.json',
                     'internal/workspace/bridgepb/bridge.proto']
    if not source_names or len(source_names) != len(set(source_names)):
        raise ValueError('Runtime source inventory invalid')
    inputs = {name: source_file(source, commit, name) for name in sorted(source_names)}
    metadata = json.loads(inputs[f'{package_name}/package.json'])
    if metadata['name'] != '@memohai/runtime' or not re.fullmatch(r'\d+\.\d+\.\d+', metadata['version']):
        raise ValueError('unexpected Runtime package')
    package = source / package_name
    dist = package / 'dist'
    if dist.is_symlink() or not dist.is_dir():
        raise ValueError('official Runtime build is missing')
    payload = {'package.json': inputs[f'{package_name}/package.json'], 'LICENSE': inputs['LICENSE']}
    for file in sorted(dist.rglob('*')):
        if file.is_symlink():
            raise ValueError('linked Runtime output')
        if file.is_dir():
            continue
        name = file.relative_to(package).as_posix()
        if not all(re.fullmatch('[A-Za-z0-9_.-]+', p) and p not in ('.', '..') for p in PurePosixPath(name).parts):
            raise ValueError('invalid Runtime output path')
        if not name.endswith(('.mjs', '.d.ts', '.d.ts.map', '.proto')):
            raise ValueError('unexpected Runtime output')
        payload[name] = regular(file)
    if not {'dist/cli.mjs', 'dist/index.mjs', 'dist/index.d.ts', 'dist/bridge.proto', 'dist/endpoint-host-api.mjs'} <= payload.keys():
        raise ValueError('incomplete official Runtime build')
    if payload['dist/bridge.proto'] != inputs['internal/workspace/bridgepb/bridge.proto']:
        raise ValueError('Runtime protocol differs from fixed source')
    proof = {
        'schema': 1, 'kind': 'memoh-runtime-source-build', 'source_repository': 'particleflow/Memoh',
        'source_commit': commit, 'package_name': metadata['name'], 'package_version': metadata['version'],
        'package_manager': metadata['packageManager'],
        'endpoint_adapter': {'recipe': 'packaging/build_runtime_host.mjs',
                             'sha256': sha(regular(Path(__file__).with_name('build_runtime_host.mjs')).replace(b'\r\n', b'\n'))},
        'inputs': [{'path': name, 'sha256': sha(data)} for name, data in inputs.items()],
        'files': [{'path': name, 'size': len(data), 'sha256': sha(data)} for name, data in sorted(payload.items())],
    }
    output.mkdir(parents=True, exist_ok=False)
    for name, data in payload.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (output / 'SHA256SUMS.json').write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
    return {'source_commit': commit, 'package_version': metadata['version'], 'files': len(payload),
            'qualification': 'review-only', 'systemTrust': 'unchanged', 'enrollment': 'not_performed'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(collect(args.source, args.commit, args.output)))
