"""adb-dev — the ADB authoring CLI.

    adb-dev init NAME       scaffold an external experiment repo (plain Nix)
    adb-dev fork EXP NAME   copy a registry experiment out into an external repo
    adb-dev bump            move the repo's adb pin (default.nix + uv sources + uv.lock)
    adb-dev pin             print the adb rev this repo (or this tool) is pinned to

The wrapper bakes in ADB_PINNED_REV (the rev of the adb this tool was built from —
empty when built from an unpinned checkout), ADB_REPO_URL, and ADB_EXPERIMENTS_DIR
(the registry tree of that same adb — what `fork` copies from). The tool never
parses flake.lock/npins/anything: the rev either arrives baked, is read from the
scaffold's own managed pin block, or is stated with --rev. uv is the assumed Python
tool; a project without `[tool.uv.sources]` gets printed instructions instead of
edits.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import tomlkit

LIB_NAMES = ("adb-events", "adb-experiment", "adb-inspect")
PIN_MARKER = "adb pin — managed by `adb-dev bump`"
PIN_REV_RE = re.compile(r'(rev\s*=\s*")([0-9a-f]{40})(")')
PIN_REF_RE = re.compile(r'ref\s*=\s*"([^"]+)"')


def die(msg: str) -> "NoReturn":  # noqa: F821 - py3.13 has NoReturn in typing only
    print(f"adb-dev: {msg}", file=sys.stderr)
    raise SystemExit(1)


def baked_rev() -> str | None:
    return os.environ.get("ADB_PINNED_REV") or None


def repo_url(override: str | None = None) -> str:
    return override or os.environ.get("ADB_REPO_URL") or die("no ADB repo URL known")


def ls_remote(url: str, ref: str) -> str:
    out = subprocess.run(
        ["git", "ls-remote", url, ref],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    if not out:
        die(f"{url} has no ref {ref!r}")
    return out.split()[0]


# ---------------------------------------------------------------- pin block


def find_pin_block(text: str) -> tuple[int, int] | None:
    """(start, end) offsets of the managed block in default.nix, or None."""
    lines = text.splitlines(keepends=True)
    marks = [i for i, ln in enumerate(lines) if PIN_MARKER in ln]
    if len(marks) < 1:
        return None
    start = sum(len(ln) for ln in lines[: marks[0]])
    # the block runs to the next marker-style rule line, else a few lines down
    end_line = next(
        (i for i, ln in enumerate(lines) if i > marks[0] and ln.strip().startswith("# ─")),
        min(marks[0] + 8, len(lines) - 1),
    )
    end = sum(len(ln) for ln in lines[: end_line + 1])
    return start, end


def read_pin(path: Path) -> tuple[str, str] | None:
    """(rev, ref) from the managed block of `path`, or None."""
    if not path.exists():
        return None
    text = path.read_text()
    span = find_pin_block(text)
    if span is None:
        return None
    block = text[span[0]:span[1]]
    rev = PIN_REV_RE.search(block)
    ref = PIN_REF_RE.search(block)
    return (rev.group(2), ref.group(1) if ref else "main") if rev else None


def write_pin_rev(path: Path, rev: str) -> bool:
    text = path.read_text()
    span = find_pin_block(text)
    if span is None:
        return False
    block, n = PIN_REV_RE.subn(rf"\g<1>{rev}\g<3>", text[span[0]:span[1]])
    if n == 0:
        return False
    path.write_text(text[: span[0]] + block + text[span[1]:])
    return True


# ---------------------------------------------------------------- uv side


def rewrite_uv_sources(pyproject: Path, rev: str) -> list[str]:
    """Set rev on the adb-* git entries in [tool.uv.sources]; return touched names."""
    doc = tomlkit.parse(pyproject.read_text())
    sources = doc.get("tool", {}).get("uv", {}).get("sources", None)
    if sources is None:
        return []
    touched = []
    for name in LIB_NAMES:
        entry = sources.get(name)
        if entry is not None and "git" in entry:
            entry["rev"] = rev
            touched.append(name)
    if touched:
        pyproject.write_text(tomlkit.dumps(doc))
    return touched


def repath_uv_sources(pyproject: Path, dirname: str, url: str, rev: str) -> list[str]:
    """In-tree path sources for the adb libraries → git sources at `rev`.

    The exact inverse of the contributing rewrite: a registry directory reaches
    the adb libraries as `{ path = "../../lib/…" }`; outside the tree those
    paths resolve nowhere, so they become git sources on the adb repo.
    """
    doc = tomlkit.parse(pyproject.read_text())
    sources = doc.get("tool", {}).get("uv", {}).get("sources", None)
    if sources is None:
        return []
    touched = []
    for name in LIB_NAMES:
        entry = sources.get(name)
        if entry is not None and "path" in entry:
            # the path is relative to experiments/<dirname>/ in the adb tree
            sub = os.path.normpath(f"experiments/{dirname}/{entry['path']}")
            git = tomlkit.inline_table()
            git["git"] = url
            git["subdirectory"] = sub
            git["rev"] = rev
            sources[name] = git
            touched.append(name)
    if touched:
        pyproject.write_text(tomlkit.dumps(doc))
    return touched


def rename_experiments(package_nix: Path, old: str, new: str) -> list[tuple[str, str]]:
    """Rename `old`(-suffixed) declarations in package.nix to `new`(-suffixed).

    Textual and deliberately narrow — only the two identity-bearing positions:
    attribute bindings at line start and `name = "…"` strings. Anything else
    that mentions the old name (upstream URLs, `pkg:` refs, prose) is not a
    declaration and stays untouched. Returns the (old, new) pairs applied.
    """
    text = package_nix.read_text()
    renamed: dict[str, str] = {}

    def sub(m: re.Match[str]) -> str:
        target = new + m.group(2)[len(old):]
        renamed[m.group(2)] = target
        return m.group(1) + target + m.group(3)

    stem = rf"({re.escape(old)}(?:-[a-z0-9-]+)?)"
    text = re.sub(rf"(?m)^(\s*){stem}(\s*=)", sub, text)
    text = re.sub(rf'(name\s*=\s*"){stem}(")', sub, text)
    if renamed:
        package_nix.write_text(text)
    return sorted(renamed.items())


def uv_lock(cwd: Path) -> bool:
    lock = cwd / "uv.lock"
    if lock.exists() and lock.stat().st_size == 0:
        lock.unlink()  # the empty `init --no-lock` placeholder; uv refuses to parse it
    print("adb-dev: running `uv lock` …")
    return subprocess.run(["uv", "lock"], cwd=cwd).returncode == 0


# ---------------------------------------------------------------- commands


def cmd_pin(args: argparse.Namespace) -> int:
    pin = read_pin(Path("default.nix"))
    rev = pin[0] if pin else baked_rev()
    if rev is None:
        die("no pin here and this adb-dev was built from an unpinned adb")
    print(rev)
    return 0


def resolve_target(args: argparse.Namespace, url: str, ref: str) -> str:
    if args.rev:
        return args.rev
    if getattr(args, "latest", False):
        rev = ls_remote(url, ref)
        print(f"adb-dev: {ref} is at {rev}")
        return rev
    rev = baked_rev()
    if rev is None:
        die("this adb-dev was built from an unpinned adb — pass --rev or --latest")
    return rev


def cmd_bump(args: argparse.Namespace) -> int:
    dnix = Path("default.nix")
    pin = read_pin(dnix)
    url = repo_url()
    target = resolve_target(args, url, pin[1] if pin else "main")

    if pin:
        if pin[0] == target:
            print(f"adb-dev: default.nix already at {target}")
        elif write_pin_rev(dnix, target):
            print(f"adb-dev: default.nix pin {pin[0][:12]} → {target[:12]}")
        else:
            die("pin block found but could not rewrite it — set rev by hand")
    else:
        print(f"adb-dev: no managed pin block in ./default.nix — set your nix pin to {target} yourself")

    touched = rewrite_uv_sources(Path("pyproject.toml"), target) if Path("pyproject.toml").exists() else []
    if touched:
        print(f"adb-dev: pyproject.toml sources → {target[:12]} ({', '.join(touched)})")
        if not args.no_lock and not uv_lock(Path.cwd()):
            die("`uv lock` failed — pyproject.toml is already updated; re-run `uv lock` when it can reach the network")
    else:
        print(f"adb-dev: no adb git sources in pyproject.toml — if your Python tool pins them, point it at {target}")
    return 0


SCAFFOLD = {
    "default.nix": '''\
# @NAME@ — an ADB experiment (@PROVENANCE@).
#
#   $(nix-build --no-out-link -A exec.@NAME@) --set turns=3
#   $(nix-build --no-out-link -A exec.adb-web)      # web GUI; @NAME@ is in the catalog
#   $(nix-build --no-out-link -A exec.adb-dev) bump --latest
let
  # ── adb pin — managed by `adb-dev bump` ─────────────────────────────
  adb = builtins.fetchGit {
    url = "@URL@";
    ref = "@REF@";
    rev = "@REV@";
  };
  # ────────────────────────────────────────────────────────────────────
in
import adb {
  experiments = ./.;
  adbRev = adb.rev;
}
''',
    "package.nix": '''\
{ adb, lib }:
let
  env = adb.mkPythonEnv {
    name = "@NAME@-env";
    workspaceRoot = ./.;
  };
in
{
  "@NAME@" = adb.mkExperiment {
    name = "@NAME@";
    summary = "Scaffold: a few chat turns against one model — replace with your design.";
    src = [ ./package.nix ./pyproject.toml ./uv.lock ./@PKG@ ];
    params = with adb.types; {
      prompt = param str {
        description = "What to ask the model each turn.";
        initial = "In one sentence: something surprising about agent experiments.";
        order = 1;
      };
      turns = param int {
        description = "How many chat turns to run.";
        initial = 3;
        order = 2;
      };
      model = param llm {
        description = "provider/model. `mock/model` runs keyless and offline.";
        initial = "mock/model";
        order = 1000;
        group = "model";
      };
      temperature = param float {
        description = "Sampling temperature (the mock ignores it).";
        initial = 0.7;
        order = 1020;
        group = "generation";
      };
    };
    results = with adb.types; {
      status = str;
      turns = int;
      chars = int;
    };
    program = lib.getExe' env "@NAME@";
  };
}
''',
    "pyproject.toml": '''\
[project]
name = "@NAME@"
version = "0.1.0"
description = "An ADB experiment."
requires-python = ">=3.13"
dependencies = [
    "adb-events",
    "adb-experiment[llm]",
    "pydantic>=2",
]

# the adb libraries come from the adb repo at the SAME rev default.nix pins —
# `adb-dev bump` moves both together
[tool.uv.sources]
adb-events = { git = "@URL@", subdirectory = "lib/adb-events", rev = "@REV@" }
adb-experiment = { git = "@URL@", subdirectory = "lib/adb-experiment", rev = "@REV@" }

[project.scripts]
@NAME@ = "@PKG@.main:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["@PKG@"]
''',
    "@PKG@/__init__.py": "",
    "@PKG@/main.py": '''\
"""@NAME@ — scaffolded ADB experiment.

