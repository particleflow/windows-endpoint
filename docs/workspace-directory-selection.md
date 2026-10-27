# Workspace directory selection: existing interfaces and endpoint boundary

Windows defaults are configured on Windows. NAS persistence belongs to the NAS
workspace-storage/computer settings. There is no added copy, synchronization,
mount, SMB service, credential or network listener. Existing task paths, receipts,
queue bindings and exports are never rewritten by selection.

## Existing NAS/Web directory picker

The fixed Runtime source `9601ac062a3b65477db8db76bcaa521265ba7ee2` already has
`ContainerService.ListDir`, `Stat` and `Mkdir`. The existing Web `DirectoryPicker`
uses `GET /bots/{bot_id}/workdirs/directories` with `workspace_target_id` and an
optional `path`. Empty path starts at the selected target's reported default,
not at a newly enumerated set of Windows drives. The response is:

```json
{
  "workspace_target_id": "<existing authorized mount ID>",
  "path": "<absolute path on that target>",
  "directories": [{ "name": "<child name>", "path": "<absolute child path>" }]
}
```

The existing handler requires Bot manage permission and resolves the selected
target again; an unreachable runtime and a forbidden directory remain separate
errors (503/403). The picker emits `select(path)` only. Its caller keeps a draft
selection and saves only on confirmation; cancellation must not call a binding
write. Paths are joined by the server for the target OS, never by the browser.
This is a Bot-scoped interface, not an existing computer-wide settings API.
The NAS owner must wire its computer settings with their existing owner/target
checks, not invent a Bot context to reuse this endpoint.

Source: [picker](https://github.com/particleflow/Memoh/blob/9601ac062a3b65477db8db76bcaa521265ba7ee2/apps/web/src/components/file-manager/directory-picker.vue),
[handler](https://github.com/particleflow/Memoh/blob/9601ac062a3b65477db8db76bcaa521265ba7ee2/internal/handlers/workdir.go),
[Runtime paths](https://github.com/particleflow/Memoh/blob/9601ac062a3b65477db8db76bcaa521265ba7ee2/packages/runtime/src/core/paths.ts).
HostFS supports absolute paths under its existing authority: `/data` is an alias,
not a new filesystem sandbox. Browsing must not auto-enumerate arbitrary drives
or widen the selected owner's existing access.

## Windows foreground selection

`endpoint.mjs directory-pick [--config FILE]` opens the built-in Windows folder
dialog. An existing `sourceRoot` is only its initial location. The current user's
existing filesystem/share access applies; the program does not authenticate a
share, create a folder, elevate, or modify a binding. It returns `selected/path`
or `cancelled`, always `configurationChanged:false`.

`configure --from FILE --root DIR --browse-source-root native` saves a selection
as the local default `sourceRoot` for **fresh** schema 2/3 references using the
existing writer and validation. Cancel writes nothing. Existing configurations
remain exclusive and all overlap checks remain in place. An installed default
cannot be silently changed under old sessions/queues with this command.
The same option on the existing `setup` command performs that selection once
before any host directory is made and reuses the same writer. It does not add
another installation flow. A changed reference input is rejected before writes.

## NAS workspace and remaining composition

The requested NAS default is a computer-specific directory below the **actual
configured NAS workspace-storage root**. The NAS owner supplies that root and
existing computer identity; this endpoint does not choose a new physical NAS
layout or persist a second storage registry.

The NAS selection should refer directly to an already accessible mapped path
or UNC share; a URL/IP alone is not a filesystem cwd. The NAS owner must enable
workspace creation only with confirmed LAN reachability and existing share
access. This batch does not implement that NAS admission decision. Off LAN must
disable that NAS action, not local directory selection. Neither a saved
label nor a selected path proves LAN/authentication or grants task execution.

Memoh workdir browsing and task `WorkDir` validation already accept Windows UNC.
The endpoint now accepts UNC only for schema 2/3 `sourceRoot` and the associated
workspace/attempt reads. Program paths, private component configuration and host
installation paths keep their original local-drive restrictions. Existing
filesystem/canonical/reparse checks still run; a selected or syntactically valid
UNC path alone does not prove the share is reachable or authenticated. No old
queue binding or task root is rewritten to the new selection.
The existing candidate manifest marks `workspace_unc_source_root`; selecting or
starting an older reader without this capability refuses before changing the
program selector. It is a program compatibility check, not a new approval or
storage registry.
The NAS/Web owner owns the settings persistence, LAN decision and task-side
contract; this repository owns the foreground chooser/configure integration.

W02 remains real Windows control. W03 remains accepted local work continuing
after NAS control disconnection, with the task's actual storage dependencies
reported. A task actively using an unavailable NAS share cannot be promised to
continue filesystem I/O. W04 remains same-task reconnect without replay. No
offline replica or replacement task is created to conceal a failed dependency.

Automated tests cover selection/cancel/error contracts, input changes while the
dialog is open, existing config/data preservation, UNC workspace scope, overlap
checks, and Windows dialog assembly loading without
opening UI. Actual interactive clicks, a user's mapped share/UNC credentials,
LAN admission and NAS settings composition still require their own acceptance.
