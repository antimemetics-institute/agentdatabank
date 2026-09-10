"""Seed derivation — the value the runner hands every experiment as $ADB_SEED.

The bound is the point. This seed is forwarded verbatim into provider request
bodies and local-inference RNGs, which bind it narrowly (numpy rejects >= 2**32;
provider validators commonly cap at int64), so a seed that overflows is not a
degraded run — it is a 400 or a ValueError at generation time. These tests hold
the width; the derivation itself may change.
"""

import pytest

from adb_runner.cli import _derive_seed

UINT32_MAX = 2**32 - 1
CID = "ae70d6ab71a10b0ff1b21fee0aa14d5bffbfe685ceeea0bf4a1186a0d8da9809"


def _sweep(n: int = 2000):
    """Seeds across the three axes the derivation mixes."""
    return [_derive_seed(base, cid, rep)
            for base in range(n // 4)
            for cid in (CID, "0" * 64)
            for rep in (1, 2)]


def test_seed_fits_uint32():
    # the binding constraint: numpy's seeding (local HF inference) rejects
    # anything >= 2**32, and it is the narrowest consumer
    assert all(0 <= s <= UINT32_MAX for s in _sweep())


def test_seed_is_json_and_jq_safe():
    # the seed rides to the experiment through a jq --argjson lift into a JSON
    # config; staying under 2**53 keeps it exact for any consumer that parses
    # JSON numbers as doubles
    assert all(s < 2**53 for s in _sweep())


def test_seed_varies_across_replicates():
    # what the derivation is FOR: replicates of one condition must not share a
    # seed (a fixed seed collapses them into repeats of a single draw)
    seeds = [_derive_seed(7, CID, r) for r in range(1, 33)]
    assert len(set(seeds)) == len(seeds)


def test_seed_varies_across_conditions_and_base():
    base = _derive_seed(7, CID, 1)
    assert _derive_seed(8, CID, 1) != base          # base seed
    assert _derive_seed(7, "0" * 64, 1) != base     # condition


def test_seed_is_deterministic():
    # the recorded base seed + cid + replicate must reproduce the run's seed
    assert _derive_seed(7, CID, 3) == _derive_seed(7, CID, 3)


def test_seed_spreads_across_the_range():
    # a narrowed width must still be a real hash, not a small-integer counter:
    # both halves of the uint32 range get used
    seeds = _sweep()
    assert any(s > UINT32_MAX // 2 for s in seeds)
    assert any(s < UINT32_MAX // 2 for s in seeds)


@pytest.mark.parametrize("base_seed", [42, -1, None])
def test_successful_later_replicate_does_not_hide_failure(tmp_path, monkeypatch, base_seed):
    import json
    import sys
    from adb_runner import cli

    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"name": "fixture", "params": {}}))
    marker = tmp_path / "first-run"
    experiment = tmp_path / "experiment"
    experiment.write_text(
        f"#!/bin/sh\nif [ -e '{marker}' ]; then exit 0; fi\n"
        f"touch '{marker}'\nexit 3\n")
    experiment.chmod(0o755)
    home = tmp_path / "home"
    monkeypatch.setenv("ADB_MANIFEST", str(manifest))
    monkeypatch.setenv("ADB_EXPERIMENT_BIN", str(experiment))
    monkeypatch.setattr(cli, "resolve_viewer", lambda _: ("http://localhost", None))
    argv = ["adb-runner", "--json", "--replicates", "2", "--out", str(home)]
    if base_seed is not None:
        argv += ["--seed", str(base_seed)]
    monkeypatch.setattr(sys, "argv", argv)
    assert cli.main() == 1
    states = [json.loads(path.read_text())["state"]
              for path in home.glob("runs/*/*/run.json")]
    assert sorted(states) == ["completed", "failed"]
    records = [json.loads(path.read_text()) for path in home.glob("runs/*/*/run.json")]
    assert len({record["base_seed"] for record in records}) == 1
    assert {record["replicate"] for record in records} == {1, 2}
    for record in records:
        if base_seed is not None:
            assert record["base_seed"] == base_seed
        assert record["replicates"] == 2
        assert record["seed"] == _derive_seed(
            record["base_seed"], record["condition"], record["replicate"]
        )


@pytest.mark.parametrize("json_output", [False, True])
@pytest.mark.parametrize("non_interactive", [False, True])
@pytest.mark.parametrize("terminal", [False, True])
def test_output_and_interaction_are_independent(
    tmp_path, monkeypatch, capsys, json_output, non_interactive, terminal
):
    import json
    import sys
    from adb_runner import cli

    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"name": "fixture", "params": {}}))
    experiment = tmp_path / "experiment"
    experiment.write_text("#!/bin/sh\nexit 0\n")
    experiment.chmod(0o755)
    monkeypatch.setenv("ADB_MANIFEST", str(manifest))
    monkeypatch.setenv("ADB_EXPERIMENT_BIN", str(experiment))
    monkeypatch.setattr(sys.stdin, "isatty", lambda: terminal)
    monkeypatch.setattr(cli, "resolve_viewer", lambda _: ("http://localhost", None))
    interactions = []

    def resolve_credentials(*args, interactive, **kwargs):
        interactions.append(interactive)
        return {}

    monkeypatch.setattr(cli.credentials, "resolve_run_credentials", resolve_credentials)
    argv = ["adb-runner", "--out", str(tmp_path / "runs")]
    if json_output:
        argv.append("--json")
    if non_interactive:
        argv.append("--non-interactive")
    monkeypatch.setattr(sys, "argv", argv)
    assert cli.main() == 0
    assert interactions == [terminal and not non_interactive]
    output = capsys.readouterr().out
    if json_output:
        events = [json.loads(line)["event"] for line in output.splitlines()]
        assert events[0]["type"] == "run.start"
        assert events[-1]["type"] == "run.end"
    else:
        assert output == ""
