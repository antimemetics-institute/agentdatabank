# adb-dev — the authoring CLI: `init` scaffolds an external experiment repo,
# `bump` moves its adb pin (nix side and uv side together), `pin` prints the rev.
#
# Built knowing which adb it came from: `rev` (from the flake's sourceInfo, the
# stamped tarball, or the classic `adbRev` argument) is baked into the wrapper, so
# the tool never parses lock files at run time — evaluation through the user's pin
# already did the reading. A tool built from an unpinned checkout bakes nothing
# and asks for --rev instead of guessing.
{ lib, origin, python313, writeShellApplication, git, uv, rev ? null }:
let
  py = python313.withPackages (ps: [ ps.tomlkit ]);
  # the fetchable https form of the flake-ref origin, for git/uv consumers
  httpsUrl =
    let m = builtins.match "github:([^/]+)/([^/?]+).*" origin;
    in if m == null then origin
    else "https://github.com/${builtins.head m}/${builtins.elemAt m 1}";
in
writeShellApplication {
  name = "adb-dev";
  runtimeInputs = [ git uv ];
  text = ''
    export ADB_PINNED_REV=${lib.escapeShellArg (if rev == null then "" else rev)}
    export ADB_REPO_URL=''${ADB_REPO_URL:-${lib.escapeShellArg httpsUrl}}
    exec ${py}/bin/python ${./adb_dev.py} "$@"
  '';
}
