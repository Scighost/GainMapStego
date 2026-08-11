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
  out.getContext('2d', { willReadFrequently: true }).drawImage(glCanvas, 0, 0);
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

  const { gl, canvas, reconstruct } = getGLState();
  canvas.width  = width;
  canvas.height = height;

  useProgram(gl, reconstruct);

  const texBase = uploadCanvasTexture(gl, baseCanvas, 0);
  const texGain = uploadCanvasTexture(gl, gainSrc,    1);

  gl.uniform1i(gl.getUniformLocation(reconstruct.prog, 'u_base'),      0);
  gl.uniform1i(gl.getUniformLocation(reconstruct.prog, 'u_gainmap'),   1);
  gl.uniform3fv(gl.getUniformLocation(reconstruct.prog, 'u_gamma'),     new Float32Array(metadata.gamma));
  gl.uniform3fv(gl.getUniformLocation(reconstruct.prog, 'u_minBoost'),  new Float32Array(metadata.minContentBoost));
  gl.uniform3fv(gl.getUniformLocation(reconstruct.prog, 'u_maxBoost'),  new Float32Array(metadata.maxContentBoost));
  gl.uniform3fv(gl.getUniformLocation(reconstruct.prog, 'u_offsetSdr'), new Float32Array(metadata.offsetSdr ?? [0, 0, 0]));
  gl.uniform3fv(gl.getUniformLocation(reconstruct.prog, 'u_offsetHdr'), new Float32Array(metadata.offsetHdr ?? [0, 0, 0]));

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.deleteTexture(texBase);
  gl.deleteTexture(texGain);

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

// ── WebGL 单例 ────────────────────────────────────────────────────────────────
// 每次调用都新建 context + 编译链接 shader 开销大，且浏览器对活动 context
// 数量有限制（约 8–16 个），连续多次合成可能创建失败而静默回退 CPU。
// 因此模块级缓存一个 context、三个 program 和各自的四边形 VBO，多次调用复用。

let _glState = null;

function getGLState() {
  if (_glState) return _glState;
  const canvas = document.createElement('canvas');
  canvas.width  = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl', {
    premultipliedAlpha:  false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!gl) throw new Error('WebGL not available');

  const mk = (fsSrc) => {
    const prog = createProgram(gl, fsSrc);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, 'a_pos');
    return { prog, vbo, loc };
  };

  _glState = {
    gl,
    canvas,
    reconstruct: mk(FS_RECONSTRUCT),
    gain1:       mk(FS_GAIN_PASS1),
    gain2:       mk(FS_GAIN_PASS2),
  };
  return _glState;
}

/** 切换到指定 program 并绑定其四边形缓冲/属性 */
function useProgram(gl, p) {
  gl.useProgram(p.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, p.vbo);
  gl.enableVertexAttribArray(p.loc);
  gl.vertexAttribPointer(p.loc, 2, gl.FLOAT, false, 0, 0);
}

/**
 * GPU 版 buildGainMap。
 * 需要 OES_texture_float + WEBGL_color_buffer_float 扩展；
 * 不满足时抛出异常，调用方可回退至 CPU 版本。
 */
export function buildGainMapGL({ baseCanvas, alternateCanvas, gamma = 1, offset = 1 }) {
  const width  = baseCanvas.width;
  const height = baseCanvas.height;

  const { gl, canvas: glCanvas, gain1, gain2 } = getGLState();
  glCanvas.width  = width;
  glCanvas.height = height;

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

  useProgram(gl, gain1);
  const texBase = uploadCanvasTexture(gl, baseCanvas,      0);
  const texAlt  = uploadCanvasTexture(gl, alternateCanvas, 1);
  gl.uniform1i(gl.getUniformLocation(gain1.prog, 'u_base'),   0);
  gl.uniform1i(gl.getUniformLocation(gain1.prog, 'u_alt'),    1);
  gl.uniform1f(gl.getUniformLocation(gain1.prog, 'u_offset'), offset);

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // ── CPU：从 GPU 读回浮点像素，仅做 min/max 扫描（无超越函数）───────────────
  // 注意：曾尝试 GPU 端 2×2 逐级归约后只读回 1 像素，但 float FBO 的小尺寸
  // readPixels 在部分驱动上会返回错误值，导致 min/max 元数据错误、解码为两图
  // 叠加。全尺寸读回 + JS 扫描在各大驱动上稳定，故保留此实现。
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

  useProgram(gl, gain2);

  // floatTex 绑定到纹理单元 2（避免覆盖 0/1 处的输入纹理）
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, floatTex);

  gl.uniform1i(gl.getUniformLocation(gain2.prog, 'u_logmap'), 2);
  gl.uniform3fv(gl.getUniformLocation(gain2.prog, 'u_logMin'), new Float32Array(logMin));
  gl.uniform3fv(gl.getUniformLocation(gain2.prog, 'u_logMax'), new Float32Array(logMax));
  gl.uniform1f(gl.getUniformLocation(gain2.prog, 'u_gamma'),  gamma);

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.deleteTexture(texBase);
  gl.deleteTexture(texAlt);
  gl.deleteTexture(floatTex);
  gl.deleteFramebuffer(fbo);

  return {
    gainMapCanvas:    glToCanvas(glCanvas, width, height),
    minContentBoost:  logMin.map(Math.exp),
    maxContentBoost:  logMax.map(Math.exp),
  };
}
