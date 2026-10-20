import { buildPointSpatialIndex } from './spatial-index.js';

self.onmessage = async ({ data: { url, bytes, classes } }) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Annotation download failed (${response.status}).`);
    const packed = new Uint8Array(bytes);
    const reader = response.body.getReader();
    let offset = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes) throw new Error('Annotation cache has an unexpected size.');
      packed.set(value, offset);
      offset += value.length;
      self.postMessage({ type: 'progress', value: Math.round(offset / bytes * 100) });
    }
    if (offset !== bytes || bytes % 12) throw new Error('Annotation cache is incomplete.');
    const points = new Float32Array(packed.buffer);
    self.postMessage({ type: 'indexing' });
    const index = buildPointSpatialIndex(points);
    const colors = new Uint8Array(points.length / 3 * 4);
    for (let i = 0; i < points.length / 3; i++) {
      const color = classes[points[i * 3 + 2]]?.color;
      if (!color) throw new Error('Annotation class is missing.');
      colors.set([...color, 255], i * 4);
    }
    self.postMessage({ type: 'ready', points, colors, index }, [
      points.buffer, colors.buffer, index.offsets.buffer, index.indices.buffer,
      index.roots.buffer, index.nodes.buffer,
    ]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
