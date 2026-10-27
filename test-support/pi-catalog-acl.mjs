import assert from 'node:assert/strict'

// Allow only the Windows inheritance normalization seen in CI: an unchanged
// ordered DACL followed by inherited duplicates. No sorting or SID/mask union:
// either could hide new rights or a changed deny/allow evaluation order.
export function assertCatalogAclPreserved(before, after) {
  for (const field of ['owner', 'group', 'protected', 'nullDacl']) assert.deepEqual(after[field], before[field], `ACL ${field} changed`)
  assert.ok(Array.isArray(before.aces) && Array.isArray(after.aces))
  assert.ok(after.aces.length >= before.aces.length, 'ACL entries removed')
  assert.deepEqual(after.aces.slice(0, before.aces.length), before.aces, 'Original ordered ACL changed')
  for (const ace of after.aces.slice(before.aces.length)) {
    assert.equal(ace.inherited, true, 'Unexpected explicit ACL entry')
    assert.ok(before.aces.some(old => old.binary === ace.binary), 'Inherited ACL entry grants or denies different rights')
  }
}
