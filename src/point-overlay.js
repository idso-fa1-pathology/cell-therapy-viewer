import { getPointProjection, getProjectionImageBounds } from './projection.js';
import { queryPointSpatialIndex } from './spatial-index.js';

const MAX_POINTS = 50_000;
const VERTEX = `
precision highp float;
attribute vec3 a_point;
attribute vec4 a_color;
uniform vec2 u_viewport;
uniform vec2 u_anchor;
uniform vec4 u_basis;
uniform float u_size;
varying vec4 v_color;
void main() {
  vec2 offset = a_point.xy - u_anchor;
  vec2 pixel = u_viewport / 2.0 + vec2(
    offset.x * u_basis.x + offset.y * u_basis.z,
    offset.x * u_basis.y + offset.y * u_basis.w);
  gl_Position = vec4(pixel.x / u_viewport.x * 2.0 - 1.0,
    1.0 - pixel.y / u_viewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = u_size;
  v_color = a_color;
}`;
const FRAGMENT = `
precision mediump float;
varying vec4 v_color;
uniform float u_opacity;
void main() {
  float radius = length(gl_PointCoord - vec2(0.5));
  if (radius > 0.5) discard;
  float alpha = (1.0 - smoothstep(0.38, 0.5, radius)) * u_opacity;
  gl_FragColor = vec4(v_color.rgb * alpha, alpha);
}`;

function shader(gl, type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    throw new Error(message);
  }
  return result;
}

function gpuRenderer(canvas, points, colors) {
  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, premultipliedAlpha: true,
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  if (!gl || !gl.getExtension('OES_element_index_uint')) return null;
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new Error('Could not initialize annotation rendering.');
  }
  gl.useProgram(program);
  const buffers = [];
  let colorBuffer;
  for (const [name, data, size, type, normalized] of [
    ['a_point', points, 3, gl.FLOAT, false],
    ['a_color', colors, 4, gl.UNSIGNED_BYTE, true],
  ]) {
    const buffer = gl.createBuffer();
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, name === 'a_color' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    if (name === 'a_color') colorBuffer = buffer;
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, type, normalized, 0, 0);
  }
  const elements = gl.createBuffer();
  buffers.push(elements);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, MAX_POINTS * 4, gl.DYNAMIC_DRAW);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const uniform = Object.fromEntries(['viewport', 'anchor', 'basis', 'size', 'opacity']
    .map(name => [name, gl.getUniformLocation(program, `u_${name}`)]));
  const maximumSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  return { gl, program, buffers, colorBuffer, uniform, maximumSize };
}

export class PointOverlay {
  constructor(viewer, payload, dimensions, onStats) {
    this.viewer = viewer;
    this.points = payload.points;
    this.colors = payload.colors;
    this.index = payload.index;
    this.dimensions = dimensions;
    this.onStats = onStats;
    this.visible = true;
    this.opacity = .75;
    this.sizeMultiplier = 1;
    this.selection = new Uint32Array(MAX_POINTS);
    this.workspace = { ranges: [], stack: [] };
    this.canvas = this.makeCanvas();
    try { this.gpu = gpuRenderer(this.canvas, this.points, this.colors); }
    catch { this.gpu = null; }
    if (!this.gpu) this.useCanvas();
    this.onContextLost = event => {
      event.preventDefault();
      // The source and index stay intact. Switch immediately to bounded Canvas.
      this.gpu = null;
      this.useCanvas();
      this.draw();
    };
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.draw = this.draw.bind(this);
    viewer.addHandler('update-viewport', this.draw);
    viewer.addHandler('open', this.draw);
    this.resize = new ResizeObserver(this.draw);
    this.resize.observe(viewer.element);
    this.draw();
  }

  makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.className = 'point-overlay';
    canvas.setAttribute('aria-hidden', 'true');
    this.viewer.element.append(canvas);
    return canvas;
  }

  useCanvas() {
    this.canvas.remove();
    this.canvas = this.makeCanvas();
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.context) throw new Error('This browser cannot draw the annotation overlay.');
  }

  setVisibility(visible) { this.visible = visible; this.draw(); }
  setOpacity(value) { this.opacity = value; this.draw(); }

  setSizeMultiplier(value) {
    this.sizeMultiplier = Math.min(3, Math.max(.5, value));
    this.draw();
  }

  setClassColors(palette) {
    // Update styles only when the user changes a color. Coordinates and the
    // spatial index stay intact, and navigation keeps using the same buffers.
    for (let id = 0; id < this.points.length / 3; id++) {
      const color = palette[this.points[id * 3 + 2]];
      const offset = id * 4;
      this.colors[offset] = color[0];
      this.colors[offset + 1] = color[1];
      this.colors[offset + 2] = color[2];
    }
    if (this.gpu) {
      const { gl, colorBuffer } = this.gpu;
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colors);
    }
    this.draw();
  }

  draw() {
    this.canvas.hidden = !this.visible || !this.opacity;
    if (this.canvas.hidden) {
      this.onStats({ hidden: true });
      return;
    }
    const started = performance.now();
    const item = this.viewer.world.getItemAt(0);
    const width = this.viewer.element.clientWidth;
    const height = this.viewer.element.clientHeight;
    if (!item || !width || !height) return;
    const projection = getPointProjection(
      point => this.viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(point.x, point.y, true), true),
      width, height,
    );
    if (!projection) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    const scale = projection.imageScale;
    const radius = Math.min(3.5, Math.max(.7, 5 * scale)) * this.sizeMultiplier;
    const bounds = getProjectionImageBounds(projection, width, height, Math.ceil(radius + 1));
    bounds.minX = Math.max(0, bounds.minX);
    bounds.minY = Math.max(0, bounds.minY);
    bounds.maxX = Math.min(this.dimensions.width - 1e-6, bounds.maxX);
    bounds.maxY = Math.min(this.dimensions.height - 1e-6, bounds.maxY);
    const limit = this.gpu
      ? (scale < .08 ? 15_000 : scale < .3 ? 30_000 : MAX_POINTS)
      : (scale < .08 ? 1_000 : scale < .3 ? 3_000 : 10_000);
    const result = queryPointSpatialIndex(this.index, this.points, bounds,
      { limit, output: this.selection, workspace: this.workspace });
    if (this.gpu) this.drawGpu(projection, result.indices, width, height, dpr, radius);
    else this.drawCanvas(projection, result.indices, width, height, dpr, radius);
    this.onStats({
      count: result.count, sampled: result.sampled, hidden: false,
      renderer: this.gpu ? 'WebGL' : 'Canvas', drawMs: performance.now() - started,
    });
  }

  drawGpu(p, indices, width, height, dpr, radius) {
    const { gl, uniform, maximumSize } = this.gpu;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uniform.viewport, width, height);
    gl.uniform2f(uniform.anchor, p.anchorX, p.anchorY);
    gl.uniform4f(uniform.basis, p.xx, p.xy, p.yx, p.yy);
    gl.uniform1f(uniform.size, Math.min(maximumSize, radius * 2 * dpr));
    gl.uniform1f(uniform.opacity, this.opacity);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices);
    const left = Math.max(0, Math.floor(p.originX * dpr));
    const top = Math.max(0, Math.floor(p.originY * dpr));
    const right = Math.min(this.canvas.width, Math.ceil((p.originX + this.dimensions.width * p.xx) * dpr));
    const bottom = Math.min(this.canvas.height, Math.ceil((p.originY + this.dimensions.height * p.yy) * dpr));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(left, this.canvas.height - bottom, Math.max(0, right - left), Math.max(0, bottom - top));
    gl.drawElements(gl.POINTS, indices.length, gl.UNSIGNED_INT, 0);
    gl.disable(gl.SCISSOR_TEST);
  }

  drawCanvas(p, indices, width, height, dpr, radius) {
    const ctx = this.context;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = this.opacity;
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.originX, p.originY, this.dimensions.width * p.xx, this.dimensions.height * p.yy);
    ctx.clip();
    // Tiny bounded batches also behave well with software graphics drivers.
    let previous = -1, batch = 0;
    ctx.beginPath();
    for (const id of indices) {
      const color = this.points[id * 3 + 2];
      if (previous !== color || batch === 128) {
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = `rgb(${this.colors[id * 4]},${this.colors[id * 4 + 1]},${this.colors[id * 4 + 2]})`;
        previous = color;
        batch = 0;
      }
      const x = this.points[id * 3] - p.anchorX;
      const y = this.points[id * 3 + 1] - p.anchorY;
      const screenX = width / 2 + x * p.xx + y * p.yx;
      const screenY = height / 2 + x * p.xy + y * p.yy;
      ctx.moveTo(screenX + radius, screenY);
      ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
      batch++;
    }
    ctx.fill();
    ctx.restore();
  }

  destroy() {
    this.viewer.removeHandler('update-viewport', this.draw);
    this.viewer.removeHandler('open', this.draw);
    this.resize.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    if (this.gpu) {
      for (const buffer of this.gpu.buffers) this.gpu.gl.deleteBuffer(buffer);
      this.gpu.gl.deleteProgram(this.gpu.program);
    }
    this.canvas.remove();
    this.points = this.colors = this.index = null;
  }
}
