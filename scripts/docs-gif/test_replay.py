"""Offline adapter checks; run: python3 -m unittest discover -s scripts/docs-gif."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('replay', Path(__file__).with_name('replay.py'))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source'
        self.dest = Path(self.temp.name) / 'dest'
        self.source.mkdir()
        self.dest.mkdir()
        self.params = {'model': 'openai/captured-model'}
        (self.source / 'run.json').write_text(json.dumps({'run': 'old', 'state': 'completed', 'params': self.params}))

    def capture(self, payloads):
        payloads = [dict(p) for p in payloads]
        if not payloads or payloads[0].get('type') != 'run.start':
            payloads.insert(0, {'type': 'run.start'})
        payloads[0].update(params=self.params)
        if payloads[-1].get('type') not in ('run.end', 'run.finish'):
            payloads.append({'type': 'run.end', 'state': 'completed'})
        else:
            payloads[-1].update(type='run.end', state='completed')
        (self.source / 'events.jsonl').write_text('\n'.join(json.dumps({
            'run': 'old', 'experiment': 'fixture', 'seq': n, 'ts': f'2026-01-01T00:00:{n * 2:02d}Z', 'event': event,
        }) for n, event in enumerate(payloads)))

    def test_timing_order_lifecycle_artifacts_and_unchanged_capture(self):
        (self.source / 'artifacts').mkdir()
        (self.source / 'artifacts/result.txt').write_text('original')
        payloads = [{'type': 'run.start'}, {'type': 'llm.call', 'model': self.params['model']},
                    {'type': 'artifact', 'path': 'artifacts/result.txt'}, {'type': 'metric', 'name': 'score', 'value': 5},
                    {'type': 'run.finish'}]
        self.capture(payloads)
        before = {p: p.read_bytes() for p in self.source.rglob('*') if p.is_file()}
        now, waits, emitted = [0], [], []
        def sleep(delay):
            waits.append(delay)
            now[0] += delay
        replay.replay(self.source, self.dest, 2, self.params, emitted.append, lambda: now[0], sleep)
        self.assertEqual(waits, [1, 1, 1])
        self.assertEqual(emitted[1:], payloads[1:4])
        self.assertEqual((self.dest / 'artifacts/result.txt').read_text(), 'original')
        self.assertEqual(before, {p: p.read_bytes() for p in self.source.rglob('*') if p.is_file()})
        provenance = json.loads((self.dest / emitted[0]['data']['path']).read_text())
        self.assertEqual(provenance['original_run']['run'], 'old')

    def test_capture_preserves_metadata_and_progress(self):
        metadata = {'run': 'old', 'state': 'completed', 'params': self.params}
        path = self.source / 'run.json'
        path.write_text(json.dumps(metadata))
        original = path.read_bytes()
        payloads = [{'type': 'status', 'phase': 'scoring'}]
        self.capture(payloads)
        emitted = []
        replay.replay(self.source, self.dest, 10000, self.params, emitted.append)
        self.assertEqual(emitted[1:], payloads)
        self.assertEqual(path.read_bytes(), original)
        provenance = json.loads((self.dest / emitted[0]['data']['path']).read_text())
        self.assertEqual(provenance['original_run']['params'], self.params)
        self.assertEqual(provenance['original_run']['state'], 'completed')

    def test_reject_incomplete_capture(self):
        self.capture([{'type': 'result'}])
        path = self.source / 'events.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        for state in ('failed', None):
            with self.subTest(state=state):
                rows[-1]['event']['state'] = state
                path.write_text('\n'.join(json.dumps(row) for row in rows))
                with self.assertRaisesRegex(ValueError, 'completed saved run'):
                    replay.load_capture(self.source)

    def test_card_is_not_a_replay_input(self):
        self.capture([{'type': 'log', 'message': 'evidence'}])
        (self.source / 'run.json').write_text('not even JSON')
        emitted = []
        replay.replay(self.source, self.dest, 10000, self.params, emitted.append)
        self.assertEqual(emitted[-1], {'type': 'log', 'message': 'evidence'})

    def test_unknown_types_preserved(self):
        payloads = [{'type': None}, {'type': 42}, {'custom': 'payload'}]
        self.capture(payloads)
        emitted = []
        replay.replay(self.source, self.dest, 10000, self.params, emitted.append)
        self.assertEqual(emitted[1:], payloads)

    def test_runner_metadata_cannot_be_an_artifact(self):
        self.capture([{'type': 'artifact', 'path': 'run.json'}])
        with self.assertRaisesRegex(ValueError, 'runner-owned'):
            replay.replay(self.source, self.dest, 1, self.params, lambda _: None)

    def test_reject_capture_that_already_contains_replay_provenance(self):
        self.capture([{'type': 'custom', 'kind': 'docs.recording_replay',
                       'data': {'path': 'artifacts/docs-recording-replay.json'}}])
        with self.assertRaisesRegex(ValueError, 'reserved replay provenance'):
            replay.replay(self.source, self.dest, 1, self.params, lambda _: None)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_reject_params_mismatch(self):
        self.capture([{'type': 'metric'}])
        with self.assertRaisesRegex(ValueError, 'parameters'):
            replay.replay(self.source, self.dest, 1, {'model': 'different'}, lambda _: None)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_new_defaults_are_recorded_without_changing_captured_inputs(self):
        self.capture([{'type': 'status', 'detail': 'recorded'}])
        emitted = []
        replay.replay(self.source, self.dest, 10000, {**self.params, 'threads': 2}, emitted.append,
                      defaults={'threads': 2})
        provenance = json.loads((self.dest / emitted[0]['data']['path']).read_text())
        self.assertEqual(provenance['original_run']['params'], self.params)
        self.assertEqual(provenance['added_defaults'], {'threads': 2})

    def test_defaults_cannot_override_capture_or_accept_changed_values(self):
        self.capture([{'type': 'status', 'detail': 'recorded'}])
        with self.assertRaisesRegex(ValueError, 'override'):
            replay.replay(self.source, self.dest, 1, self.params, lambda _: None,
                          defaults={'model': 'another-model'})
        with self.assertRaisesRegex(ValueError, 'parameters'):
            replay.replay(self.source, self.dest, 1, {**self.params, 'threads': 4}, lambda _: None,
                          defaults={'threads': 2})
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_reject_escape_paths_and_symlinks(self):
        outside = Path(self.temp.name) / 'outside'
        outside.write_text('private')
        (self.source / 'escape').symlink_to(outside)
        for path in ('../outside', str(outside), 'escape'):
            with self.subTest(path=path):
                self.capture([{'type': 'artifact', 'path': path}])
                with self.assertRaises(ValueError):
                    replay.replay(self.source, self.dest, 1, self.params, lambda _: None)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_reject_output_symlink(self):
        (self.source / 'file').write_text('recording')
        (self.dest / 'file').symlink_to(self.source / 'file')
        self.capture([{'type': 'artifact', 'path': 'file'}])
        with self.assertRaises(ValueError):
            replay.replay(self.source, self.dest, 1, self.params, lambda _: None)

    def test_reject_invalid_speed_and_original_destination(self):
        self.capture([{'type': 'metric'}])
        for speed in (0, -1, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                replay.replay(self.source, self.dest, speed, self.params, lambda _: None)
        with self.assertRaises(ValueError):
            replay.replay(self.source, self.source, 1, self.params, lambda _: None)


if __name__ == '__main__':
    unittest.main()
