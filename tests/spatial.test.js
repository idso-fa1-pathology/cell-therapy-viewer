import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildPointSpatialIndex, queryPointSpatialIndex } from '../src/spatial-index.js';
import { getPointProjection, getProjectionImageBounds } from '../src/projection.js';

test('detailed queries return every visible point and no offscreen points', () => {
  const points = new Float32Array(100_000 * 3);
  for (let i = 0; i < points.length / 3; i++) {
    points[i * 3] = (i * 7919) % 22970;
    points[i * 3 + 1] = (i * 4861) % 30170;
  }
  const index = buildPointSpatialIndex(points);
  const bounds = { minX: 7000, minY: 10000, maxX: 8500, maxY: 12000 };
  const expected = [];
  for (let i = 0; i < points.length / 3; i++) {
    if (points[i * 3] >= bounds.minX && points[i * 3] <= bounds.maxX
      && points[i * 3 + 1] >= bounds.minY && points[i * 3 + 1] <= bounds.maxY) expected.push(i);
  }
  const result = queryPointSpatialIndex(index, points, bounds);
  assert.deepEqual(Array.from(result.indices).sort((a, b) => a - b), expected);
  assert.equal(result.sampled, false);
});

test('one million points remain bounded; an isolated point beside a dense cluster survives', () => {
  const points = new Float32Array(1_000_001 * 3);
  points.set([10, 10, 1], 1_000_000 * 3);
  const index = buildPointSpatialIndex(points);
  const sparse = queryPointSpatialIndex(index, points, { minX: 9, minY: 9, maxX: 11, maxY: 11 }, { limit: 1000 });
  assert.deepEqual([...sparse.indices], [1_000_000]);
  const times = [];
  for (let iteration = 0; iteration < 100; iteration++) {
    const start = performance.now();
    const result = queryPointSpatialIndex(index, points, { minX: -1, minY: -1, maxX: 11, maxY: 11 }, { limit: 15000 });
    times.push(performance.now() - start);
    assert.ok(result.count <= 15000);
    assert.ok(result.tested <= 15001);
  }
  console.log(`Million-point coincident overview query p95: ${times.sort((a,b) => a-b)[94].toFixed(2)} ms`);
});

test('affine projection and viewport culling stay registered through zoom, pan, rotation, and DPR-independent CSS coordinates', () => {
  for (const scale of [.01, .3, 1, 4]) {
    for (const angle of [0, .4, Math.PI / 2]) {
      const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
      const map = ({ x, y }) => ({ x: -3100 + x * c - y * s, y: 700 + x * s + y * c });
      const p = getPointProjection(map, 720, 800);
      const source = { x: 19645.125, y: 28000.5 };
      const exact = map(source);
      const x = source.x - p.anchorX, y = source.y - p.anchorY;
      assert.ok(Math.abs(360 + x * p.xx + y * p.yx - exact.x) < 1e-6);
      assert.ok(Math.abs(400 + x * p.xy + y * p.yy - exact.y) < 1e-6);
      const bounds = getProjectionImageBounds(p, 720, 800);
      assert.ok(p.anchorX >= bounds.minX && p.anchorX <= bounds.maxX);
      assert.ok(p.anchorY >= bounds.minY && p.anchorY <= bounds.maxY);
    }
  }
});
