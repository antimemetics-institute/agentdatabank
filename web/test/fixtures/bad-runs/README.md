# Unreadable-run corpus

The condition directory is `corpus-corpus`: the record's condition is `corpus`
and its experiment is `corpus`. Each run ID has the prefix
`20260916t120000z-` and one of these 12-digit hexadecimal suffixes:

| Suffix | Case |
| --- | --- |
| 000000000000 | Complete readable run |
| 000000000001 | Dict-shaped result declarations |
| 000000000002 | Missing metadata fields |
| 000000000003 | Truncated last JSONL line |
| 000000000004 | Pre-envelope line |
| 000000000005 | Empty directory |

The four bad runs have parseable run.json files. They stay listed, expose one
reason, and return that same reason from both event endpoints. The empty
case has no run.json and is the explicit skip exception; tests remove its
.gitkeep after copying the corpus. No fixture is adapted by the viewer.
