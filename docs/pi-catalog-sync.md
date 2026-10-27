# Pi catalog projection

`mergePiCatalog` is the pure model projection used by the native official Pi
extension. It adds only fully described new models, preserves existing model
metadata and overrides, rejects duplicate/malformed input, and never writes a
profile or chooses a model. Authentication and the bounded Magpie model-list GET
remain in the native extension's existing resolver; no OAuth, login, credential
copy or inference is added.

Current product preparation/startup follows
[native catalog wiring](pi-native-catalog-product-wiring.md). The selected
profile must be explicitly prepared while stopped. A normal host or selected
program rejects a non-null retired file-sync binding before discovery/startup.
No filesystem compare-and-swap catalog writer or polling lifecycle is shipped.
An existing `.pi-models-pending.json` is retained as opaque unknown history and
blocks native catalog preparation/enablement; it is never parsed, cleared,
restored or treated as permission to retry a write.

The former replacement writer, lifecycle and their positive fixtures were
removed after caller verification. Their actual inherited-ACE failures and
refusal-only checkpoint remain in the
[historical ACL evidence](evidence/pi-catalog-acl.md). Strict descriptor/flag
negative tests remain in `test-support/pi-catalog-acl.test.mjs`; the actual
Windows native selected-deploy test reads and compares original settings,
models and auth ACLs exactly before and after preparation and Pi shutdown.
It changes no ACL. Historical replacement results do not qualify native refresh.
