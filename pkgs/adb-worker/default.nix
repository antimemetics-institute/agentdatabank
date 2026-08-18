# the queue worker: `adb-runner worker` under its service name — a long-lived
# headless process that claims jobs from an adb-web (or, later, hosted) queue and
# executes them with ITS OWN machine's credential store. A worker serves ONE repo
# (--repo / ADB_WORKER_REPO — its registration identity): jobs are secret-free,
# source-free specs; what code they build is the operator's, never the
# submitter's. The default baked here is this same pinned source, so worker and
# experiments are same-pin by construction; point --repo at a checkout or fork
# to serve that instead. nix in PATH: the worker's whole job is
# `nix-build <src> -A exec.<experiment>`. The NixOS module for running one as a
# service lives beside this file (module.nix, exposed as nixosModules.adb-worker).
{ adb, adb-runner, writeShellApplication, nix }:
writeShellApplication {
  name = "adb-worker";
  runtimeInputs = [ nix ];
  text = ''
    export ADB_WORKER_REPO=''${ADB_WORKER_REPO:-${adb.cleanImport "adb-src" ../../.}}
    exec ${adb-runner}/bin/adb-runner worker "$@"
  '';
}
