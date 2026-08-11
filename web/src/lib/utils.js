export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function fileSizeText(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function imageDataToCanvas(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export async function canvasToJpegBlob(canvas, quality = 95) {
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG 导出失败'))),
      'image/jpeg',
      clamp(quality, 1, 100) / 100,
    );
  });
}

export async function fileToUint8Array(file) {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function blobToImage(blob) {
  const bitmap = await createImageBitmap(blob);
  return bitmap;
}

export function imageBitmapToCanvas(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

export function scrollIntoViewIfNeeded(el) {
  const navH = 52 + 8; // navbar height + padding
  const rect = el.getBoundingClientRect();
  const inView = rect.top >= navH && rect.bottom <= window.innerHeight;
  if (!inView) window.scrollTo({ top: rect.top + window.scrollY - navH, behavior: 'smooth' });
}

/**
 * 为元素附加移动端左右滑动手势（用于图片预览切换 tab）。
 * 达到横向滑动阈值后触发 onSwipeLeft / onSwipeRight，并吞掉随后的合成 click，
 * 避免误触图片自身的点击行为（如打开灯箱）。垂直方向保留页面原生滚动。
 *
 * @param {HTMLElement} el  监听手势的容器（通常为 .img-wrap）
 * @param {object} callbacks
 * @param {() => void} callbacks.onSwipeLeft  向左滑（手指左移 → 下一个）
 * @param {() => void} callbacks.onSwipeRight 向右滑（手指右移 → 上一个）
 * @param {number} [threshold=56] 判定为滑动的最小水平位移（px）
 */
export function attachSwipe(el, { onSwipeLeft, onSwipeRight, threshold = 56 }) {
  if (!el) return () => {};
  // 仅触屏设备需要；纯桌面（无触摸）不会派发触摸事件
  if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return () => {};
  // 横向手势交给 JS 处理，纵向保留原生滚动
  el.style.touchAction = 'pan-y';

  let startX = 0, startY = 0, tracking = false, suppressClick = false, suppressTimer = null;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    suppressClick = false;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    tracking = true;
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      // 确认横向意图后阻止页面随手指滚动
      e.preventDefault();
    }
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
      suppressClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressClick = false; }, 400);
      if (dx < 0) onSwipeLeft?.();
      else onSwipeRight?.();
    }
  }, { passive: true });

  // capture 阶段拦截滑动后的合成 click，避免误触图片点击（灯箱等）
  el.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);
}