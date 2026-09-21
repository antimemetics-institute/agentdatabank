import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSettings, prepareFigure, quantile } from './govsim-figure.ts';
import type { ExplorationRow } from './exploration-data.ts';

const run = (id: string, value: number | null, extra: ExplorationRow = {}): ExplorationRow => ({
  run: id, condition: 'condition-a', param_model: 'model-a', state: 'completed',
  result_equality: value, seed: 1, param_max_rounds: 0, param_embedder: 'mxbai', ...extra,
});
test('sample sizes exclude failures and missing outcomes without converting missing values to zero', () => {
  const { groups, points } = prepareFigure([
    run('zero', 0), run('one', 1), run('missing', null), run('failed', .9, { state: 'failed' }),
  ], 'result_equality');
  assert.equal(points.length, 2);
  assert.deepEqual(groups[0], { model: 'model-a', condition: 'condition-a', n: 2, total: 4,
    seeds: 1, missing: 1, incomplete: 1, minimum: 0, maximum: 1, median: .5, q1: .25, q3: .75 });
});
test('different recorded conditions for the same model remain separate', () => {
  const { groups, points } = prepareFigure([run('a', 0), run('b', 1, { condition: 'condition-b' })], 'result_equality');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.n), [1, 1]);
  assert.notEqual(points[0]!.model_label, points[1]!.model_label);
});
test('every identical observation gets a distinct, deterministic position', () => {
  const rows = Array.from({ length: 10 }, (_, index) => run(String(index), 1));
  const first = prepareFigure(rows, 'result_equality');
  const reversed = prepareFigure([...rows].reverse(), 'result_equality');
  assert.equal(new Set(first.points.map(point => point.jitter)).size, 10);
  assert.deepEqual(first.points, reversed.points);
  assert.equal(first.groups[0]!.median, 1);
});
test('quartiles handle empty, singleton, and even-sized samples', () => {
  assert.equal(quantile([], .5), null);
  assert.equal(quantile([4], .25), 4);
  assert.equal(quantile([0, 2, 4, 6], .25), 1.5);
});
test('run length and embedder filters apply exact values', () => {
  const filters = { scenario: 'fish', treatment: 'baseline_concurrent', rounds: '0', embedder: 'mxbai' };
  assert.equal(matchesSettings(run('a', 1), filters), true);
  assert.equal(matchesSettings(run('a', 1, { param_max_rounds: 1 }), filters), false);
  assert.equal(matchesSettings(run('a', 1, { param_embedder: 'hash' }), filters), false);
});
