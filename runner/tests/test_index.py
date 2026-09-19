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
def stores(saved, tmp_path, monkeypatch):
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
            monkeypatch.setattr(sys, "argv", ["adb-runner", "index", "--stores", str(path), "--to", str(to), *args])
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
    assert written == ["experiments/alpha/index.jsonl", "index.json"]


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
    assert not destination.exists()
    destination.mkdir()
    marker = destination / "stale.txt"
    marker.write_bytes(b"keep during dry-run")
    assert invoke(destination, "--dry-run") == 0
    assert list(destination.iterdir()) == [marker]
    assert marker.read_bytes() == b"keep during dry-run"


@pytest.mark.parametrize("removed", [["--profile", "first"], ["--to", "s3://indexes/public"]])
def test_removed_destination_options_are_rejected(tmp_path, monkeypatch, removed):
    monkeypatch.setattr(sys, "argv", ["adb-runner", "index", "--stores", str(tmp_path / "stores.json"),
                                     "--to", str(tmp_path / "index"), *removed])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    assert not (tmp_path / "index").exists()


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
