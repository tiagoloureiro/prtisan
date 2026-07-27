# Model-routing public artifacts

This directory is the public side of the maintainer benchmark:

- `corpus.schema.json` defines the frozen combined-corpus exchange format.
- `report.schema.json` defines the privacy-minimal aggregate report.
- public Prtisan cases and approved redacted reports belong here.

Do not commit private-repository cases, gold labels, raw output, or patches.
Those belong under `$XDG_DATA_HOME/prtisan/model-evaluation` with `0600`
permissions. `bun run eval:models validate-corpus` requires the complete frozen
105-case corpus before any candidate can run.

No cheaper profile has been promoted yet. The migration baseline remains
Sol-medium for all seven roles until a complete report is reviewed and approved.
