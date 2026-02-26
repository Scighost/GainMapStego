/**
 * lightbox.js — 全屏单张图片预览
 *
 * 用法：
 *   import { openLightbox } from './lightbox.js';
 *   openLightbox({ src, label });
 *
 * 交互：
 *   · 点击图片打开 / X 按钮 / ESC / 点击黑色边距 关闭
 *   · 单击 缩放（1x ↔ 2.5x）
 *   · 双击 / 双指点击 缩放（移动端）
 *   · 缩放后拖拽平移
 *   · 下滑关闭
 */

const DOUBLE_TAP_MS  = 280;
const ZOOM_SCALE     = 2.5;   // 双击缩放倍数
const MAX_PINCH_ZOOM = 6;     // 双指缩放最大倍数
const TAP_MOVE_MAX   = 8;     // 超过此像素视为拖拽，不触发单击

let _overlay   = null;
let _slot      = null;
let _img       = null;   // 缓存 img 元素，避免每帧 querySelector
let _zoom      = 1;
let _panX      = 0;
let _panY      = 0;
let _rafPending = false;
let _rafId      = 0;     // cancelAnimationFrame 用
let _tapTimer   = null;  // 单击延迟关闭计时器
let _closedAt   = 0;     // 记录关闭时刻，防止触摸合成 click 穿透重新打开

// ─── DOM ──────────────────────────────────────────────────────────────────────

function ensureDOM() {
  if (_overlay) return;

  const style = document.createElement('style');
  style.textContent = `
    #lb-overlay {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0,0,0,.94);
      display: flex; flex-direction: column;
      align-items: stretch;
      opacity: 0; pointer-events: none;
      transition: opacity .2s ease;
      user-select: none;
    }
    #lb-overlay.lb-open { opacity: 1; pointer-events: all; }

    #lb-top {
      flex-shrink: 0;
      padding: 10px 14px;
      display: flex; align-items: center; justify-content: space-between;
      color: rgba(255,255,255,.75); font-size: .85rem;
      position: relative; z-index: 2;
    }
    #lb-label { pointer-events: none; }

    #lb-close {
      background: none; border: none; cursor: pointer;
      color: rgba(255,255,255,.8); padding: 6px; line-height: 0;
      border-radius: 50%; transition: background .15s;
    }
    #lb-close:hover { background: rgba(255,255,255,.13); }

    #lb-stage {
      flex: 1;
      position: relative;
      overflow: hidden;
      touch-action: none;
      contain: strict;
      display: flex; align-items: center; justify-content: center;
      cursor: zoom-in;
    }
    #lb-stage.zoomed { cursor: grab; }
    #lb-stage.zoomed:active { cursor: grabbing; }
    #lb-stage img {
      max-width: 100%; max-height: 100%;
      object-fit: contain;
      pointer-events: none;
      will-change: transform;
      transform-origin: center center;
      display: block;
      transition: none;
    }
    #lb-stage img.lb-anim { transition: transform .18s ease; }
  `;
  document.head.appendChild(style);

  _overlay = document.createElement('div');
  _overlay.id = 'lb-overlay';
  _overlay.innerHTML = `
    <div id="lb-top">
      <span id="lb-label"></span>
      <button id="lb-close" title="关闭">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div id="lb-stage"><img /></div>
  `;
  document.body.appendChild(_overlay);

  _slot = document.getElementById('lb-stage');
  _img  = _slot.querySelector('img');

  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  _overlay.addEventListener('click', e => { if (e.target === _overlay) closeLightbox(); });
  document.addEventListener('keydown', e => {
    if (!_overlay.classList.contains('lb-open')) return;
    if (e.key === 'Escape') closeLightbox();
  });

  // ── 触摸 ───────────────────────────────────────────────
  // 未放大：单击关闭，双击缩放；放大：拖拽平移，双击还原；双指捏合缩放
  let tx0 = 0, ty0 = 0, txC = 0, tyC = 0, touching = false, lastTapMs = 0;
  let lastTouchEndMs = 0, didDoubleTap = false;
  // 双指状态
  let pinching = false, pinchDist0 = 0, pinchZoom0 = 1;
  let pinchPanX0 = 0, pinchPanY0 = 0, pinchMidX0 = 0, pinchMidY0 = 0;

  _slot.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      // 开始双指捏合
      touching = false;
      pinching = true;
      clearTimeout(_tapTimer); _tapTimer = null;
      _img.classList.remove('lb-anim');
      const t1 = e.touches[0], t2 = e.touches[1];
      pinchDist0  = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      pinchZoom0  = _zoom;
      pinchPanX0  = _panX;
      pinchPanY0  = _panY;
      // 将双指中点转换为以 stage 中心为原点的坐标
      pinchMidX0 = (t1.clientX + t2.clientX) / 2 - _slot.clientWidth  / 2;
      pinchMidY0 = (t1.clientY + t2.clientY) / 2 - _slot.clientHeight / 2;
      return;
    }
    if (e.touches.length > 2) return;
    // 单指
    tx0 = txC = e.touches[0].clientX;
    ty0 = tyC = e.touches[0].clientY;
    touching = true;
    // 已放大时立即去掉动画类，确保后续平移无过渡延迟
    if (_zoom > 1) _img.classList.remove('lb-anim');
    const now = Date.now();
    if (now - lastTapMs < DOUBLE_TAP_MS) {
      // 检测到双击：取消待执行的单击关闭，执行缩放切换
      clearTimeout(_tapTimer); _tapTimer = null;
      didDoubleTap = true;
      toggleZoom();
      lastTapMs = 0;  // 防止三击误判
    } else {
      lastTapMs = now;
    }
  }, { passive: true });

  _slot.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && pinching) {
      // 双指捏合缩放热路径
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist    = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const newZoom = Math.max(1, Math.min(MAX_PINCH_ZOOM, pinchZoom0 * dist / pinchDist0));
      _zoom = newZoom;
      // 保持双指中点不动： panNew = mid - (mid - pan0) * zoomNew / zoom0
      _panX = pinchMidX0 - (pinchMidX0 - pinchPanX0) * newZoom / pinchZoom0;
      _panY = pinchMidY0 - (pinchMidY0 - pinchPanY0) * newZoom / pinchZoom0;
      if (!_rafPending) {
        _rafPending = true;
        _rafId = requestAnimationFrame(() => { _rafPending = false; applyZoom(false); });
      }
      return;
    }
    if (!touching || e.touches.length > 1) return;
    const prevX = txC, prevY = tyC;
    txC = e.touches[0].clientX;
    tyC = e.touches[0].clientY;
    if (_zoom > 1) {
      // 单指平移热路径：只做算术累加，将实际写入延迟到 RAF
      _panX += txC - prevX;
      _panY += tyC - prevY;
      if (!_rafPending) {
        _rafPending = true;
        _rafId = requestAnimationFrame(_writePan);
      }
    }
    // 未放大时不处理
  }, { passive: true });

  _slot.addEventListener('touchend', e => {
    if (pinching) {
      if (e.touches.length < 2) {
        pinching = false;
        if (e.touches.length === 1) {
          // 抬起一根手指后继续单指平移
          tx0 = txC = e.touches[0].clientX;
          ty0 = tyC = e.touches[0].clientY;
          touching = true;
        }
      }
      return;  // 协新结束后不触发单击关闭
    }
    lastTouchEndMs = Date.now();
    if (!touching) return;
    touching = false;
    if (didDoubleTap) { didDoubleTap = false; return; }  // 双击缩放后不触发关闭
    const moved = Math.abs(txC - tx0) > TAP_MOVE_MAX || Math.abs(tyC - ty0) > TAP_MOVE_MAX;
    if (_zoom === 1 && !moved) {
      // 未放大且未移动：延迟后关闭（等待双击第二次触摸）
      _tapTimer = setTimeout(() => { _tapTimer = null; closeLightbox(); }, DOUBLE_TAP_MS);
    }
  });

  // ── 桌面端：单击切换缩放 ────────────────────────────────
  let _clickSuppressed = false;
  _slot.addEventListener('click', e => {
    if (Date.now() - lastTouchEndMs < 500) return;
    if (_clickSuppressed) { _clickSuppressed = false; return; }
    toggleZoom();
  });

  // ── 鼠标拖拽平移 ────────────────────────────────────────
  let mDown = false, mDragged = false, msx = 0, msy = 0, mpx = 0, mpy = 0;
  _slot.addEventListener('mousedown', e => {
    if (_zoom === 1) return;
    mDown = true; mDragged = false;
    msx = e.clientX; msy = e.clientY; mpx = _panX; mpy = _panY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!mDown) return;
    const dx = e.clientX - msx, dy = e.clientY - msy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) mDragged = true;
    _panX = mpx + dx;
    _panY = mpy + dy;
    applyZoom(false);
  });
  window.addEventListener('mouseup', () => {
    if (mDragged) _clickSuppressed = true;
    mDown = false;
  });
}

