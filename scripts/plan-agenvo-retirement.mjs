// One-shot, offline retirement planning. Input is an operator-authored non-secret
// manifest, never endpoint.json, enrollment, Pi auth/config or a private file.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pin = '1537fe39256bd7f208fe3da2b4323c6bf2a9fc04'
function demand(ok, code) { if (!ok) throw new Error(code) }
function fields(value, names) {
  demand(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(','), 'manifest_fields_invalid')
}
function local(value) {
  demand(typeof value === 'string' && /^[A-Za-z]:\\/.test(value) && value.length > 3 &&
    value === path.win32.normalize(value) && !/[<>"|?*\x00-\x1f]/.test(value) &&
    !value.slice(2).includes(':'), 'canonical_local_path_required')
  return value
}
function within(root, file) {
  const relative = path.win32.relative(root, file)
  return relative === '' || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'))
}

export function planRetirement(input) {
  fields(input, ['schema', 'endpointCommit', 'productRoot', 'references'])
  demand(input.schema === 1 && input.endpointCommit === pin, 'source_pin_mismatch')
  const root = local(input.productRoot), r = input.references
  demand(!root.toLowerCase().split('\\').some(p => ['.build', '.git', 'deploy', 'temp', 'tmp'].includes(p)), 'durable_product_root_required')
  fields(r, ['runtimeId', 'deviceId', 'instanceId', 'session', 'hostRoot', 'sourceRoot', 'piConfigDir',
    'herdrConfigRoot', 'herdrStateRoot', 'runtimeEnrollmentFile', 'transferConfigDir', 'transferStateDir', 'programs'])
  demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.runtimeId) &&
    r.runtimeId === r.deviceId && /^[A-Za-z0-9_-]{1,64}$/.test(r.instanceId) &&
    /^[A-Za-z0-9_-]{1,64}$/.test(r.session), 'original_native_identity_required')
  for (const key of ['hostRoot', 'piConfigDir', 'herdrConfigRoot', 'herdrStateRoot', 'runtimeEnrollmentFile', 'transferConfigDir', 'transferStateDir']) local(r[key])
  if (r.sourceRoot?.startsWith('\\\\')) {
    demand(r.sourceRoot === path.win32.normalize(r.sourceRoot) && /^\\\\[^\\]+\\[^\\]+/.test(r.sourceRoot) && !/[<>"|?*\x00-\x1f]/.test(r.sourceRoot) && !r.sourceRoot.includes(':'), 'canonical_workspace_required')
  } else local(r.sourceRoot)
  fields(r.programs, ['node', 'herdr', 'piPackage', 'piBin', 'gitRoot'])
  for (const value of Object.values(r.programs)) local(value)
  for (const old of [r.hostRoot, r.sourceRoot, r.piConfigDir, r.herdrConfigRoot, r.herdrStateRoot, ...Object.values(r.programs)]) {
    demand(!within(old, root) && !within(root, old), 'product_root_overlap')
  }
  const proposals = [
    ['hostRoot', root], ['piConfigDir', path.win32.join(root, 'data', 'pi')],
    ['herdrConfigRoot', path.win32.join(root, 'config', 'herdr')],
    ['herdrStateRoot', path.win32.join(root, 'data', 'herdr')],
  ].map(([reference, proposed]) => ({ reference, current: r[reference], proposed,
    status: reference === 'hostRoot' ? 'blocked_original_journal_and_locator_migration' :
      reference === 'piConfigDir' ? 'blocked_official_credential_ownership_and_task_fingerprints' :
      'blocked_official_state_and_task_locator_migration' }))
  return {
    schema: 1, mode: 'dry-run', endpointCommit: pin, executionPermitted: false,
    evidence: 'operator_declared_references_only; no_existence_or_live_state_verified',
    identity: { runtimeId: r.runtimeId, deviceId: r.deviceId, instanceId: r.instanceId, session: r.session },
    preserved: { sourceRoot: r.sourceRoot, runtimeEnrollmentFile: r.runtimeEnrollmentFile,
      transferConfigDir: r.transferConfigDir, transferStateDir: r.transferStateDir, programs: r.programs },
    proposals,
    cleanup: { eligiblePaths: [], blockers: [
      'PR5_still_launches_legacy_Agenvo_schema_1_and_2',
      'original_PC_inventory_and_retirement_task_evidence_required',
      'active_Pi_profile_cannot_be_removed_or_relocated_under_no_credential_move_constraint',
      'original_HostRoot_exports_unknowns_and_task_locators_must_remain',
      'native_endpoint_and_server_profile_changes_require_stopped_known_work_and_existing_CAS',
    ] },
    writerChecks: [
      'Match the exact original references using already-authorized evidence; do not reopen a denied private file.',
      'Identify each exact legacy binary/task/service/process/environment entry before a stop/removal request; never remove independent official prerequisites.',
      'Keep the current Pi and Herdr references until their official owner provides a credential-preserving relocation supported by the installed versions.',
      'Do not rewrite RootHash, raw HostBinding, receipts, old target fingerprints or unknown task/session locators.',
      'After a separately authorized migration, verify the same native identity, Magpie profile, session and task history before pruning any proven unused leaf.',
    ],
  }
}

async function main() {
  demand(process.argv.length === 4 && process.argv[2] === '--manifest', 'usage: node scripts/plan-agenvo-retirement.mjs --manifest NON_SECRET_OPERATOR_MANIFEST.json')
  const file = process.argv[3]
  demand(path.basename(file) === '.agenvo-retirement-plan-input.json', 'new_operator_manifest_required')
  const st = await fs.lstat(file)
  demand(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 32768, 'operator_manifest_unsafe')
  const plan = planRetirement(JSON.parse(await fs.readFile(file, 'utf8')))
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('retirement_plan_rejected: supply only the documented non-secret operator manifest\n'); process.exitCode = 2 })
}
