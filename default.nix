# Classic entrypoint — plain Nix, nixpkgs-style: no flakes, no flake-compat. The
# flake and this file are two doors into the same pkgs/top-level; nixpkgs is pinned
# to the SAME revision by reading flake.lock (one lock, two entrypoints).
#
#   nix-build -A experiment-inspect-hello && ./result/bin/adb-inspect-hello …
#   nix-build https://github.com/antimemetics-institute/adb/archive/main.tar.gz \
#     -A experiment-inspect-hello
#
# Classic builds carry no fetchable flake rev, so runs made this way record a
# `dirty:` fetch_ref — fine locally; the flake path is the canonical one.
let
  lock = builtins.fromJSON (builtins.readFile ./flake.lock);
  locked = lock.nodes.nixpkgs.locked;
  nixpkgsSrc = fetchTarball {
    url = locked.url;
    sha256 = locked.narHash;
  };
in
{ system ? builtins.currentSystem
, pkgs ? import nixpkgsSrc { inherit system; }
}:
let
  inherit (pkgs) lib;
  adbPkgs = import ./pkgs/top-level { inherit pkgs; self = { }; };

  runnables =
    { inherit (adbPkgs) adb-runner; }
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
    ({ inherit (adbPkgs) adb-runner; }
      // lib.optionalAttrs (adbPkgs ? adb-web) { inherit (adbPkgs) adb-web; }
      // lib.mapAttrs (_: exp: exp.app) adbPkgs.experiments);
}