// ─── 变换工具 ─────────────────────────────────────────────────────────────────

// 平移热路径：仅写一个 style.transform，零类操作，零 style recalc 
// （只有 transform compositor 更新，不会触发 layout 或 paint）
function _writePan() {
  _rafPending = false;
  _img.style.transform = `scale(${_zoom}) translate3d(${_panX/_zoom}px,${_panY/_zoom}px,0)`;
}

// 带动画的缩放变换（只在 toggleZoom / openLightbox 时调用）
function applyZoom(animated) {
  _img.classList.toggle('lb-anim', animated);
  _img.style.transform = `scale(${_zoom}) translate3d(${_panX/_zoom}px,${_panY/_zoom}px,0)`;
  _slot.classList.toggle('zoomed', _zoom > 1);
}

function toggleZoom() {
  _zoom = _zoom === 1 ? ZOOM_SCALE : 1;
  if (_zoom === 1) { _panX = 0; _panY = 0; }
  applyZoom(true);
}

function resetZoom() {
  _zoom = 1; _panX = 0; _panY = 0;
  cancelAnimationFrame(_rafId); _rafPending = false;
  if (_slot) {
    _slot.classList.remove('zoomed');
    if (_img) { _img.classList.remove('lb-anim'); _img.style.transform = ''; }
  }
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/** @param {{ src: string, label?: string }} image */
export function openLightbox(image) {
  ensureDOM();
  if (!image?.src) return;
  // 触摸关闭后浏览器会补发合成 click（约 300ms），拦截穿透导致的重新打开
  if (Date.now() - _closedAt < 400) return;
  resetZoom();

  document.getElementById('lb-label').textContent = image.label ?? '';
  _img.src = image.src;

  _overlay.classList.add('lb-open');
  document.body.style.overflow = 'hidden';
}

export function closeLightbox() {
  if (_tapTimer) { clearTimeout(_tapTimer); _tapTimer = null; }
  _closedAt = Date.now();
  _overlay?.classList.remove('lb-open');
  document.body.style.overflow = '';
  if (_overlay) _overlay.style.background = '';
  resetZoom();
}
