// Diagnostics for this disposable synthetic workload only, never user sessions.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

// A new workspace is not evidence that its interactive shell is accepting
// commands. Match only the empty prompt in this fixture's fresh PowerShell pane.
export function isFreshPiShellPrompt(output, work) {
  return String(output).replace(/\r\n/g, '\n').trimEnd().split('\n').at(-1) === `PS ${work}>`
}

export function piWorkloadWrapper(node, args, work, piConfigDir) {
  return `const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const trace=${JSON.stringify(path.join(work, 'launch.json'))};
const context={cwdMatchesExpected:process.cwd()===${JSON.stringify(work)},nodeMatchesExpected:fs.realpathSync(process.execPath)===fs.realpathSync(${JSON.stringify(node)}),piConfigMatchesExpected:process.env.PI_CODING_AGENT_DIR===${JSON.stringify(piConfigDir)}};
const record=phase=>fs.writeFileSync(trace,JSON.stringify({phase,...context}));
record('wrapper_started');
fs.appendFileSync('invocations.txt','once\\n');
const out=fs.openSync('stdout.jsonl','wx'),err=fs.openSync('stderr.txt','wx');
let r;try{record('pi_spawn_pending');r=spawnSync(${JSON.stringify(node)},${JSON.stringify(args)},{input:'Write the fixed synthetic result file, then report completion.',stdio:['pipe',out,err],timeout:60000,windowsHide:true});}finally{fs.closeSync(out);fs.closeSync(err);}
fs.writeFileSync('exit.json',JSON.stringify({status:r.status,error:r.error?.code??null}));
record('pi_exited');
`
}

export function diagnosticText(value, roots = []) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/).map(line => /authorization|bearer|api[_-]?key|password|secret|token|credential/i.test(line) ? '[credential-bearing line omitted]' : line).join('\n')
    .replace(/https?:\/\/\S+/gi, '[URL omitted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[opaque value omitted]')
    .replace(new RegExp(roots.filter(Boolean).sort((a, b) => b.length - a.length).map(root => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)', 'gi'), '[fixture root]')
    .slice(0, 2048)
}

export async function piWorkloadEvidence(work, roots = []) {
  const result = {}
  for (const name of ['launch.json', 'invocations.txt', 'exit.json', 'stderr.txt', 'stdout.jsonl']) {
    let handle
    try {
      const stat = await fs.lstat(path.join(work, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { result[name] = { state: 'not_regular' }; continue }
      handle = await fs.open(path.join(work, name), 'r')
      const buffer = Buffer.alloc(4096), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const prefix = buffer.subarray(0, bytesRead), text = prefix.toString('utf8')
      const evidence = result[name] = { state: 'present', bytes: stat.size, truncated: stat.size > bytesRead, prefixSha256: createHash('sha256').update(prefix).digest('hex') }
      if (name === 'stderr.txt') evidence.excerpt = diagnosticText(text, roots)
      if (name === 'invocations.txt') evidence.count = /^(once\n)*$/.test(text) && !evidence.truncated ? text.length / 5 : 'invalid'
      if (name === 'launch.json' || name === 'exit.json') {
        try {
          const value = JSON.parse(text)
          if (name === 'exit.json') evidence.exit = { status: Number.isInteger(value.status) ? value.status : null, error: /^[A-Z_0-9]+$/.test(value.error) ? value.error : null }
          else evidence.launch = { phase: ['wrapper_started', 'pi_spawn_pending', 'pi_exited'].includes(value.phase) ? value.phase : 'unknown', ...Object.fromEntries(['cwdMatchesExpected', 'nodeMatchesExpected', 'piConfigMatchesExpected'].map(k => [k, typeof value[k] === 'boolean' ? value[k] : null])) }
        } catch { evidence.parse = 'invalid' }
      }
    } catch (error) { result[name] = { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' } }
    finally { await handle?.close() }
  }
  return result
}
