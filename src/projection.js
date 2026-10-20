// Adapted from Polyscope. MIT © 2026 UT MD Anderson IDSO-FA1-Pathology.
// See THIRD_PARTY_NOTICES.txt.
// Derive the current affine transform from the viewer's own image-coordinate
// mapping, once per paint. Works with OSD and Viv, including rotation.
export function getPointProjection(imageToScreen, width, height) {
  const origin = imageToScreen({ x: 0, y: 0 });
  const xBasis = imageToScreen({ x: 1, y: 0 });
  const yBasis = imageToScreen({ x: 0, y: 1 });
  if (![origin, xBasis, yBasis].every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return null;
  const xx = xBasis.x - origin.x;
  const xy = xBasis.y - origin.y;
  const yx = yBasis.x - origin.x;
  const yy = yBasis.y - origin.y;
  const determinant = xx * yy - xy * yx;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-16) return null;
  const centerX = width / 2 - origin.x;
  const centerY = height / 2 - origin.y;
  return {
    originX: origin.x, originY: origin.y, xx, xy, yx, yy, determinant,
    anchorX: (centerX * yy - yx * centerY) / determinant,
    anchorY: (xx * centerY - centerX * xy) / determinant,
    imageScale: (Math.hypot(xx, xy) + Math.hypot(yx, yy)) / 2,
  };
}

export function getProjectionImageBounds(projection, width, height, padding = 0) {
  const { xx, xy, yx, yy, originX, originY, determinant } = projection;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [screenX, screenY] of [
    [-padding, -padding], [width + padding, -padding],
    [width + padding, height + padding], [-padding, height + padding],
  ]) {
    const dx = screenX - originX;
    const dy = screenY - originY;
    const x = (dx * yy - yx * dy) / determinant;
    const y = (xx * dy - dx * xy) / determinant;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}
