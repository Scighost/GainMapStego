/**
 * 三图合一 pivot 预览组件，解码页/首页/合成页共用，保证 tab 切换行为一致。
 * 切换为横向滑动动画（transform 位移）：面板绝对定位横排，位移由本模块统一写入；
 * 移动端拖动跟手——手指按住左右拖动时面板跟随移动，松手后吸附到相邻 tab 或弹回原位。
 *
 * @param {object} options
 * @param {string[]} options.order      tab 标识数组，如 ['alt','base','gainmap']
 * @param {Record<string, HTMLButtonElement>} options.buttons  tab 按钮
 * @param {Record<string, HTMLElement>} options.panels        图片面板（.pivot-panel）
 * @param {Record<string, string>} options.labels             显示名（用于占位文案与保存 title）
 * @param {HTMLElement} [options.dimsEl]           当前 tab 尺寸显示元素（可选）
 * @param {HTMLElement} [options.placeholderEl]    占位文案元素（可选）
 * @param {HTMLButtonElement} [options.saveBtn]    保存按钮，title 随 tab 更新（可选）
 */
export function createPivot({ order, buttons, panels, labels, dimsEl, placeholderEl, saveBtn }) {
  const dims = {};
  order.forEach(k => { dims[k] = ''; });
  let current = order[0];

  /** 面板容器（.img-wrap），拖动与位移作用在其子面板上 */
  const wrap = panels[order[0]].closest('.img-wrap');

  /**
   * 写入全部面板位移：第 pi 块相对当前块 (current) 偏移 (pi-i)*100%，
   * 拖动时追加 dx（px）。animate=false 时关掉 transition 实现跟手。
   */
  function applyTransforms(dx, animate) {
    const i = order.indexOf(current);
    order.forEach((k, pi) => {
      const panel = panels[k];
      panel.style.transition = animate ? '' : 'none';
      panel.style.transform = `translateX(calc(${(pi - i) * 100}% + ${dx}px))`;
    });
  }

  function switchTab(name) {
    if (!order.includes(name)) return;
    current = name;
    order.forEach(k => {
      const on  = k === name;
      buttons[k].classList.toggle('active', on);
      buttons[k].setAttribute('aria-selected', String(on));
      buttons[k].tabIndex = on ? 0 : -1;
    });
    applyTransforms(0, true);
    if (dimsEl) dimsEl.textContent = dims[current];
    if (placeholderEl) placeholderEl.textContent = `${labels[current]}将显示在此`;
    if (saveBtn) saveBtn.title = `保存${labels[current]}`;
  }

  order.forEach(k => buttons[k].addEventListener('click', () => switchTab(k)));

  // 左右方向键切换 tab（与滑动方向一致：→ 下一个，← 上一个）
  buttons[order[0]].closest('.result-toolbar')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const visible = order.filter(k => buttons[k].style.display !== 'none');
    const idx = visible.indexOf(current);
    const next = visible[(idx + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
    switchTab(next);
    buttons[next].focus();
  });

  // ── 跟手滑动：Pointer Events 拖动面板，松手后吸附或弹回 ──
  if (wrap) {
    // 只允许切换到"可见且有内容"的相邻 tab；否则不跟手（限制该方向拖动）
    const hasContent = k => panels[k].hasAttribute('src') && panels[k].getAttribute('src') !== '';
    const neighbor = (dir) => {
      const v = order.filter(k => buttons[k].style.display !== 'none' && hasContent(k));
      return v[v.indexOf(current) + dir] ?? null;
    };

    let start = null;       // pointerdown 坐标
    let dragging = false;
    let canNext = false;
    let canPrev = false;
    let suppressClick = false;
    let suppressTimer = null;

    // 阻止浏览器原生的图片拖拽（与 pointer 拖动冲突）
    wrap.addEventListener('dragstart', (e) => e.preventDefault());

    wrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      dragging = false;
      suppressClick = false;
      canNext = !!neighbor(+1);
      canPrev = !!neighbor(-1);
      // 注意：不能在 pointerdown 就 setPointerCapture —— 指针捕获会把随后的
      // click 重定向到 wrap，导致图片自身的点击（灯箱放大）失效。
      // 捕获推迟到确认横向意图后（pointermove 中）。
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging) {
        // 确认横向意图后才接管；纵向留给页面原生滚动
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          dragging = true;
          wrap.classList.add('dragging');
          // 拖动期间捕获指针，保证手指移出容器后仍能收到 move/up
          try { wrap.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        } else if (Math.abs(dy) > 8) {
          start = null; // 纵向滚动，放弃拖动
          return;
        } else {
          return;
        }
      }
      let d = dx;
      if (d < 0 && !canNext) d = 0;
      if (d > 0 && !canPrev) d = 0;
      applyTransforms(d, false);
    });

    const settle = (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      start = null;
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove('dragging');
      // 拖动过就算一次手势，吞掉随后的合成 click（避免误触灯箱等）
      suppressClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressClick = false; }, 400);

      const width = wrap.clientWidth || 1;
      const threshold = Math.max(48, width * 0.2);
      const target = dx < -threshold ? neighbor(+1)
                   : dx >  threshold ? neighbor(-1)
                   : null;
      if (target) switchTab(target);
      else applyTransforms(0, true);
    };
    wrap.addEventListener('pointerup', settle);
    wrap.addEventListener('pointercancel', () => {
      start = null;
      if (dragging) {
        dragging = false;
        wrap.classList.remove('dragging');
        applyTransforms(0, true);
      }
    });

    // capture 阶段拦截拖动后的合成 click
    wrap.addEventListener('click', (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);
  }

  switchTab(order[0]);

  return {
    switchTab,
    setDims: (name, text) => { dims[name] = text; },
    setTabsVisible: (keys) => {
      order.forEach(k => { buttons[k].style.display = keys.includes(k) ? '' : 'none'; });
    },
    get current() { return current; },
  };
}