The program speaks the runner protocol (adb-experiment packages it): params
arrive as JSON on stdin (or a config path on argv for hand-runs), events leave
as JSON lines on stdout. Replace run() with your design — and mirror any
params/results change in package.nix.
"""

from __future__ import annotations

import os

from adb_events.emit import metric
from adb_experiment.llm import ChatClient
from adb_experiment.scaffold import experiment_main
from pydantic import BaseModel


class Params(BaseModel):
    prompt: str
    turns: int
    model: str
    temperature: float


def run(params: Params) -> None:
    client = ChatClient(
        params.model,
        agent="assistant",
        temperature=params.temperature,
        seed=int(os.environ.get("ADB_SEED", "0")),
    )
    chars = 0
    for turn in range(params.turns):
        response = client.chat.completions.create(
            model=params.model,
            messages=[{"role": "user", "content": f"(turn {turn + 1}) {params.prompt}"}],
        )
        chars += len(response.choices[0].message.content or "")
    metric(name="status", value="completed")
    metric(name="turns", value=params.turns)
    metric(name="chars", value=chars)


def main() -> int:
    return experiment_main(Params, run, prog="@NAME@", fallback_summary={"status": "error"})
''',
    ".gitignore": '''\
result
result-*
.venv/
__pycache__/
''',
    "README.md": '''\
# @NAME@

An [ADB](@WEBURL@) experiment in its own repository — scaffolded by
`adb-dev init @NAME@` from adb `@SHORTREV@`, then developed here. Runs land in
the shared databank home; conditions are versioned by the content of this
repo's experiment files, so they collate with runs of the same content
anywhere — including after this experiment joins the adb registry.

## What it does

A few chat turns against one model via the instrumented `ChatClient` — the
scaffold's working example. (Replace this section when you replace `run()`.)

## Layout

| file | role |
| --- | --- |
| `default.nix` | the adb pin — `adb-dev bump` moves it; never part of identity |
| `package.nix` | the declaration: params, results, and the program |
| `pyproject.toml`, `uv.lock` | a normal Python project; adb libraries at the same rev as the pin |
| `@PKG@/main.py` | the program: a pydantic `Params`, `run()`, `experiment_main` |

## Run it

Every param binds explicitly — run it bare and it prints the completed command
to copy. `mock/model` is keyless and offline:

```sh
$(nix-build --no-out-link -A exec.@NAME@) \
  --set 'prompt=In one sentence: something surprising about agent experiments.' \
  --set turns=3 \
  --set model=mock/model \
  --set temperature=0.7
```

And the web GUI, with this experiment in its catalog next to the built-in ones:

```sh
$(nix-build --no-out-link -A exec.adb-web)
```

## Change it

Replace `run()` in `@PKG@/main.py` with your design; mirror any params/results
change in `package.nix`. New Python dependencies are ordinary `uv add`. The
`src` list in `package.nix` is condition identity — the content hash of exactly
those paths versions your conditions, so the README, tests, and scaffolding
stay out of it.

## Move the pin

```sh
$(nix-build --no-out-link -A exec.adb-dev) bump --latest
```

moves `default.nix` and the `pyproject.toml` sources to the same adb rev and
relocks. `adb-dev pin` prints the current one.

---

Scaffolded by `adb-dev init`; the full story is the adb book's *Writing an
experiment* page.
''',
}


def cmd_init(args: argparse.Namespace) -> int:
    name = args.name
    if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
        die("NAME must be lowercase, alphanumeric with dashes, starting with a letter")
    pkg = name.replace("-", "_")
    dest = Path(args.dir or name)
    if dest.exists():
        die(f"{dest} already exists")

    url = repo_url(args.adb_url)
    rev = args.rev or baked_rev()
    if rev is None:
        print("adb-dev: built from an unpinned adb — asking the repo for its main rev")
        rev = ls_remote(url, "main")
    # the README's prose link: the canonical repo even when --adb-url points the
    # pin somewhere local — prose is for readers, the pin block is for fetchers
    web_url = os.environ.get("ADB_REPO_URL") or url
    subst = {"@NAME@": name, "@PKG@": pkg, "@URL@": url, "@REV@": rev,
             "@SHORTREV@": rev[:12], "@REF@": "main", "@WEBURL@": web_url,
             "@PROVENANCE@": "scaffolded by `adb-dev init`"}

    for relpath, template in SCAFFOLD.items():
        out = dest / _render(relpath, subst)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(_render(template, subst))
    print(f"adb-dev: scaffolded {dest}/ (adb pinned to {rev[:12]})")

    if args.no_lock or not uv_lock(dest):
        (dest / "uv.lock").touch(exist_ok=True)
        print("adb-dev: uv.lock not resolved yet — run `uv lock` in the new directory "
              "before building (the scaffold references it)")
    print(f"""
