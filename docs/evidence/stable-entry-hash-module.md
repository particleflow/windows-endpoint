# Stable-entry native hash command discovery

The actual Windows fe893 probe of the unchanged 8351 launcher reached
`receipt.contract_or_hash`, then reported `CommandNotFoundException` for
`Get-FileHash` at original line 79. PowerShell exited 2 before invoking Node.
This field result was supplied by the sole field writer through the coordinating
thread; this source task did not access the field files or run the probe.
Head 308 still contained the same unqualified receipt hash call and two
unqualified package hash calls. The earlier 11df repair covered `endpoint.ps1`,
not this independent stable installation entry.

`WindowsEndpoint.ps1` now explicitly imports the Utility manifest under the
current `$PSHOME` inside its existing `try`. All three SHA256 calls use
`Microsoft.PowerShell.Utility\Get-FileHash -ErrorAction Stop`. Module discovery,
autoload settings and an unqualified command shadow no longer select the hash
implementation. Loader failure retains the original bounded JSON error and
exit 2. The receipt, complete package inventory, exact bytes, paths, owner,
selection, Node invocation and foreground stop checks are unchanged.

The read-only `test-support/fixtures/windows-endpoint-8351.ps1.txt` preserves
exact SHA256 `13e9721c9a430586b2cb3120157441a2be138519ac6828fcd34405bee10bbc8d`
only for the already-used fe893 stage-insertion regression. It is not a product
package member or an executable compatibility entry. The probe continues to
reject repaired or otherwise changed launcher bytes instead of silently
retargeting historical evidence.

## Narrow evidence and remaining Windows check

Cloud Linux checks: `node --check installation-hash.windows.test.mjs`, the two
historical probe tests and 19 product-installation preservation/recovery tests
passed. No PowerShell executable is available in this cloud environment; these
checks are not actual Windows execution of the repair. No candidate build or
CI was triggered for this change.

`installation-hash.windows.test.mjs` requires real Windows PowerShell 5.1
FullLanguage. It creates only a private inert tree. With Utility initially
unloaded, autoload disabled and an unrelated child-only PSModulePath, it checks:

- verified receipt and complete inventory reach only the synthetic Node child;
- an unqualified hash shadow cannot replace native verification;
- injected module load failure exits 2 before Node;
- wrong receipt hash, changed launcher, manifest-byte drift and same-size
  payload corruption all exit 2 before Node;
- original synthetic config, selection, unknown/committed/journal bytes and
  the parent's module environment are retained.

Independent Windows review commands, from the exact repaired source:

```text
node --test --test-timeout=120000 installation-hash.windows.test.mjs
node --test --test-timeout=60000 --test-name-pattern="^installed stable PowerShell entry runs and stops" product-entry.windows.test.mjs
```

Run the second command without the old `WINDOWS_ENDPOINT_ENTRY_PROBE=1` opt-in:
that probe intentionally accepts only the historical 8351 bytes. Retain the
existing stdin stop, exit 0, stopped output, empty stderr and deadline checks.
Neither command uses the production host, queue, credentials or live Agent.

Do not overwrite an installed launcher or edit its receipt to try this repair:
the old receipt must reject the new bytes. Use the isolated source fixture for
review; any later product update must use the existing verified installer
transaction and a matching newly qualified package. The retained 8351/308
artifacts and their receipts are unchanged. Producer pin 0813, profile,
HostBinding/RootHash, state formats and upload/auth/TLS qualification are not
changed or newly qualified by this repair.
