'use strict';
/* global widget */
const root = document.getElementById('root');
const KIND_ICON = { mouse: '🖱️', keyboard: '⌨️', headset: '🎧', gamepad: '🎮', phone: '📱', other: '🔋' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function levelClass(level, low) {
  if (level == null) return '';
  if (level <= low) return 'low';
  if (level <= 50) return 'mid';
  return '';
}

function render(d) {
  // Text colour: follow the real background behind the widget, the taskbar theme, or a fixed colour.
  let darkBg = d.dark;
  if (d.textColor === 'background' && d.bgDark != null) darkBg = d.bgDark;
  else if (d.textColor === 'white') darkBg = true;
  else if (d.textColor === 'black') darkBg = false;
  document.body.classList.toggle('light', !darkBg);
  document.body.classList.toggle('outline-thin', d.outline === 'thin');
  document.body.classList.toggle('outline-thick', d.outline === 'thick');
  root.innerHTML = '';
  const t = d.text;

  for (const dev of d.devices) {
    const level = dev.level;
    const cls = levelClass(level, dev.lowThreshold);
    const item = el('div', 'item' + (dev.connected === false ? ' offline' : ''));

    const top = el('div', 'top');
    if (dev.icon) {
      const img = el('img', 'kind-img');
      img.src = dev.icon;
      img.alt = '';
      top.append(img);
    } else {
      top.append(el('span', 'kind', KIND_ICON[dev.kind] || KIND_ICON.other));
    }
    top.append(el('span', 'pct' + (cls === 'low' ? ' low-text' : ''), level == null ? '--' : `${level}%`));
    item.append(top);

    const parts = (dev.components || []).map((c) => `${t.parts[c.key] || c.key}${c.level == null ? '--' : c.level}`);
    if (parts.length) item.append(el('div', 'parts', parts.join(' · ')));
    else if (d.showNames) item.append(el('div', 'name', dev.name));

    const bar = el('div', 'bar');
    const fill = el('div', cls);
    fill.style.width = `${level ?? 0}%`;
    bar.append(fill);
    item.append(bar);

    let tip = `${dev.name}: ${level == null ? '--' : level + '%'}`;
    if (parts.length) tip += `\n${parts.join(' / ')}`;
    if (dev.connected === false) tip += `\n${t.disconnected}`;
    item.title = tip;
    root.append(item);
  }

  if (!d.devices.length && !d.mic.show && !d.audio.show) {
    const item = el('div', 'item empty', '🔋 --');
    item.title = t.noDevices;
    root.append(item);
  }

  if (d.audio.show) {
    const audio = el('div', 'item icon-btn', '🎚️');
    audio.title = t.audio;
    audio.dataset.action = 'audio';
    root.append(audio);
  }

  if (d.mic.show) {
    const mic = el('div', 'item mic' + (d.mic.muted ? ' muted' : ''), d.mic.muted ? '🔇' : '🎙️');
    mic.title = d.mic.muted ? t.micMuted : t.micLive;
    mic.dataset.action = 'mic';
    root.append(mic);
  }
  reportWidth();
}

function reportWidth() {
  requestAnimationFrame(() => widget.reportWidth(root.getBoundingClientRect().width));
}

// Mouse input arrives from the main process (native hook) as coordinates in CSS px.
function hit({ button, x, y }) {
  if (button === 'right') return widget.menu();
  const target = document.elementFromPoint(x, y);
  if (target && target.closest('[data-action="mic"]')) return widget.micClick();
  if (target && target.closest('[data-action="audio"]')) return widget.audioClick();
  widget.click();
}

// Regular DOM events still work when the window isn't embedded (e.g. while debugging).
root.addEventListener('click', (e) => hit({ button: 'left', x: e.clientX, y: e.clientY }));
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  widget.menu();
});
widget.onHit(hit);
new ResizeObserver(reportWidth).observe(root);
widget.onData(render);
