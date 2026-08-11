/**
 * 三图合一 pivot 预览组件，解码页与首页共用，保证 tab 切换行为一致。
 * 切换动画由 global.css 的 .pivot-panel.active 负责（display 切换会重放 fade-in-up）。
 *
 * @param {object} options
 * @param {string[]} options.order      tab 标识数组，如 ['alt','base','gainmap']
 * @param {Record<string, HTMLButtonElement>} options.buttons  tab 按钮
 * @param {Record<string, HTMLElement>} options.panels        图片面板（.pivot-panel）
 * @param {Record<string, string>} options.labels             显示名（用于占位文案与保存 title）
 * @param {HTMLElement} options.dimsEl     当前 tab 尺寸显示元素
 * @param {HTMLElement} options.placeholderEl  占位文案元素
 * @param {HTMLButtonElement} options.saveBtn   保存按钮（title 随 tab 更新）
 */
import { attachSwipe } from './utils.js';

export function createPivot({ order, buttons, panels, labels, dimsEl, placeholderEl, saveBtn }) {
  const dims = {};
  order.forEach(k => { dims[k] = ''; });
  let current = order[0];

  function switchTab(name) {
    current = name;
    order.forEach(k => {
      const on  = k === name;
      const btn = buttons[k];
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    order.forEach(k => panels[k].classList.toggle('active', k === name));
    dimsEl.textContent = dims[current];
    placeholderEl.textContent = `${labels[current]}将显示在此`;
    saveBtn.title = `保存${labels[current]}`;
  }

  order.forEach(k => buttons[k].addEventListener('click', () => switchTab(k)));

  // 左右方向键切换 tab
  buttons[order[0]].closest('.result-toolbar')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const visible = order.filter(k => buttons[k].style.display !== 'none');
    const idx = visible.indexOf(current);
    const next = visible[(idx + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
    switchTab(next);
    buttons[next].focus();
  });

  // 移动端：在预览区左右滑动切换 tab（与方向键逻辑一致：左滑=下一个，右滑=上一个）
  const wrap = panels[order[0]].closest('.img-wrap');
  if (wrap) {
    const visibleTabs = () => order.filter(k => buttons[k].style.display !== 'none');
    attachSwipe(wrap, {
      onSwipeLeft: () => {
        const v = visibleTabs();
        const i = v.indexOf(current);
        switchTab(v[(i + 1) % v.length]);
      },
      onSwipeRight: () => {
        const v = visibleTabs();
        const i = v.indexOf(current);
        switchTab(v[(i - 1 + v.length) % v.length]);
      },
    });
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
