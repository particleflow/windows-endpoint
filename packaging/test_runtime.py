import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runtime_package', ROOT / 'packaging/collect_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='runtime-package-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        # Match the fixed public checkout's LF policy. Python text writes use
        # CRLF on Windows, unlike the real copy-proto byte copy, so create the
        # synthetic source and build outputs with explicit bytes as well.
        (self.source / '.gitattributes').write_bytes(b'* text=auto eol=lf\n')
        names = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'LICENSE',
                 'packages/runtime/tsconfig.json', 'packages/runtime/tsconfig.build.json',
                 'packages/runtime/src/index.ts', 'packages/runtime/scripts/build.mjs',
                 'internal/workspace/bridgepb/bridge.proto']
        for name in names:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'INERT SOURCE FIXTURE\n')
        (self.source / 'packages/runtime/package.json').write_text(json.dumps({'name': '@memohai/runtime', 'version': '0.22.0', 'packageManager': 'pnpm@10.27.0'}), encoding='utf-8')
        subprocess.run(['git', '-C', str(self.source), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.source), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic Runtime source'], check=True)
        self.commit = runtime.git(self.source, 'rev-parse', 'HEAD').decode().strip()
        self.dist = self.source / 'packages/runtime/dist'
        self.dist.mkdir()
        for name in ['cli.mjs', 'index.mjs', 'index.d.ts', 'index.d.ts.map', 'bridge.proto', 'endpoint-host-api.mjs']:
            (self.dist / name).write_bytes(b'INERT SOURCE FIXTURE\n')

    def collect(self, name='output'):
        return runtime.collect(self.source, self.commit, self.base / name)

    def test_complete_fixed_source_and_outputs_are_hashed_without_mutable_inputs(self):
        (self.source / 'credentials.json').write_text('EXCLUDED SYNTHETIC INPUT', encoding='utf-8')
        result = self.collect()
        self.assertEqual(result['files'], 8)
        proof = json.loads((self.base / 'output/SHA256SUMS.json').read_bytes())
        self.assertEqual(proof['source_commit'], self.commit)
        self.assertEqual(proof['endpoint_adapter'], {'recipe': 'packaging/build_runtime_host.mjs',
            'sha256': runtime.sha((ROOT / 'packaging/build_runtime_host.mjs').read_bytes().replace(b'\r\n', b'\n'))})
        self.assertIn('pnpm-lock.yaml', [item['path'] for item in proof['inputs']])
        for item in proof['files']:
            data = (self.base / 'output' / item['path']).read_bytes()
            self.assertEqual(runtime.sha(data), item['sha256'])
            self.assertEqual(len(data), item['size'])
        self.assertFalse((self.base / 'output/credentials.json').exists())
        with self.assertRaises(FileExistsError):
            self.collect()

    def test_changed_source_or_protocol_and_extra_output_fail_before_writing(self):
        source = self.source / 'packages/runtime/src/index.ts'
        original = source.read_bytes()
        source.write_bytes(original + b'changed')
        with self.assertRaisesRegex(ValueError, 'source differs'):
            self.collect()
        source.write_bytes(original)
        proto = self.dist / 'bridge.proto'
        proto.write_bytes(b'other protocol')
        with self.assertRaisesRegex(ValueError, 'protocol differs'):
            self.collect()
        proto.write_bytes(original)
        (self.dist / 'device.credential').write_bytes(b'EXCLUDED')
        with self.assertRaisesRegex(ValueError, 'unexpected Runtime output'):
            self.collect()
        self.assertFalse((self.base / 'output').exists())

    def test_crlf_protocol_is_rejected_without_normalizing_the_built_artifact(self):
        original = runtime.git(self.source, 'show', f'{self.commit}:internal/workspace/bridgepb/bridge.proto')
        self.assertEqual(original, b'INERT SOURCE FIXTURE\n')
        proto = self.dist / 'bridge.proto'
        proto.write_bytes(original.replace(b'\n', b'\r\n'))
        with self.assertRaisesRegex(ValueError, 'protocol differs'):
            self.collect()
        self.assertFalse((self.base / 'output').exists())
        proto.write_bytes(original)
        self.assertEqual(self.collect()['files'], 8)


if __name__ == '__main__':
    unittest.main()
