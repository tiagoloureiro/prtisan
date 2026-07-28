# Persistent local control plane

Prtisan's TUI and mutating CLI commands use an on-demand per-user Worker over a
permission-restricted Unix socket. Mutable Projects, Conversations, proposals,
and jobs live in a separate `control.sqlite`, while the existing workflow
journal remains the durable integration authority. This lets work survive TUI
disconnects and keeps unrelated state lifecycles out of the append-only journal,
at the cost of a versioned local RPC boundary and worker recovery logic.
