# Product-entry test lifecycle diagnostic

This is a test-process diagnostic, not Windows field acceptance or a new
candidate build. The existing `8351b9c433922762f579c1c7b70e755d45b6ed2c`
candidate and its byte evidence remain unchanged.

## Existing CI observation

Run [40756435799](https://github.com/particleflow/windows-endpoint/actions/runs/40756435799),
Windows delivery job `123056484017`, passed 704 main tests and seven packaging
tests. In its final step all four product-entry tests reported pass, the last at
19:49:26.6978775 UTC. At 19:49:30.2762547 UTC the file-level result was cancelled:
five tests, four pass, zero fail, one cancelled, with `Promise resolution is still
pending but the event loop has already resolved`. The runner then reported
`The operation was canceled.` Bootstrap/hash commands had not completed.

The workflow's delivery job has an eight-minute bound. The available log does
not identify the cancellation actor or prove that this bound fired. A subsequent
job-metadata request returned Forbidden; it was not retried through another
entry. Cancellation is not a field TLS, credential or producer-contract failure.

## Identified test resource and isolated counterexample

The foreground test races its already-observed child exit against a ten-second
`timers/promises` timeout. The losing timeout remains referenced after success.
Its cleanup hook had the same pattern with an eight-second timeout. Passing
assertions do not cancel either timer, so a finished test can keep the file's
worker alive. Awaiting the child `close` event already proves that this test's
PowerShell child closed; the counterexample concerns the separate deadline.

On Linux, Node v24.19.0 (CI uses v24.14.0), an isolated four-test process shortened
the deadline to 600ms. The original race left an active Timeout and exited in
665ms; explicitly clearing it left no Timeout and exited in 46ms. These timings
illustrate the resource lifetime and are not performance assertions.

A second isolated `node --test` counterexample injected SIGINT 100ms after all
four pass lines, only if the runner was still alive. Original race: four pass,
zero fail, one file-level cancellation, exit 1 and the exact pending-Promise
message above. Cleared race: four pass, zero fail/cancellation, natural exit 0;
the runner exited before the synthetic signal was sent. Local Node's harness
also uses that message from its parent-cancellation teardown path. Thus the
message alone is not evidence of an unresolved Windows test-body promise.

This reproduces the leak-plus-cancellation mechanism with a synthetic deadline;
it does not prove the original CI cancellation cause or guarantee enough time
for subsequent bootstrap commands under the existing job limit.

## Narrow repair and validation

`test-support/child-exit-deadline.mjs` clears the deadline in `finally` on exit,
rejection or expiry. The Windows fixture uses it in both races. It does not
unref pending work, change the stop protocol, alter child termination, relax an
assertion or change the workflow bound. No product/package code changed.

`node --test test-support/child-exit-deadline.test.mjs` passed one test with three
real subprocess cases (exit, rejection, expiry), zero skips. In the settled
cases a 60-second deadline must be released for the child to exit naturally
within a three-second test bound. Actual Windows product-entry/bootstrap and
complete-job success remain unverified after this repair; no CI was rerun and
no candidate was rebuilt for this diagnostic.