next steps:
  cd {dest}
  $(nix-build --no-out-link -A exec.{name}) --set turns=3
  $(nix-build --no-out-link -A exec.adb-web)""")
    return 0


FORK_README = '''\
# @NAME@

Forked from the [ADB](@WEBURL@) registry's `@SRC@` directory (adb `@SHORTREV@`)
by `adb-dev fork` — an external experiment repo of its own from here on.
Conditions are versioned by the content of this repo's experiment files, so the
fork mints new condition IDs from the very first run (the rename and the
dependency rewrite are content — the provenance genuinely changed); this
paragraph records the lineage.

## Run it

Every param binds explicitly — run it bare and it prints the completed command
to copy:

```sh
$(nix-build --no-out-link -A exec.@NAME@)
```

And the web GUI, with this experiment in its catalog next to the built-in ones:

```sh
$(nix-build --no-out-link -A exec.adb-web)
```

## Change it

The `src` list in `package.nix` is condition identity — the content hash of
exactly those paths versions your conditions, so tests and scaffolding stay
out of it. New Python dependencies are ordinary `uv add`.

## Move the pin

```sh
$(nix-build --no-out-link -A exec.adb-dev) bump --latest
```

moves `default.nix` and the `pyproject.toml` adb sources to the same adb rev
and relocks. `adb-dev pin` prints the current one.
'''


def cmd_fork(args: argparse.Namespace) -> int:
    old, new = args.experiment, args.name
    if not re.fullmatch(r"[a-z][a-z0-9_-]*", old):
        die("EXPERIMENT must be a registry directory name (lowercase)")
    if not re.fullmatch(r"[a-z][a-z0-9-]*", new):
        die("NAME must be lowercase, alphanumeric with dashes, starting with a letter")
    if new == old:
        die(f"pick a new name — the registry already claims {old!r}, and duplicates are refused at eval time")

    root = os.environ.get("ADB_EXPERIMENTS_DIR")
    if not root:
        die("this adb-dev carries no experiments tree — run the packaged adb-dev, not the bare script")
    src_dir = Path(root) / old
    if not (src_dir / "package.nix").exists():
        have = sorted(p.parent.name for p in Path(root).glob("*/package.nix"))
        die(f"no registry directory {old!r} — have: {', '.join(have)}")
    if (src_dir / "default.nix").exists():
        die(f"{old!r} has its own default.nix — not forkable as a scaffold")

    dest = Path(args.dir or new)
    if dest.exists():
        die(f"{dest} already exists")

    url = repo_url(args.adb_url)
    rev = args.rev or baked_rev()
    if rev is None:
        print("adb-dev: built from an unpinned adb — asking the repo for its main rev")
        rev = ls_remote(url, "main")

    shutil.copytree(src_dir, dest)
    for p in [dest, *dest.rglob("*")]:  # the source is a store path: read-only
        p.chmod(p.stat().st_mode | 0o200)
    print(f"adb-dev: forked {old}/ → {dest}/")

    renamed = rename_experiments(dest / "package.nix", old, new)
    for a, b in renamed:
        print(f"adb-dev: renamed {a} → {b} (package.nix)")
    if not renamed:
        print(f"adb-dev: package.nix declares nothing named after {old!r} — rename its "
              "experiments yourself (duplicate names are refused at eval time)")
    # the bare fork name if the directory declared one, else the first rename —
    # only for the generated prose (README, default.nix header), never behavior
    primary = dict(renamed).get(old) or (renamed[0][1] if renamed else new)

    touched = repath_uv_sources(dest / "pyproject.toml", old, url, rev)
    if touched:
        print(f"adb-dev: pyproject.toml adb sources path → git @ {rev[:12]} ({', '.join(touched)})")
    else:
        print("adb-dev: no in-tree adb path sources in pyproject.toml — nothing to repoint")

    web_url = os.environ.get("ADB_REPO_URL") or url
    subst = {"@NAME@": primary, "@SRC@": old, "@URL@": url, "@REV@": rev,
             "@SHORTREV@": rev[:12], "@REF@": "main", "@WEBURL@": web_url,
             "@PROVENANCE@": f"forked from the adb registry's `{old}` by `adb-dev fork`"}
    (dest / "default.nix").write_text(_render(SCAFFOLD["default.nix"], subst))
    if not (dest / "README.md").exists():
        (dest / "README.md").write_text(_render(FORK_README, subst))
    if not (dest / ".gitignore").exists():
        (dest / ".gitignore").write_text(SCAFFOLD[".gitignore"])
    print(f"adb-dev: pinned to adb {rev[:12]} (default.nix)")

    if args.no_lock or not uv_lock(dest):
        (dest / "uv.lock").write_text("")
        print("adb-dev: uv.lock not resolved yet — the copied lock pointed at in-tree "
              "paths; run `uv lock` in the new directory before building")
    print(f"""
