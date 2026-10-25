#!/usr/bin/env python3
"""Package the existing foreground launcher and unchanged producer review bundle.

Build-time only: no downloads, installer, activation, credential or trust changes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

RUNTIME_FILES = (
    'endpoint.mjs', 'endpoint.ps1', 'host.mjs', 'runtime.mjs', 'installed.mjs',
    'lifecycle.mjs', 'owned-herdr.ps1', 'session-continuation.mjs',
    'session-diagnostics.mjs', 'transfer-contract.mjs', 'transfer-lifecycle.mjs',
    'deployment.mjs', 'deployment-layout.json', 'candidate.mjs', 'program-deployment.mjs', 'dependencies.json', 'LICENSE',
)
PRODUCER_FILES = (
    'README.md', 'herdr-plugin.toml', 'transfer.example.json',
    'transferqueue-cli.test.exe', 'transferqueue.exe', 'transferqueue.test.exe',
    'verify-fixtures.ps1',
)
TEMPLATES = {
    'packaging/README.md': 'README.md',
    'packaging/endpoint.references.example.json': 'examples/endpoint.references.example.json',
    'packaging/runtime.example.json': 'examples/runtime.example.json',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def committed(root, commit, name):
    data = git(root, 'show', f'{commit}:{name}')
    file = root / name
    if file.is_symlink() or not file.is_file() or file.read_bytes().replace(b'\r\n', b'\n') != data.replace(b'\r\n', b'\n'):
        raise ValueError(f'packaged source differs from exact commit: {name}')
    return data


def build(source, commit, producer, producer_source, output):
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('full source commit required')
    payload = {name: committed(source, commit, name) for name in RUNTIME_FILES}
    payload.update({destination: committed(source, commit, name) for name, destination in TEMPLATES.items()})
    catalog = json.loads(payload['dependencies.json'])
    pin = catalog['components']['transfer']['revision']
    proof_file = producer / 'SHA256SUMS.json'
    if proof_file.is_symlink():
        raise ValueError('linked producer proof')
    proof_bytes = proof_file.read_bytes()
    proof = json.loads(proof_bytes)
    if proof['source_commit'] != pin or proof['arch'] != 'amd64':
        raise ValueError('producer source or architecture mismatch')
    entries = proof['files']
    if len(entries) != len(PRODUCER_FILES) or sorted(e['name'] for e in entries) != sorted(PRODUCER_FILES):
        raise ValueError('producer inventory mismatch')
    if sorted(p.name for p in producer.iterdir()) != sorted((*PRODUCER_FILES, 'SHA256SUMS.json')):
        raise ValueError('unexpected producer files')
    for entry in entries:
        file = producer / entry['name']
        if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
            raise ValueError('unsafe producer file')
        data = file.read_bytes()
        if sha(data) != entry['sha256']:
            raise ValueError('producer hash mismatch')
        if file.suffix == '.exe' and not data.startswith(b'MZ'):
            raise ValueError('Windows producer executable required')
        payload[f'transfer/{file.name}'] = data
    payload['transfer/SHA256SUMS.json'] = proof_bytes
    # Keep the complete existing producer inventory. Its test executables are
    # identified as review tools, never presented as additional product services.
    payload['licenses/Memoh-LICENSE'] = git(producer_source, 'show', f'{pin}:LICENSE')
    manifest = {
        'schema': 1,
        'kind': 'portable-existing-installations-review',
        'qualification': 'not-for-production-release',
        'source_repository': 'particleflow/windows-endpoint',
        'source_commit': commit,
        'producer_repository': 'particleflow/Memoh',
        'producer_commit': pin,
        'platform': 'win32-x64',
        'entry': 'endpoint.mjs',
        'official_components': 'referenced-existing-installations-not-bundled',
        'producer_test_tools': ['transfer/transferqueue.test.exe', 'transfer/transferqueue-cli.test.exe', 'transfer/verify-fixtures.ps1'],
        'positive_production_tls': 'unverified',
        'activation_update_rollback': 'stopped-endpoint-program-only',
        'state_profile': 'endpoint-program-v1',
        'files': [{'path': name, 'size': len(data), 'sha256': sha(data)} for name, data in sorted(payload.items())],
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    payload['candidate.json'] = manifest_bytes
    output.mkdir(parents=True, exist_ok=False)
    archive_name = f'windows-endpoint-review-{commit[:12]}-win32-x64.zip'
    archive = output / archive_name
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, data)
    summary = {
        'schema': 1, 'source_commit': commit, 'producer_commit': pin,
        'archive': archive_name, 'sha256': sha(archive.read_bytes()),
        'size_bytes': archive.stat().st_size, 'files': len(payload),
        'manifest_sha256': sha(manifest_bytes),
        'qualification': manifest['qualification'],
        'positive_production_tls': 'unverified',
    }
    (output / 'candidate-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path.cwd())
    parser.add_argument('--commit', required=True)
    parser.add_argument('--producer', type=Path, required=True)
    parser.add_argument('--producer-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.commit, args.producer, args.producer_source, args.output)))
