# Owner control and original handoff evidence

The current control path is the official Memoh Runtime and its authenticated
native Herdr executor. Windows does not obtain an owner identity or a stop grant
from local JSON, a cached PID, labels, or a file-transfer credential. The task
owner must retain the original operation, target, configuration and native
process-generation evidence. A missing response remains unknown.

The endpoint's [durable handoff journal](host-handoff-journal.md) provides
`host handoff-status` for readback of the original request. Its acknowledgement
is not stop/replay authority. [Foreground host](foreground-host.md) describes the
current stdin and native recovery boundaries; [program transactions](deployment-transactions.md)
describe stopped program changes. Existing unknown operations and Pi sessions
are preserved, not resubmitted during a program switch.

The earlier transport inspection used Memoh
`acdb3c7aba0931929243921271abbb63afc54024`, Agenvo
`a89415e557c415faf5626354f8e87233eb69d877` and Herdr
`5bd900d88c80d95f5b145397e45bbeea398b8165`. Its synthetic relay probe covered
request correlation and uncertain replies, but did not verify real owner OAuth,
admission fencing, a stop handoff, task recovery or production PC/NAS traffic.
That retired relay probe and its dedicated test are removed; its original Git
revision remains the provenance of that limited historical result. It is not a
current operation recipe or native acceptance evidence.

No new listener, service, credentials, permissions or alternative provider path
is supplied here. Native packaged transfer authentication and positive TLS
remain separate unverified acceptance gates.
