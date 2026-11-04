// Endpoint-owned build entry; the fixed official Runtime source is unchanged.
// Use runCLI's existing session factory so its secure enrollment reader, TLS,
// reconnect loop and signal cleanup remain authoritative.
import path from 'node:path'
import { createRequire } from 'node:module'

const source = process.argv[2]
if (!source || process.argv.length !== 3) throw new Error('Runtime source root required')
const root = path.resolve(source, 'packages/runtime')
const { build } = createRequire(path.join(root, 'package.json'))('esbuild')
await build({
  stdin: { contents: "export { runCLI, formatCLIError } from './cli-main.ts'; export { RuntimeSession } from './session.ts';", resolveDir: path.join(root, 'src'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle',
  banner: { js: "import { createRequire as __memohCreateRequire } from 'node:module'; const require = __memohCreateRequire(import.meta.url);" },
  outfile: path.join(root, 'dist/endpoint-host-api.mjs'),
})