next steps:
  cd {dest}
  $(nix-build --no-out-link -A exec.{primary})
  $(nix-build --no-out-link -A exec.adb-web)""")
    return 0


def _render(text: str, subst: dict[str, str]) -> str:
    for key, value in subst.items():
        text = text.replace(key, value)
    return text


def main() -> int:
    parser = argparse.ArgumentParser(prog="adb-dev", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="scaffold an external experiment repo")
    p_init.add_argument("name")
    p_init.add_argument("--dir", help="target directory (default: ./NAME)")
    p_init.add_argument("--rev", help="adb rev to pin (default: the rev this tool was built from)")
    p_init.add_argument("--adb-url", help="adb git URL (default: the canonical repo)")
    p_init.add_argument("--no-lock", action="store_true", help="skip running `uv lock`")
    p_init.set_defaults(fn=cmd_init)

    p_fork = sub.add_parser("fork", help="copy a registry experiment out into an external repo")
    p_fork.add_argument("experiment", help="registry experiment directory to fork (e.g. concordia)")
    p_fork.add_argument("name", help="the fork's experiment name (and default target directory)")
    p_fork.add_argument("--dir", help="target directory (default: ./NAME)")
    p_fork.add_argument("--rev", help="adb rev to pin (default: the rev this tool was built from)")
    p_fork.add_argument("--adb-url", help="adb git URL (default: the canonical repo)")
    p_fork.add_argument("--no-lock", action="store_true", help="skip running `uv lock`")
    p_fork.set_defaults(fn=cmd_fork)

    p_bump = sub.add_parser("bump", help="move this repo's adb pin (nix + uv together)")
    p_bump.add_argument("--rev", help="target rev (default: the rev this tool was built from)")
    p_bump.add_argument("--latest", action="store_true", help="resolve the pin's ref via git ls-remote")
    p_bump.add_argument("--no-lock", action="store_true", help="skip running `uv lock`")
    p_bump.set_defaults(fn=cmd_bump)

    p_pin = sub.add_parser("pin", help="print the pinned adb rev")
    p_pin.set_defaults(fn=cmd_pin)

    args = parser.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
