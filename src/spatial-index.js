// Adapted from Polyscope. MIT © 2026 UT MD Anderson IDSO-FA1-Pathology.
// See THIRD_PARTY_NOTICES.txt.
const MAX_GRID_DIMENSION = 128;
const POINTS_PER_CELL = 64;
const MAX_LEAF_POINTS = 256;
const NODE_STRIDE = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// A compact counting-sort grid. Build this once in the import worker and
// transfer its two arrays with the point buffer; no class instances are needed.
export function buildPointSpatialIndex(data, count = Math.floor(data.length / 3)) {
  count = clamp(Math.floor(count), 0, Math.floor(data.length / 3));
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let validCount = 0;
  for (let i = 0; i < count; i += 1) {
    const x = data[i * 3];
    const y = data[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    validCount += 1;
  }
  if (!validCount) return {
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    columns: 1, rows: 1, offsets: new Uint32Array(2), indices: new Uint32Array(0), count: 0,
  };
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const cells = Math.max(1, Math.ceil(validCount / POINTS_PER_CELL));
  const columns = clamp(Math.ceil(Math.sqrt(cells * width / height)), 1, MAX_GRID_DIMENSION);
  const rows = clamp(Math.ceil(cells / columns), 1, MAX_GRID_DIMENSION);
  const cellOf = (x, y) => (
    clamp(Math.floor((y - bounds.minY) / height * rows), 0, rows - 1) * columns
    + clamp(Math.floor((x - bounds.minX) / width * columns), 0, columns - 1)
  );
  const offsets = new Uint32Array(columns * rows + 1);
  for (let i = 0; i < count; i += 1) {
    const x = data[i * 3];
    const y = data[i * 3 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) offsets[cellOf(x, y) + 1] += 1;
  }
  for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1];
  const cursors = offsets.slice(0, -1);
  const indices = new Uint32Array(validCount);
  for (let i = 0; i < count; i += 1) {
    const x = data[i * 3];
    const y = data[i * 3 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) indices[cursors[cellOf(x, y)]++] = i;
  }
  // Refine only crowded grid cells. Actual child bounds distinguish an
  // isolated visible point from a nearby dense cluster in the same base cell.
  // Coincident points terminate immediately regardless of their population.
  const roots = new Int32Array(columns * rows).fill(-1);
  const nodeValues = [];
  let scratch = new Uint32Array(0);
  const reserveNode = () => {
    const id = nodeValues.length / NODE_STRIDE;
    nodeValues.push(0, 0, 0, 0, -1, 0, 0, 0);
    return id;
  };
  const refine = (start, end, id) => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let slot = start; slot < end; slot += 1) {
      const point = indices[slot] * 3;
      minX = Math.min(minX, data[point]); maxX = Math.max(maxX, data[point]);
      minY = Math.min(minY, data[point + 1]); maxY = Math.max(maxY, data[point + 1]);
    }
    const node = id * NODE_STRIDE;
    nodeValues[node] = minX; nodeValues[node + 1] = minY;
    nodeValues[node + 2] = maxX; nodeValues[node + 3] = maxY;
    nodeValues[node + 6] = start; nodeValues[node + 7] = end;
    if (end - start <= MAX_LEAF_POINTS || (minX === maxX && minY === maxY)) return;
    const midX = minX + (maxX - minX) / 2;
    const midY = minY + (maxY - minY) / 2;
    const quadrantOf = (point) => (data[point] >= midX ? 1 : 0) + (data[point + 1] >= midY ? 2 : 0);
    const counts = [0, 0, 0, 0];
    for (let slot = start; slot < end; slot += 1) counts[quadrantOf(indices[slot] * 3)] += 1;
    const childCount = counts.filter(Boolean).length;
    // Defensive precision guard: subdivision must shrink the source range.
    if (childCount < 2) return;
    const starts = [0, counts[0], counts[0] + counts[1], counts[0] + counts[1] + counts[2]];
    const positions = [...starts];
    if (scratch.length < end - start) scratch = new Uint32Array(end - start);
    for (let slot = start; slot < end; slot += 1) {
      const point = indices[slot];
      scratch[positions[quadrantOf(point * 3)]++] = point;
    }
    indices.set(scratch.subarray(0, end - start), start);
    const children = [];
    for (let quadrant = 0; quadrant < 4; quadrant += 1) {
      if (counts[quadrant]) children.push({ id: reserveNode(), start: start + starts[quadrant], count: counts[quadrant] });
    }
    nodeValues[node + 4] = children[0].id;
    nodeValues[node + 5] = childCount;
    for (const child of children) refine(child.start, child.start + child.count, child.id);
  };
  for (let cell = 0; cell < roots.length; cell += 1) {
    if (offsets[cell + 1] - offsets[cell] <= MAX_LEAF_POINTS) continue;
    roots[cell] = reserveNode();
    refine(offsets[cell], offsets[cell + 1], roots[cell]);
  }
  return { bounds, columns, rows, offsets, indices, count: validCount,
    roots, nodes: new Float64Array(nodeValues) };
}

