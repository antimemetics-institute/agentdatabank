"""Check that Nix builds locked local sources and filters development artifacts."""

from pathlib import Path
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[1]


def output(*args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def package(root, name, dependencies="[]", sources=""):
    root.mkdir(parents=True)
    module = name.replace("-", "_")
    (root / module).mkdir()
    (root / module / "__init__.py").write_text('ORIGIN = "locked-fixture"\n')
    (root / "pyproject.toml").write_text(f"""
[project]
name = "{name}"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = {dependencies}
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
{sources}
""")


with tempfile.TemporaryDirectory(prefix="adb-python-sources-") as directory:
    root = Path(directory)
    app = root / "app"
    # Deliberately use ADB names: the old inRepoOverlay replaced these sources.
    package(root / "libs/events", "adb-events")
    package(root / "libs/experiment", "adb-experiment")
    package(
        app,
        "source-fixture",
        '["adb-events", "adb-experiment"]',
        """
[tool.uv.sources]
adb-events = { path = "../libs/events", editable = true }
adb-experiment = { path = "../libs/experiment" }
""",
    )
    subprocess.run(["uv", "lock"], cwd=app, check=True)
    # Pass paths as arguments so checkout locations require no Nix escaping.
    expression = root / "build.nix"
    expression.write_text("""
{ repo, fixture }:
let
  pkgs = (import (builtins.toPath repo + "/default.nix") {}).pkgs;
  sources = import (builtins.toPath repo + "/pkgs/locked-sources.nix") {};
  pyproject-nix = import sources.pyproject-nix { inherit (pkgs) lib; };
  uv2nix = import sources.uv2nix { inherit (pkgs) lib; inherit pyproject-nix; };
  pyproject-build-systems = import sources.pyproject-build-systems {
    inherit (pkgs) lib;
    inherit pyproject-nix uv2nix;
  };
  adb = import (builtins.toPath repo + "/pkgs/build-support") {
    inherit pkgs pyproject-nix uv2nix pyproject-build-systems;
    origin = "fixture";
    adb-runner = null;
  };
in adb.mkPythonEnv {
  name = "source-fixture-env";
  workspaceRoot = /. + fixture;
}
""")
    arguments = [
        str(expression),
        "--argstr",
        "repo",
        str(REPO),
        "--argstr",
        "fixture",
        str(app),
    ]
    before = output("nix-instantiate", *arguments, cwd=root)
    for source in [app, root / "libs/events", root / "libs/experiment"]:
        (source / ".venv").mkdir()
        (source / ".venv/irrelevant").write_text("must not enter build inputs")
    after = output("nix-instantiate", *arguments, cwd=root)
    assert before == after, "Development artifacts changed the build derivation"
    env = output("nix-build", "--no-out-link", *arguments, cwd=root)
    subprocess.run(
        [
            env + "/bin/python",
            "-c",
            """
import adb_events, adb_experiment
assert adb_events.ORIGIN == "locked-fixture"
assert adb_experiment.ORIGIN == "locked-fixture"
""",
        ],
        cwd=root,
        check=True,
    )
    (root / "libs/events/adb_events/__init__.py").write_text('ORIGIN = "changed"\n')
    changed = output("nix-instantiate", *arguments, cwd=root)
    assert changed != after, "Local implementation change did not reach the build"
    print("Python source selection and filtering: passed")
