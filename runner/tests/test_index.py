"""Derived indexes wrap card values; the run objects remain byte-authoritative."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys

import boto3
from moto import mock_aws
import pytest

from adb_runner import cli, index
from test_verify import saved


@pytest.fixture
def catalog(tmp_path):
    directory = tmp_path / "manifests"
    directory.mkdir()
    (directory / "assets").mkdir()
    readonly = []
    for name in ["alpha", "beta", "unindexed"]:
        package = tmp_path / name
        package.mkdir()
        (package / "schema.json").write_text(json.dumps({"title": name}))
        (package / "shared-schema.json").write_text('{"title":"shared"}')
        (package / "manifest.json").write_text(json.dumps({
            "name": name, "readme": "![Figure](images/figure.svg)",
            "schema": {"version": 0, "models": f"{name}:Payload", "path": str(package / "schema.json")},
        }))
        (directory / f"{name}.json").symlink_to(package / "manifest.json")
        assets = package / "assets"
        assets.mkdir()
        (assets / "empty").mkdir()
        (package / "images").mkdir()
        (package / "figure.svg").write_bytes(b"<svg>figure</svg>")
        (package / "images/figure.svg").symlink_to(package / "figure.svg")
        (assets / "images").symlink_to(package / "images", target_is_directory=True)
        (directory / "assets" / name).symlink_to(assets, target_is_directory=True)
        # Match the read-only trees reached through a Nix linkFarm.
        for parent in [assets, assets / "empty", package / "images"]:
            parent.chmod(0o555)
            readonly.append(parent)
    try:
        yield directory
    finally:
        for parent in readonly:
            parent.chmod(0o755)


@pytest.fixture
def stores(saved, tmp_path, monkeypatch, catalog):
    directory, _ = saved
    for name in list(os.environ):
        if name.startswith("AWS_"):
            monkeypatch.delenv(name)
    config = tmp_path / "config"
    credentials = tmp_path / "credentials"
    config_text = "".join(f"[profile {name}]\nregion = us-east-1\n" for name in ["first", "second"])
    credential_text = "".join(f"[{name}]\naws_access_key_id = testing\naws_secret_access_key = testing-secret\n" for name in ["first", "second"])
    config.write_text(config_text)
    credentials.write_text(credential_text)
    monkeypatch.setenv("AWS_CONFIG_FILE", str(config))
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    with mock_aws(config={"core": {"mock_credentials": False}}):
        s3 = boto3.Session(profile_name="first").client("s3")
        for name in ["store-one", "store-two"]:
            s3.create_bucket(Bucket=name)
        originals = {}
        for number, (bucket, experiment, condition) in enumerate([
            ("store-one", "alpha", "c1"), ("store-one", "beta", "c2"), ("store-two", "alpha", "c3"),
        ], 1):
            card = json.loads((directory / "run.json").read_bytes())
            card["identity"].update(experiment=experiment, condition=condition, run=f"20260918t120000z-{number:012x}")
            card["inputs"]["params"].update(unicode="café", fraction=1.0)
            raw = json.dumps(card, ensure_ascii=False, indent=2).encode() + b"\n"
            key = f"prefix/runs/{condition}-{experiment}/{card['identity']['run']}/run.json"
            originals[bucket, key] = raw
            s3.put_object(Bucket=bucket, Key=key, Body=raw)
            s3.put_object(Bucket=bucket, Key=key.replace("run.json", "events.jsonl.zst"), Body=b"stream")
        # An unfinished upload is not indexed.
        s3.put_object(Bucket="store-one", Key="prefix/runs/c1-alpha/incomplete/run.json", Body=b"{}")
        path = tmp_path / "stores.json"
        value = {"v": 0, "stores": [
            {"s3": "s3://store-one/prefix", "profile": "first", "url": "https://data.example.org/one"},
            {"s3": "s3://store-two/prefix", "profile": "second", "url": "https://data.example.org/two"},
        ]}
        path.write_text(json.dumps(value))
        def invoke(to, *args):
            monkeypatch.setattr(sys, "argv", ["adb-runner", "index", "--stores", str(path), "--to", str(to), "--catalog", str(catalog), *args])
            return cli.main()
        yield s3, path, value, originals, invoke
        for (bucket, key), raw in originals.items():
            assert s3.get_object(Bucket=bucket, Key=key)["Body"].read() == raw
    assert config.read_text() == config_text
    assert credentials.read_text() == credential_text


def test_two_stores_wrap_values_and_open_only_source_clients(stores, tmp_path, monkeypatch):
    _, _, _, originals, invoke = stores
    calls, sessions, clients = [], [], []
    session = boto3.Session
    def factory(*args, **kwargs):
        sessions.append((args, kwargs))
        result = session(*args, **kwargs)
        actual = result.client
        def client(*args, **kwargs):
            clients.append((args, kwargs))
            value = actual(*args, **kwargs)
            value.meta.events.register("before-call.s3", lambda model, **kw: calls.append(model.name))
            return value
        result.client = client
        return result
    monkeypatch.setattr(boto3, "Session", factory)
    class Clock:
        @staticmethod
        def now(tz):
            return datetime(2026, 9, 18, 12, tzinfo=timezone.utc)
    monkeypatch.setattr(index, "datetime", Clock)
    destination = tmp_path / "index dir's"
    assert invoke(destination) == 0
    root = json.loads((destination / "index.json").read_bytes())
    assert root == {"v": 0, "experiments": [{"name": "alpha", "runs": 2}, {"name": "beta", "runs": 1}],
                    "runs": 3, "built_at": "2026-09-18T12:00:00.000000Z"}
    rows = [json.loads(line) for name in ["alpha", "beta"] for line in (destination / f"experiments/{name}/index.jsonl").read_bytes().splitlines()]
    for row in rows:
        assert set(row) == {"store", "card"}
        bucket = "store-one" if row["store"].endswith("/one") else "store-two"
        identity = row["card"]["identity"]
        key = f"prefix/runs/{identity['condition']}-{identity['experiment']}/{identity['run']}/run.json"
        assert row["card"] == json.loads(originals[bucket, key])
    assert b"caf\xc3\xa9" in (destination / "experiments/alpha/index.jsonl").read_bytes()
    assert sessions == [((), {"profile_name": name}) for name in ["first", "second"]]
    assert clients == [(("s3",), {})] * 2
    assert set(calls) == {"ListObjectsV2", "GetObject"}


@pytest.mark.parametrize("filters, expected", [
    ({}, 3), ({"experiments": ["beta"]}, 1), ({"conditions": ["c1"]}, 1),
    ({"runs": ["20260918t120000z-000000000003"]}, 1), ({"runs": []}, 0),
    ({"experiments": ["alpha"], "conditions": ["c3"]}, 1),
])
def test_store_filters(stores, tmp_path, filters, expected):
    _, path, value, _, invoke = stores
    for store in value["stores"]:
        store.update(filters)
    path.write_text(json.dumps(value))
    destination = tmp_path / "index dir's"
    assert invoke(destination) == 0
    root = json.loads((destination / "index.json").read_bytes())
    assert root["runs"] == expected
    assert re.fullmatch(r".*\.\d{6}Z", root["built_at"])
    catalog = json.loads((destination / "catalog.json").read_bytes())
    assert [manifest["name"] for manifest in catalog["manifests"]] == [entry["name"] for entry in root["experiments"]]


def test_catalog_only_indexes_selected_manifests_hints_and_dereferenced_assets(stores, catalog, tmp_path, monkeypatch):
    _, _, _, _, invoke = stores
    # An unused registry entry must never be opened.
    (catalog / "unindexed.json").write_text("not JSON")
    shared_reads = []
    read_bytes = Path.read_bytes
    def reading(path):
        if path.name == "shared-schema.json":
            shared_reads.append(path)
        return read_bytes(path)
    monkeypatch.setattr(Path, "read_bytes", reading)
    destination = tmp_path / "index"
    assert invoke(destination) == 0
    value = json.loads((destination / "catalog.json").read_bytes())
    assert set(value) == {"v", "manifests", "shared", "hints"}
    assert value["v"] == 0
    assert [manifest["name"] for manifest in value["manifests"]] == ["alpha", "beta"]
    assert value["shared"] == {"title": "shared"}
    assert value["hints"] == {name: {"0": {"title": name}} for name in ["alpha", "beta"]}
    assert len(shared_reads) == 1
    for manifest in value["manifests"]:
        name = manifest["name"]
        original = json.loads((catalog / f"{name}.json").read_bytes())
        assert "path" in original["schema"]  # Export never edits the source manifest.
        del original["schema"]["path"]
        assert manifest == original
        assert (destination / f"catalog/assets/{name}/images/figure.svg").read_bytes() == b"<svg>figure</svg>"
        assert not (destination / f"catalog/assets/{name}/empty").exists()
    assert not (destination / "catalog/assets/unindexed").exists()
    assert not any(path.is_symlink() for path in destination.rglob("*"))


def test_missing_manifest_warns_and_keeps_run_only_experiment(stores, catalog, tmp_path, capsys):
    _, _, _, _, invoke = stores
    (catalog / "beta.json").unlink()
    destination = tmp_path / "index"
    assert invoke(destination) == 0
    assert f"WARNING: skipping missing manifest {catalog / 'beta.json'}" in capsys.readouterr().err
    assert json.loads((destination / "index.json").read_bytes())["runs"] == 3
    assert (destination / "experiments/beta/index.jsonl").is_file()
    value = json.loads((destination / "catalog.json").read_bytes())
    assert [manifest["name"] for manifest in value["manifests"]] == ["alpha"]
    assert set(value["hints"]) == {"alpha"}
    assert not (destination / "catalog/assets/beta").exists()


def test_rebuild_removes_obsolete_shards_and_writes_root_last(stores, tmp_path, monkeypatch):
    _, path, value, _, invoke = stores
    destination = tmp_path / "index"
    assert invoke(destination) == 0
    (destination / "stale.txt").write_text("previous deployment")
    value["stores"] = [value["stores"][0] | {"experiments": ["alpha"]}]
    path.write_text(json.dumps(value))
    write_bytes = Path.write_bytes
    written = []
    def writing(file, data):
        if destination in file.parents:
            assert not (destination / "index.json").exists()
            written.append(file.relative_to(destination).as_posix())
        return write_bytes(file, data)
    monkeypatch.setattr(Path, "write_bytes", writing)
    assert invoke(destination) == 0
    assert json.loads((destination / "index.json").read_bytes())["runs"] == 1
    assert len((destination / "experiments/alpha/index.jsonl").read_bytes().splitlines()) == 1
    assert not (destination / "experiments/beta").exists()
    assert not (destination / "stale.txt").exists()
    assert not (destination / "catalog/assets/beta").exists()
    assert [manifest["name"] for manifest in json.loads((destination / "catalog.json").read_bytes())["manifests"]] == ["alpha"]
    assert written == ["experiments/alpha/index.jsonl", "catalog.json", "index.json"]


def test_dry_run_counts_and_sizes_without_creating_or_deleting(stores, tmp_path, capsys):
    _, path, value, _, invoke = stores
    value["stores"][0]["experiments"] = ["alpha"]
    path.write_text(json.dumps(value))
    destination = tmp_path / "absent"
    assert invoke(destination, "--dry-run") == 0
    output = capsys.readouterr().out
    assert "STORE s3://store-one/prefix 1 runs" in output
    assert "STORE s3://store-two/prefix 1 runs" in output
    assert re.search(r"PLAN .*experiments/alpha/index.jsonl \d+ bytes", output)
    assert re.search(r"PLAN .*index.json \d+ bytes", output)
    assert re.search(r"PLAN .*catalog.json \d+ bytes", output)
    assert "catalog/assets/alpha/images/figure.svg 17 bytes" in output
    assert "catalog/assets/beta" not in output
    assert "catalog/assets/unindexed" not in output
    assert not destination.exists()
    destination.mkdir()
    marker = destination / "stale.txt"
    marker.write_bytes(b"keep during dry-run")
    assert invoke(destination, "--dry-run") == 0
    assert list(destination.iterdir()) == [marker]
    assert marker.read_bytes() == b"keep during dry-run"


@pytest.mark.parametrize("removed", [["--profile", "first"], ["--to", "s3://indexes/public"]])
def test_removed_destination_options_are_rejected(tmp_path, monkeypatch, removed, catalog):
    monkeypatch.setattr(sys, "argv", ["adb-runner", "index", "--stores", str(tmp_path / "stores.json"),
                                     "--to", str(tmp_path / "index"), "--catalog", str(catalog), *removed])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    assert not (tmp_path / "index").exists()


def test_catalog_is_required(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["adb-runner", "index", "--stores", str(tmp_path / "stores.json"),
                                     "--to", str(tmp_path / "index")])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    assert "--catalog" in capsys.readouterr().err
    assert not (tmp_path / "index").exists()


@pytest.mark.parametrize("catalog_kind", ["missing", "file"])
@pytest.mark.parametrize("dry_run", [False, True])
def test_invalid_catalog_fails_before_collecting_or_replacing_output(tmp_path, monkeypatch, capsys, catalog_kind, dry_run):
    catalog = tmp_path / "catalog"
    if catalog_kind == "file":
        catalog.write_text("not a directory")
    stores = tmp_path / "stores.json"
    stores.write_text('{"v":0,"stores":[]}')
    destination = tmp_path / "index"
    destination.mkdir()
    marker = destination / "existing.txt"
    marker.write_bytes(b"keep existing index")
    def unexpected_collect(_):
        pytest.fail("invalid catalog must be rejected before collect()")
    monkeypatch.setattr(index, "collect", unexpected_collect)
    monkeypatch.setattr(sys, "argv", ["adb-runner", "index", "--stores", str(stores),
                                     "--catalog", str(catalog), "--to", str(destination),
                                     *(["--dry-run"] if dry_run else [])])
    assert cli.main() == 1
    output = capsys.readouterr()
    assert f"index: FAIL: --catalog must be an existing directory: {catalog}" in output.err
    assert not output.out
    assert list(destination.iterdir()) == [marker]
    assert marker.read_bytes() == b"keep existing index"


def test_bad_and_disappearing_cards_warn_without_blocking_healthy_stores(stores, tmp_path, monkeypatch, capsys):
    s3, _, _, _, invoke = stores
    bad = [b"{", b"[]", b"{}", b'{"identity":null}',
           b'{"identity":{"experiment":"../bad","condition":"c","run":"r"}}',
           b'{"identity":{"experiment":"alpha","condition":null,"run":"r"}}',
           b'{"identity":{"experiment":"alpha","condition":"c","run":"r"},"bad":"\\ud800"}']
    rejected = []
    for number, body in enumerate([*bad, b"disappearing"]):
        key = f"prefix/runs/bad-alpha/{number}/run.json"
        rejected.append(key)
        s3.put_object(Bucket="store-one", Key=key, Body=body)
        s3.put_object(Bucket="store-one", Key=key.replace("run.json", "events.jsonl.zst"), Body=b"stream")
    list_keys = index.keys
    def listing(client, target, prefix):
        result = list_keys(client, target, prefix)
        if target.bucket == "store-one":
            s3.delete_object(Bucket="store-one", Key=rejected[-1])
        return result
    monkeypatch.setattr(index, "keys", listing)
    destination = tmp_path / "index"
    assert invoke(destination) == 0
    output = capsys.readouterr()
    assert output.err.count("WARNING: skipping") == len(rejected)
    for key in rejected:
        assert f"s3://store-one/{key}" in output.err
    assert "card disappeared while indexing" in output.err
    assert "STORE s3://store-one/prefix 2 runs" in output.out
    assert "STORE s3://store-two/prefix 1 runs" in output.out
    assert json.loads((destination / "index.json").read_bytes())["runs"] == 3