function cellPhase(cell) {
  let hash = Math.imul(cell + 1, 0x9e3779b1);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

// Work is bounded by intersecting cells + the draw budget, including for a
// million coincident points. Fixed cell phases and power-of-two strides keep
// samples stable during pan and nested as detail increases. Source data stays
// intact and sparse views return every visible point.
export function queryPointSpatialIndex(index, data, bounds, { limit = 50_000, output, workspace } = {}) {
  const capacity = Math.max(0, Math.floor(Math.min(limit, output?.length ?? limit)));
  const selected = output || new Uint32Array(capacity);
  const empty = () => ({ indices: selected.subarray(0, 0), count: 0, candidates: 0, tested: 0, sampled: false, stride: 1 });
  if (!index?.count || !capacity || !bounds
    || bounds.maxX < index.bounds.minX || bounds.minX > index.bounds.maxX
    || bounds.maxY < index.bounds.minY || bounds.minY > index.bounds.maxY) return empty();
  const { columns, rows, offsets, indices } = index;
  const width = Math.max(index.bounds.maxX - index.bounds.minX, 1);
  const height = Math.max(index.bounds.maxY - index.bounds.minY, 1);
  const minColumn = clamp(Math.floor((bounds.minX - index.bounds.minX) / width * columns), 0, columns - 1);
  const maxColumn = clamp(Math.floor((bounds.maxX - index.bounds.minX) / width * columns), 0, columns - 1);
  const minRow = clamp(Math.floor((bounds.minY - index.bounds.minY) / height * rows), 0, rows - 1);
  const maxRow = clamp(Math.floor((bounds.maxY - index.bounds.minY) / height * rows), 0, rows - 1);
  // The renderer supplies reusable traversal storage. Standalone callers can
  // omit it; no dataset-sized work arrays are created on each viewport event.
  const ranges = workspace?.ranges || [];
  const stack = workspace?.stack || [];
  let rangeLength = 0;
  let stackLength = 0;
  const appendRange = (start, end, phase) => {
    ranges[rangeLength++] = start;
    ranges[rangeLength++] = end;
    ranges[rangeLength++] = phase;
  };
  let candidates = 0;
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const cell = row * columns + column;
      if (!index.roots || index.roots[cell] < 0) {
        const start = offsets[cell]; const end = offsets[cell + 1];
        if (end > start) {
          candidates += end - start;
          appendRange(start, end, cell);
        }
        continue;
      }
      stack[stackLength++] = index.roots[cell];
      while (stackLength) {
        const id = stack[--stackLength];
        const node = id * NODE_STRIDE;
        const nodes = index.nodes;
        if (nodes[node + 2] < bounds.minX || nodes[node] > bounds.maxX
          || nodes[node + 3] < bounds.minY || nodes[node + 1] > bounds.maxY) continue;
        const firstChild = nodes[node + 4];
        const childCount = nodes[node + 5];
        if (childCount) {
          for (let child = childCount - 1; child >= 0; child -= 1) stack[stackLength++] = firstChild + child;
        } else {
          const start = nodes[node + 6]; const end = nodes[node + 7];
          candidates += end - start;
          appendRange(start, end, columns * rows + id);
        }
      }
    }
  }
  const stride = 2 ** Math.max(0, Math.ceil(Math.log2(candidates / capacity)));
  let count = 0;
  let tested = 0;
  for (let range = 0; range < rangeLength; range += 3) {
      const phase = cellPhase(ranges[range + 2]) % stride;
      for (let slot = ranges[range] + phase; slot < ranges[range + 1]; slot += stride) {
        const id = indices[slot];
        const x = data[id * 3];
        const y = data[id * 3 + 1];
        tested += 1;
        if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
        selected[count++] = id;
        if (count === capacity) return { indices: selected.subarray(0, count), count, candidates, tested, sampled: candidates > capacity, stride };
      }
  }
  return { indices: selected.subarray(0, count), count, candidates, tested, sampled: stride > 1, stride };
}
