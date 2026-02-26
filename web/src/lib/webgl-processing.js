/**
 * webgl-processing.js
 * GPU-accelerated (WebGL) 版本的增益图编解码。
 * 所有像素级运算（sRGB↔线性、log/exp）均在 fragment shader 中执行。
 *
 * 导出两个函数：
 *   reconstructAlternateFromGainMapGL  – 单 pass，完全 GPU
 *   buildGainMapGL                     – 双 pass GPU + CPU min/max 扫描
 *
 * 若 WebGL 不可用或 OES_texture_float 不支持，会抛出异常，
 * 调用方应捕获并回退至 CPU 版本。
 */

// ── 顶点着色器（所有 pass 共用）─────────────────────────────────────────────
// 输出 -a_pos.y 以修正 WebGL 与 Canvas 的 Y 轴方向差异
const VS = /* glsl */ `
  attribute vec2 a_pos;
  varying   vec2 v_uv;
  void main() {
    v_uv        = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos.x, a_pos.y, 0.0, 1.0);
  }
`;

// ── sRGB ↔ 线性 GLSL 工具函数 ───────────────────────────────────────────────
const GLSL_SRGB = /* glsl */ `
  precision highp float;

  float srgbToLinear(float v) {
    return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
  }
  vec3 srgbToLinearV(vec3 c) {
    return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
  }
  float linearToSrgb(float v) {
    v = clamp(v, 0.0, 1.0);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
  }
  vec3 linearToSrgbV(vec3 c) {
    return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b));
  }
`;

// ── WebGL 工具 ───────────────────────────────────────────────────────────────

function createGLCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl', {
    premultipliedAlpha:  false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!gl) throw new Error('WebGL not available');
  return { gl, canvas };
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(`Shader compile error: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function createProgram(gl, fsSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
  gl.useProgram(prog);
  return prog;
}

/** 创建全屏四边形缓冲并绑定顶点属性 */
function setupQuad(gl, prog) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
    gl.STATIC_DRAW,
  );
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

/**
 * 将 Canvas / OffscreenCanvas 上传为 WebGL 2D 纹理。
 * 设置 UNPACK_FLIP_Y_WEBGL=true，使 UV(0,0) 对应 Canvas 左上角。
 */
function uploadCanvasTexture(gl, source, unit) {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  return tex;
}

/** 将 WebGL Canvas 内容复制到普通 2D Canvas 并返回 */
function glToCanvas(glCanvas, width, height) {
  const out = document.createElement('canvas');
  out.width  = width;
  out.height = height;
  out.getContext('2d').drawImage(glCanvas, 0, 0);
  return out;
}

// ── reconstructAlternateFromGainMap（单 pass，完全 GPU）─────────────────────

const FS_RECONSTRUCT = /* glsl */ `
  ${GLSL_SRGB}
  uniform sampler2D u_base;
  uniform sampler2D u_gainmap;
  uniform vec3 u_gamma;
  uniform vec3 u_minBoost;
  uniform vec3 u_maxBoost;
  uniform vec3 u_offsetSdr;
  uniform vec3 u_offsetHdr;
  varying vec2 v_uv;

  void main() {
    vec3 baseRgb = texture2D(u_base,    v_uv).rgb;
    vec3 g       = texture2D(u_gainmap, v_uv).rgb;

    vec3 bLin  = srgbToLinearV(baseRgb);
    // 还原归一化的 t 值
    vec3 t = vec3(
      pow(g.r, 1.0 / u_gamma.r),
      pow(g.g, 1.0 / u_gamma.g),
      pow(g.b, 1.0 / u_gamma.b)
    );
    vec3 minV  = max(u_minBoost, vec3(1e-6));
    vec3 maxV  = max(u_maxBoost, minV + vec3(1e-6));
    vec3 boost = exp(log(minV) + t * (log(maxV) - log(minV)));
    vec3 aLin  = boost * (bLin + u_offsetSdr) - u_offsetHdr;

    gl_FragColor = vec4(linearToSrgbV(aLin), 1.0);
  }
`;

/**
 * GPU 版 reconstructAlternateFromGainMap。
 * 接口与 CPU 版完全一致，直接替换使用。
 */
export function reconstructAlternateFromGainMapGL({ baseCanvas, gainMapCanvas, metadata }) {
  const width  = baseCanvas.width;
  const height = baseCanvas.height;

  // 若增益图尺寸不匹配，先缩放到基础图尺寸（在 2D Canvas 中完成，避免额外 GL pass）
  let gainSrc = gainMapCanvas;
  if (gainMapCanvas.width !== width || gainMapCanvas.height !== height) {
    gainSrc = document.createElement('canvas');
    gainSrc.width  = width;
    gainSrc.height = height;
    const sctx = gainSrc.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(gainMapCanvas, 0, 0, width, height);
  }

  const { gl, canvas } = createGLCanvas(width, height);
  const prog = createProgram(gl, FS_RECONSTRUCT);
  setupQuad(gl, prog);

  uploadCanvasTexture(gl, baseCanvas, 0);
  uploadCanvasTexture(gl, gainSrc,    1);

  gl.uniform1i(gl.getUniformLocation(prog, 'u_base'),      0);
  gl.uniform1i(gl.getUniformLocation(prog, 'u_gainmap'),   1);
  gl.uniform3fv(gl.getUniformLocation(prog, 'u_gamma'),     new Float32Array(metadata.gamma));
  gl.uniform3fv(gl.getUniformLocation(prog, 'u_minBoost'),  new Float32Array(metadata.minContentBoost));
  gl.uniform3fv(gl.getUniformLocation(prog, 'u_maxBoost'),  new Float32Array(metadata.maxContentBoost));
  gl.uniform3fv(gl.getUniformLocation(prog, 'u_offsetSdr'), new Float32Array(metadata.offsetSdr ?? [0, 0, 0]));
  gl.uniform3fv(gl.getUniformLocation(prog, 'u_offsetHdr'), new Float32Array(metadata.offsetHdr ?? [0, 0, 0]));

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  return glToCanvas(canvas, width, height);
}

// ── buildGainMap（双 pass GPU + CPU min/max 扫描）───────────────────────────

/**
 * Pass 1：计算每像素 log(ratio)，写入浮点纹理（需要 OES_texture_float）。
 * R/G/B 分别存储三个通道的 log 值，A 恒为 1.0。
 */
const FS_GAIN_PASS1 = /* glsl */ `
  ${GLSL_SRGB}
  uniform sampler2D u_base;
  uniform sampler2D u_alt;
  uniform float     u_offset;
  varying vec2 v_uv;

  void main() {
    vec3 bLin = srgbToLinearV(texture2D(u_base, v_uv).rgb);
    vec3 aLin = srgbToLinearV(texture2D(u_alt,  v_uv).rgb);
    vec3 ratio = (aLin + u_offset) / max(bLin + u_offset, vec3(1e-6));
    vec3 logV  = log(max(ratio, vec3(1e-6)));
    gl_FragColor = vec4(logV, 1.0);
  }
`;

/**
 * Pass 2：使用已知的 logMin/logMax 将浮点 log 值归一化并编码为 8-bit 增益图。
 */
const FS_GAIN_PASS2 = /* glsl */ `
  precision highp float;
  uniform sampler2D u_logmap;
  uniform vec3      u_logMin;
  uniform vec3      u_logMax;
  uniform float     u_gamma;
  varying vec2 v_uv;

  void main() {
    vec3 logV  = texture2D(u_logmap, v_uv).rgb;
    vec3 range = max(u_logMax - u_logMin, vec3(1e-6));
    vec3 t     = clamp((logV - u_logMin) / range, 0.0, 1.0);
    vec3 out_c = vec3(pow(t.r, u_gamma), pow(t.g, u_gamma), pow(t.b, u_gamma));
    gl_FragColor = vec4(out_c, 1.0);
  }
`;

/**
 * GPU 版 buildGainMap。
 * 需要 OES_texture_float + WEBGL_color_buffer_float 扩展；
 * 不满足时抛出异常，调用方可回退至 CPU 版本。
 */
export function buildGainMapGL({ baseCanvas, alternateCanvas, gamma = 1, offset = 1 }) {
  const width  = baseCanvas.width;
  const height = baseCanvas.height;

  const { gl, canvas: glCanvas } = createGLCanvas(width, height);

  // 检查浮点纹理 + 浮点 FBO 支持
  const extFloat = gl.getExtension('OES_texture_float');
  const extFBFloat = gl.getExtension('WEBGL_color_buffer_float')
                  || gl.getExtension('EXT_color_buffer_float');
  if (!extFloat || !extFBFloat)
    throw new Error('WebGL float texture not supported; falling back to CPU');

  // ── Pass 1：渲染 log-ratio 到浮点 FBO ───────────────────────────────────
  const floatTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, floatTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, floatTex, 0);
  const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (fbStatus !== gl.FRAMEBUFFER_COMPLETE)
    throw new Error(`Float FBO not complete (status=${fbStatus}); falling back to CPU`);

  const prog1 = createProgram(gl, FS_GAIN_PASS1);
  setupQuad(gl, prog1);
  uploadCanvasTexture(gl, baseCanvas,      0);
  uploadCanvasTexture(gl, alternateCanvas, 1);
  gl.uniform1i(gl.getUniformLocation(prog1, 'u_base'),   0);
  gl.uniform1i(gl.getUniformLocation(prog1, 'u_alt'),    1);
  gl.uniform1f(gl.getUniformLocation(prog1, 'u_offset'), offset);

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ── CPU：从 GPU 读回浮点像素，仅做 min/max 扫描（无超越函数）───────────────
  const floatPixels = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, floatPixels);

  const logMin = [Infinity,  Infinity,  Infinity];
  const logMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < floatPixels.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = floatPixels[i + c];
      if (isFinite(v)) {
        if (v < logMin[c]) logMin[c] = v;
        if (v > logMax[c]) logMax[c] = v;
      }
    }
  }
  // 保证合法范围
  for (let c = 0; c < 3; c++) {
    if (!isFinite(logMin[c])) logMin[c] = -1;
    if (!isFinite(logMax[c]) || logMax[c] <= logMin[c]) logMax[c] = logMin[c] + 0.001;
  }

  // ── Pass 2：归一化 → 8-bit 增益图 ───────────────────────────────────────
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const prog2 = createProgram(gl, FS_GAIN_PASS2);
  setupQuad(gl, prog2);

  // floatTex 绑定到纹理单元 2（避免覆盖 0/1 处的输入纹理）
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, floatTex);

  gl.uniform1i(gl.getUniformLocation(prog2, 'u_logmap'), 2);
  gl.uniform3fv(gl.getUniformLocation(prog2, 'u_logMin'), new Float32Array(logMin));
  gl.uniform3fv(gl.getUniformLocation(prog2, 'u_logMax'), new Float32Array(logMax));
  gl.uniform1f(gl.getUniformLocation(prog2, 'u_gamma'),  gamma);

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  return {
    gainMapCanvas:    glToCanvas(glCanvas, width, height),
    minContentBoost:  logMin.map(Math.exp),
    maxContentBoost:  logMax.map(Math.exp),
  };
}
