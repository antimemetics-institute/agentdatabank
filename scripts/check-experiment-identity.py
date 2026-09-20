"""Probe actual experiment source hashes in an isolated copy of the checkout."""

from pathlib import Path
import json
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]
IGNORE = shutil.ignore_patterns(
    ".git", ".venv", "__pycache__", "node_modules", "dist", ".direnv",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "result", "result-*",
)


with tempfile.TemporaryDirectory(prefix="adb-identity-") as directory:
    root = Path(directory)
    checkout = root / "checkout"
    checkout.mkdir()
    for name in ("pkgs", "experiments", "lib", "runner"):
        shutil.copytree(REPO / name, checkout / name, ignore=IGNORE)
    for name in ("default.nix", "flake.lock", ".git-revision"):
        shutil.copyfile(REPO / name, checkout / name)
    expression = root / "identity.nix"
    expression.write_text('''{ repo }:
let
  root = builtins.toPath repo;
  pkgs = (import (root + "/default.nix") {}).pkgs;
  sources = import (root + "/pkgs/locked-sources.nix") {};
  adb = import (root + "/pkgs/top-level") {
    inherit pkgs;
    inherit (sources) pyproject-nix uv2nix pyproject-build-systems;
  };
in builtins.mapAttrs (_: exp: exp.source) {
  inherit (adb.experiments) govsim concordia inspect-hello;
}
''')

    def hashes():
        return json.loads(subprocess.check_output([
            "nix-instantiate", "--eval", "--strict", "--json", str(expression),
            "--argstr", "repo", str(checkout),
        ], text=True))

    def probe(relative, expected):
        path = checkout / relative
        original = path.read_bytes()
        try:
            path.write_bytes(original + b"\n# Source identity probe.\n")
            changed = {name for name, value in hashes().items() if value != before[name]}
            assert changed == expected, f"{relative}: expected {expected}, got {changed}"
            print(f"{relative}: changes {', '.join(sorted(changed)) or 'no experiment hashes'}")
        finally:
            path.write_bytes(original)

    before = hashes()
    probe("experiments/govsim/govsim_adapter/main.py", {"govsim"})
    probe("lib/adb-events/adb_events/emit.py", set(before))
    probe("lib/adb-inspect/adb_inspect/translate.py", {"inspect-hello"})
    probe("lib/adb-events/tests/test_emit.py", set())
    probe("experiments/govsim/README.mdx", set())
    cache = checkout / "lib/adb-events/adb_events/__pycache__"
    cache.mkdir()
    (cache / "ignored.pyc").write_bytes(b"development artifact")
    assert hashes() == before, "Development artifacts changed source identity"
    print("Shared source identity checks passed")
