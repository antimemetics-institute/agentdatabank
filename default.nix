# Classic entrypoint — plain Nix, nixpkgs-style: no flakes, no flake-compat. The
# flake and this file are two doors into the same pkgs/top-level; nixpkgs is pinned
# to the SAME revision by reading flake.lock (one lock, two entrypoints).
#
#   nix-build -A experiment-inspect-hello && ./result/bin/adb-inspect-hello …
#   nix-build https://github.com/antimemetics-institute/agentdatabank/archive/main.tar.gz \
#     -A experiment-inspect-hello
#
# Provenance: git stamps the commit hash into .git-revision when generating an
# archive (export-subst — GitHub tarballs included), so tarball builds know their
# rev and runs record a real fetchable ref. In a checkout the placeholder stays
# unexpanded and runs record `dirty:` — correct, a working tree has no rev. The
# `adbRev` argument overrides the stamp (the fetchGit flow states its own rev).
#
# `experiments` is the authoring door: a path to an external experiment directory
# (see the book's "Writing experiments") joins the registry beside the in-tree
# ones — same bare names, same manifests linkFarm, same web catalog.
let
  lock = builtins.fromJSON (builtins.readFile ./flake.lock);
  locked = lock.nodes.nixpkgs.locked;
  nixpkgsSrc = fetchTarball {
    url = locked.url;
    sha256 = locked.narHash;
  };
  stampRev =
    let m = builtins.match "([0-9a-f]{40})[[:space:]]*" (builtins.readFile ./.git-revision);
    in if m == null then null else builtins.head m;
in
{ system ? builtins.currentSystem
, pkgs ? import nixpkgsSrc { inherit system; }
, experiments ? null
, adbRev ? null
}:
let
  inherit (pkgs) lib;
  adbPkgs = import ./pkgs/top-level {
    inherit pkgs experiments;
    rev = if adbRev != null then adbRev else stampRev;
  };

  runnables =
    { inherit (adbPkgs) adb-runner adb-dev; }
    // lib.optionalAttrs (adbPkgs ? adb-web) { inherit (adbPkgs) adb-web; }
    // lib.mapAttrs' (name: exp: lib.nameValuePair "experiment-${name}" exp.app)
      adbPkgs.experiments;
in
runnables
// {
  inherit pkgs;
  manifests = pkgs.linkFarm "adb-manifests"
    (lib.mapAttrsToList
      (name: exp: { name = "${name}.json"; path = exp.manifest; })
      adbPkgs.experiments);

  # `exec.<name>`: the classic mirror of the flake's APP namespace — bare names for
  # experiments, adb- prefix for tools, exactly like `nix run .#<name>`. The output
  # IS the executable (a symlink resolved via lib.getExe, i.e. meta.mainProgram), so
  # the flakeless one-liner needs no binary-name knowledge:
  #   $(nix-build --no-out-link -A exec.inspect-hello) --set …
  exec = lib.mapAttrs
    (name: drv: pkgs.runCommand "exec-${name}" { } "ln -s ${lib.getExe drv} $out")
    ({ inherit (adbPkgs) adb-runner adb-dev; }
      // lib.optionalAttrs (adbPkgs ? adb-web) { inherit (adbPkgs) adb-web; }
      // lib.mapAttrs (_: exp: exp.app) adbPkgs.experiments);
}
