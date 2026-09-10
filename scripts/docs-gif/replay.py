#!/usr/bin/env python3
"""Recording-only adapter: replay saved payloads through the real ADB runner."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import time


def contained(root, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts:
        raise ValueError(f'unsafe artifact path: {name}')
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f'artifact escapes run directory: {name}')
    return path


def load_capture(source):
    metadata = json.loads((source / 'run.json').read_text())
    if metadata.get('state') != 'completed':
        raise ValueError('replay requires a completed saved run')
    events = []
    previous_seq = -1
    files = sorted(source.glob('events-*.jsonl'))
    if not files:
        raise ValueError('saved run has no event files')
    for file in files:
        for line in file.read_text().splitlines():
            event = json.loads(line)
            if event['run'] != metadata['run'] or event['seq'] <= previous_seq:
                raise ValueError('saved event run/sequence mismatch')
            previous_seq = event['seq']
            event['_time'] = datetime.datetime.fromisoformat(event['ts'].replace('Z', '+00:00')).timestamp()
            if event['event'].get('type') == 'artifact':
                if not contained(source, event['event']['path']).is_file():
                    raise ValueError('missing recorded artifact')
            events.append(event)
    return metadata, events, files


def replay(source, destination, speed, params, emit, clock=time.monotonic, sleep=time.sleep):
    if not math.isfinite(speed) or speed <= 0:
        raise ValueError('speed must be positive and finite')
    source, destination = source.resolve(), destination.resolve()
    if destination == source or destination.is_relative_to(source) or source.is_relative_to(destination):
        raise ValueError('replay output must be separate from original run')
    metadata, events, files = load_capture(source)
    if params != metadata['realized_params']:
        raise ValueError('replay parameters must match captured realized_params')
    # Validate all paths before creating any output or emitting payloads.
    for envelope in events:
        event = envelope['event']
        if event.get('type') == 'artifact':
            relative = Path(event['path'])
            if len(relative.parts) == 1 and (relative.name == 'run.json' or
                                           relative.match('events-*.jsonl')):
                raise ValueError('artifact would overwrite runner-owned metadata')
            contained(destination, event['path'])
    provenance_path = 'artifacts/docs-recording-replay.json'
    if any(e['event'].get('path') == provenance_path for e in events):
        raise ValueError('capture uses reserved replay provenance artifact path')
    provenance = {
        'kind': 'saved-run-replay', 'original_run': metadata, 'speed': speed,
        'note': 'Recorded payloads replayed; no experiment or model was executed. Usage is historical.',
        'sha256': {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in [source / 'run.json', *files,
                             *(contained(source, e['event']['path']) for e in events
                               if e['event'].get('type') == 'artifact')]},
    }
    path = contained(destination, provenance_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(provenance, indent=2) + '\n')
    emit({'type': 'artifact', 'name': 'docs-recording-replay', 'path': provenance_path,
          'media_type': 'application/json', 'bytes': path.stat().st_size})
    started = clock()
    baseline = events[0]['_time']
    for envelope in events:
        event = envelope['event']
        if isinstance(event.get('type'), str) and event['type'].startswith('run.'):
            continue
        delay = (envelope['_time'] - baseline) / speed - (clock() - started)
        if delay > 0:
            sleep(delay)
        if event.get('type') == 'artifact':
            target = contained(destination, event['path'])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(contained(source, event['path']), target)
        emit(event)


def main():
    from adb_events import PRODUCER_ADAPTER, emit

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--speed', type=float, default=1)
    args = parser.parse_args()
    replay(args.run, Path(os.environ['ADB_RUN_DIR']), args.speed, json.load(sys.stdin),
           lambda event: emit(PRODUCER_ADAPTER.validate_python(event, strict=True)))


if __name__ == '__main__':
    main()
