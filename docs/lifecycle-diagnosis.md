# Windows lifecycle diagnosis

The standalone migration baseline `10dbb98f66a3ca9e79dad615ea0e0c187a3b4dd8`
reproduced `Persisted panes were not restored` in Windows CI
[39831296716](https://github.com/particleflow/windows-endpoint/actions/runs/39831296716).
Both 45-test unit jobs and all eight official dependency checks passed first.

The fixture waited only 1.5 seconds after its ordinary shell side effect before
killing Herdr. The pinned official source uses a **five-second debounce**
([app/mod.rs](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/app/mod.rs#L44)),
followed by a background snapshot write
([app/session.rs](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/app/session.rs#L62)).
The test could kill the host before a persisted workspace existed. The earlier
green checkpoint was not evidence that a fixed 1.5-second delay was sufficient.

The correction waits, within the existing 30-second bound, until the actual
isolated `session.json` contains the newly created workspace and a pane. Only then
does it terminate the owned process. It does not synthesize or edit the snapshot,
force a graceful save, or change official restoration policy. After recovery the
original nonempty-pane assertion is retained and strengthened to require the
original pane/workspace identity with no restore error. The shell side effect
must still occur exactly once.

This snapshot read belongs only to the synthetic CI fixture, not to the endpoint
driver or business retry decisions. Each completed lifecycle check now emits a
bounded result immediately so a later failure cannot hide earlier evidence.

## Windows result and separate upstream limitation

Fix commit `5e76947479630f2d303f51693ea7e0e0fd38a3be` passed both 45-test unit jobs,
eight official dependency checks and nine lifecycle checks in
[39831637555](https://github.com/particleflow/windows-endpoint/actions/runs/39831637555).
The real persisted snapshot was observed after 1,758 ms of polling (after earlier
CLI work); restoration of the original pane, no shell-command replay, real 401
handling, owned shutdown and foreign-server peer rejection all passed. This
confirms the persistence precondition fix on Windows rather than assuming that
another fixed sleep is sufficient.

The same pinned official source explicitly rejects live handoff on non-Unix
systems: [headless/lifecycle.rs](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/server/headless/lifecycle.rs#L234).
The next assertion failed at the official `server live-handoff` invocation.
The inherited positive Windows live-handoff expectation was incorrect for this
official platform capability; no official implementation is patched.

A further isolated fixture starts a separate official server at the same session
endpoint after the owned child exits, then verifies that `stop` cannot stop the
successor and `start` refuses to adopt it. It checks the real successor PID and
unchanged generation before fixture-only cleanup. This tests external replacement
safety independently of live task migration. These ten lifecycle checks passed at
`44a4efef8e6f82bfabc5338d2c6df7760ccd1457` in
[39832125317](https://github.com/particleflow/windows-endpoint/actions/runs/39832125317),
before the unsupported live-handoff invocation failed.

## Correct Windows capability assertion

The corrected fixture replaces the invalid success expectation with an executed
negative test. It requires exit code 1, no spawn error or timeout, and the exact
official response ID, `handoff_failed` code and `live handoff is only supported on
Unix` message. The response mapping is in the pinned
[headless server](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/server/headless.rs#L2931)
and the exit code is in the pinned
[CLI](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/cli/server.rs#L213).
An arbitrary failure, signal or malformed response cannot pass.

Before the request, a bounded synthetic Node command records its PID and waits
for a fixture-only release file. After rejection, the test verifies that the
owned server is still alive with the same generation and responds through the
PID-verified pipe; pane/workspace/tab/terminal identities remain identical. The
original command must still have only its start record. Releasing it must produce
exactly one completion from the same PID. The ten previous lifecycle checks,
including foreign-peer rejection and external same-session replacement safety,
remain in place. The new check is not skipped or a claim of live handoff support.

The smoke report explicitly says `liveHandoff: unsupported_on_windows` and
`updateRollback: not_implemented`. Future Windows updates must use controlled
stop/restore; neither seamless handoff nor real Agent pending-tool recovery is
established by this fixture. Consult the corrected commit's CI for its result.
