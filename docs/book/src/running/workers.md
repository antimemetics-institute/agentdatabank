# Running from the GUI

Start the local ADB:

```sh
nix run .#adb-local
```

Open an experiment, configure it, and press **Run**. The local server builds the
experiment and runs it on the same machine. **Jobs** shows the queue, build logs,
run links, and finished jobs. Jobs execute one at a time, with at most 32 queued or
active jobs. Replicates run sequentially. A finished invocation can contain failed
runs; inspect the individual run outcomes.

**Stop** cancels a queued job immediately or interrupts its execution. If a process
ignores the interruption, local ADB escalates to termination and then a forced kill.
Partial run files remain available. Closing local ADB stops its active execution;
queued jobs resume when it starts again. Jobs interrupted by a restart are marked
orphaned and never automatically retried. Re-run submits the same parameters and
profile selections against the currently configured source; it is not historical
reproduction.

## Source and local data

Inside an ADB Git checkout, `adb-local` uses that checkout. Outside an ADB checkout,
it uses the pinned source from which it was built. You can choose explicitly with
`--repo /path/to/adb`. The Run panel displays that path. The experiment catalog is
built from the same source at startup. **Restart adb-local after editing experiment
declarations** so forms and parameter validation reflect the changes.

```sh
nix run .#adb-local -- --data-dir /tmp/adb-test --port 8350 --no-open
```

The server and its managed executor share the exact data directory and credential
environment, including `ADB_CREDENTIALS_FILE` and `XDG_CONFIG_HOME`. The data
path follows `--data-dir`, then `ADB_DATA_DIR`, then `$XDG_DATA_HOME/adb` (normally
`~/.local/share/adb`). Keep data outside the source checkout.

The server picks the next available port if the requested port is occupied. Its
executor always uses the actual bound port, so separate instances with separate
data directories cannot accidentally attach to each other.

## Read-only viewing and remote machines

`nix run .#adb-web` starts a read-only viewer. It does not accept jobs or credential
changes. Direct experiment commands work independently of either web mode.

The browser, server, and executor do not need to share a desktop, but **the server
and executor must share a machine**. To run on another machine, start `adb-local`
there and forward its port with SSH:

```sh
ssh -L 8340:127.0.0.1:8340 your-machine
```

Visit `http://127.0.0.1:8340` in your browser. Execution and credential endpoints
require loopback requests and reject cross-origin browser requests. There is no
remote worker registration, token configuration, or standalone worker service.
