'use strict';
/* global tp */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let S = null; // latest state from main
let activeTab = 'devices';
const openEditors = new Set();
let audioTimer = null;

const KIND_ICON = { mouse: '🖱️', keyboard: '⌨️', headset: '🎧', gamepad: '🎮', phone: '📱', other: '🔋' };

function t(key, vars = {}) {
  const s = (S && S.dict[key]) ?? key;
  return String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

// <template> contents are not part of the document, so rows cloned from a
// template must be translated separately with translate(clone).
function translate(root) {
  $$('[data-i18n]', root).forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $$('[data-i18n-title]', root).forEach((el) => (el.title = t(el.dataset.i18nTitle)));
}

function applyI18n() {
  translate(document);
  document.documentElement.lang = S.lang;
}

function applyTheme() {
  document.body.classList.toggle('dark', !!S.dark);
  applyAccent(S.settings.accentColor);
}

// ================================================================ accent color
const ACCENT_PRESETS = ['#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#64748b'];
const ACCENT_VARS = ['--accent', '--accent-soft', '--accent-text', '--accent-fg'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function hsvToRgb([h, s, v]) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Applies a custom accent (or the theme default when empty). Text/foreground variants are derived
// so that the color stays readable on the current light/dark background.
function applyAccent(hex) {
  const style = document.body.style;
  const rgb = hexToRgb(hex);
  if (!rgb) {
    ACCENT_VARS.forEach((v) => style.removeProperty(v));
    return;
  }
  const dark = !!S.dark;
  const bg = dark ? [31, 32, 36] : [246, 247, 249];
  const toward = dark ? [255, 255, 255] : [0, 0, 0];
  let text = rgb;
  for (let i = 0; i < 12 && contrast(text, bg) < 4.5; i++) text = text.map((v, k) => v + (toward[k] - v) * 0.15);
  style.setProperty('--accent', rgbToHex(rgb));
  style.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, ${dark ? 0.2 : 0.14})`);
  style.setProperty('--accent-text', rgbToHex(text));
  style.setProperty('--accent-fg', luminance(rgb) > 0.4 ? '#111111' : '#ffffff');
}

let accentRgb = [59, 130, 246];
let accentHue = 217;
const saveAccent = throttle((hex) => tp.setSettings({ accentColor: hex }), 200);

function currentAccentHex() {
  return S.settings.accentColor || (S.dark ? '#60a5fa' : '#3b82f6');
}

// Updates sliders, gradients (the RGB "curves") and labels from accentRgb.
function paintAccentPicker() {
  const [r, g, b] = accentRgb.map(Math.round);
  const set = (id, v) => {
    if (document.activeElement !== $(`#accent-${id}`)) $(`#accent-${id}`).value = v;
    $(`#accent-${id}-num`).textContent = v;
  };
  set('r', r);
  set('g', g);
  set('b', b);
  set('h', Math.round(accentHue));
  $('#accent-r').style.background = `linear-gradient(90deg, rgb(0,${g},${b}), rgb(255,${g},${b}))`;
  $('#accent-g').style.background = `linear-gradient(90deg, rgb(${r},0,${b}), rgb(${r},255,${b}))`;
  $('#accent-b').style.background = `linear-gradient(90deg, rgb(${r},${g},0), rgb(${r},${g},255))`;
  const hex = rgbToHex(accentRgb);
  if (document.activeElement !== $('#accent-hex')) $('#accent-hex').value = hex;
  $$('.swatch').forEach((s) => s.classList.toggle('selected', s.dataset.color === hex && !!S.settings.accentColor));
}

function renderAccentPicker() {
  if ($('.accent-picker').contains(document.activeElement) && document.activeElement.type === 'range') return;
  accentRgb = hexToRgb(currentAccentHex());
  const [h, s] = rgbToHsv(accentRgb);
  if (s > 0.02) accentHue = h;
  paintAccentPicker();
}

function setAccentRgb(rgb, { fromHue = false } = {}) {
  accentRgb = rgb.map((v) => clamp(v, 0, 255));
  if (!fromHue) {
    const [h, s] = rgbToHsv(accentRgb);
    if (s > 0.02) accentHue = h;
  }
  const hex = rgbToHex(accentRgb);
  S.settings.accentColor = hex;
  applyAccent(hex);
  paintAccentPicker();
  saveAccent(hex);
}

function bindAccentPicker() {
  const box = $('#accent-swatches');
  for (const c of ACCENT_PRESETS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', () => setAccentRgb(hexToRgb(c)));
    box.appendChild(b);
  }
  ['r', 'g', 'b'].forEach((ch, i) =>
    $(`#accent-${ch}`).addEventListener('input', (e) => {
      const next = [...accentRgb];
      next[i] = Number(e.target.value);
      setAccentRgb(next);
    })
  );
  $('#accent-h').addEventListener('input', (e) => {
    accentHue = Number(e.target.value);
    let [, s, v] = rgbToHsv(accentRgb);
    if (s < 0.15) s = 0.7; // a grey has no hue: give it some color so the slider does something
    if (v < 0.25) v = 0.85;
    setAccentRgb(hsvToRgb([accentHue, s, v]), { fromHue: true });
  });
  $('#accent-hex').addEventListener('change', (e) => {
    const rgb = hexToRgb(e.target.value);
    if (rgb) setAccentRgb(rgb);
    else e.target.value = rgbToHex(accentRgb);
  });
  $('#accent-reset').addEventListener('click', async () => {
    setState(await tp.setSettings({ accentColor: '' }));
  });
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    pendingArgs = args;
    const now = Date.now();
    const run = () => {
      last = Date.now();
      timer = null;
      fn(...pendingArgs);
    };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
}

function relTime(ts) {
  if (!ts) return '';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return t('time.justNow');
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.minutesAgo', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('time.hoursAgo', { n: h });
  return t('time.daysAgo', { n: Math.round(h / 24) });
}

// ================================================================ tabs
function setTab(name) {
  activeTab = name;
  tp.reportTab(name);
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  clearInterval(audioTimer);
  if (name === 'audio') {
    loadAudio();
    audioTimer = setInterval(() => {
      if (document.hasFocus() && !dragging) loadAudio(true);
    }, 3000);
  }
}

// ================================================================ devices
function levelClass(level, low) {
  if (level == null) return '';
  if (level <= low) return 'low';
  if (level <= 50) return 'mid';
  return '';
}

function renderDevices() {
  const list = $('#device-list');
  list.innerHTML = '';
  if (!S.devices.length) {
    list.innerHTML = `<div class="empty"><div class="big">🔍</div><div>${t('device.none')}</div><p class="hint">${t('device.noneHint')}</p></div>`;
  }
  const tpl = $('#tpl-device');
  S.devices.forEach((d, idx) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    translate(el);
    const level = d.effectiveLevel ?? d.level;
    el.classList.toggle('is-hidden', d.hidden);
    el.classList.toggle('offline', d.connected === false);
    setKindIcon($('.kind', el), d);
    $('.name', el).textContent = d.displayName;
    $('.name', el).title = d.name;
    let status = '';
    if (d.connected === false) status = d.stale ? t('device.lastSeen', { when: relTime(d.lastSeen) }) : t('device.disconnected');
    if (d.hidden) status = t('device.hiddenLabel') + (status ? ` · ${status}` : '');
    $('.status', el).textContent = status;
    const fill = $('.fill', el);
    fill.style.width = `${level ?? 0}%`;
    const cls = levelClass(level, d.lowThreshold);
    if (cls) fill.classList.add(cls);
    const lv = $('.level', el);
    lv.textContent = level == null ? '--' : `${level}%`;
    if (cls === 'low') lv.classList.add('low');

    const parts = $('.parts', el);
    for (const c of d.components || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${t('part.' + c.key)} ${c.level == null ? '--' : c.level + '%'}`;
      parts.appendChild(chip);
    }

    // ---- editor
    const editor = $('.device-edit', el);
    editor.hidden = !openEditors.has(d.id);
    $('.edit', el).addEventListener('click', () => {
      editor.hidden = !editor.hidden;
      if (editor.hidden) openEditors.delete(d.id);
      else openEditors.add(d.id);
    });
    setKindIcon($('.icon-preview', el), d);
    $('.reset-icon', el).hidden = !d.icon;
    $('.choose-icon', el).addEventListener('click', async () => {
      const r = await tp.chooseDeviceIcon(d.id);
      if (r.error) alert(t('device.iconUnsupported'));
      setState(r.state);
    });
    $('.reset-icon', el).addEventListener('click', () => update(d.id, { icon: null }));
    const alias = $('.alias', el);
    alias.value = d.displayName === d.name ? '' : d.displayName;
    alias.placeholder = d.name;
    alias.addEventListener('change', () => update(d.id, { alias: alias.value.trim() || undefined }));
    const low = $('.low', el);
    low.value = d.lowThreshold;
    low.addEventListener('change', () => {
      const v = Math.min(99, Math.max(1, Number(low.value) || 20));
      update(d.id, { lowThreshold: v });
    });
    bindToggle($('.notify-low', el), d.notifyLow, (v) => update(d.id, { notifyLow: v }));
    bindToggle($('.notify-full', el), d.notifyFull, (v) => update(d.id, { notifyFull: v }));
    bindToggle($('.on-taskbar', el), d.showOnTaskbar, (v) => update(d.id, { showOnTaskbar: v }));
    $('.on-taskbar-row', el).hidden = !S.taskbarSupported;
    bindToggle($('.own-tray', el), d.ownTray, (v) => update(d.id, { ownTray: v }));
    bindToggle($('.hidden-toggle', el), d.hidden, (v) => update(d.id, { hidden: v }));
    $('.up', el).disabled = idx === 0;
    $('.down', el).disabled = idx === S.devices.length - 1;
    $('.up', el).addEventListener('click', () => move(idx, -1));
    $('.down', el).addEventListener('click', () => move(idx, 1));
    $('.forget', el).addEventListener('click', async () => {
      if (!confirm(t('device.forgetConfirm', { name: d.displayName }))) return;
      openEditors.delete(d.id);
      setState(await tp.forgetDevice(d.id));
    });
    list.appendChild(el);
  });
  $('#last-poll').textContent = S.lastPoll ? t('device.updated', { when: relTime(S.lastPoll) }) : '';
}

function setKindIcon(box, d) {
  box.textContent = '';
  if (d.icon) {
    const img = document.createElement('img');
    img.src = d.icon;
    img.alt = '';
    box.appendChild(img);
  } else {
    box.textContent = KIND_ICON[d.kind] || KIND_ICON.other;
  }
}

function bindToggle(input, value, onChange) {
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
}

async function update(id, patch) {
  setState(await tp.updateDevice(id, patch));
}

async function move(idx, dir) {
  const ids = S.devices.map((d) => d.id);
  const j = idx + dir;
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  setState(await tp.reorderDevices(ids));
}

// ================================================================ audio
let dragging = false;

function fillSelect(sel, list, flow) {
  const cur = sel.value;
  sel.innerHTML = '';
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    if (d.isDefault) o.selected = true;
    sel.appendChild(o);
  }
  if (!list.length) {
    const o = document.createElement('option');
    o.textContent = t('audio.noDevices');
    sel.appendChild(o);
    sel.disabled = true;
  } else sel.disabled = false;
  sel.dataset.flow = flow;
  if (!list.some((d) => d.isDefault) && cur) sel.value = cur;
}

function renderMic(muted) {
  const b = $('#mic-toggle');
  b.classList.toggle('muted', !!muted);
  b.textContent = muted ? `🔇 ${t('audio.micMuted')}` : `🎙 ${t('audio.micLive')}`;
}

async function loadAudio(quiet) {
  const caps = S.capabilities;
  try {
    const a = await tp.audioDevices();
    if (!(quiet && document.activeElement === $('#output-select'))) fillSelect($('#output-select'), a.outputs, 'output');
    if (!(quiet && document.activeElement === $('#input-select'))) fillSelect($('#input-select'), a.inputs, 'input');
    $('#output-select').hidden = !caps.outputSwitch;
    $('#input-select').hidden = !caps.inputSwitch;
    if (!dragging) {
      $('#output-volume').value = Math.round(a.output.volume * 100);
      $('#output-volume-num').textContent = Math.round(a.output.volume * 100);
      $('#input-volume').value = Math.round(a.input.volume * 100);
      $('#input-volume-num').textContent = Math.round(a.input.volume * 100);
    }
    $('#output-mute').textContent = a.output.muted ? '🔇' : '🔊';
    $('#output-mute').dataset.muted = a.output.muted ? '1' : '';
    renderMic(a.input.muted);
  } catch (e) {
    console.error(e);
  }
  $('#sas-notice').hidden = !caps.needsSwitchAudioSource;
  $('#mixer-card').hidden = !caps.mixer;
  $('#mixer-unsupported').hidden = caps.mixer;
  if (caps.mixer) loadMixer();
  const hk = S.settings.hotkeys.micMute;
  $('#mic-hotkey-hint').textContent = hk ? t('audio.micHotkey', { key: prettyAccel(hk) }) : '';
}

async function loadMixer() {
  let sessions = [];
  try {
    sessions = await tp.sessions();
  } catch (e) {
    console.error(e);
  }
  const box = $('#mixer');
  if (dragging) return;
  box.innerHTML = '';
  if (!sessions.length) {
    box.innerHTML = `<p class="hint">${t('audio.noSessions')}</p>`;
    return;
  }
  const tpl = $('#tpl-session');
  for (const s of sessions) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    translate(el);
    const img = $('.app-icon', el);
    if (s.icon) img.src = s.icon;
    else img.style.visibility = 'hidden';
    $('.session-name', el).textContent = s.system ? t('audio.systemSounds') : s.name;
    $('.session-name', el).title = s.path || '';
    const vol = $('.vol', el);
    const num = $('.num', el);
    vol.value = Math.round(s.volume * 100);
    num.textContent = vol.value;
    const send = throttle((v) => tp.setSessionVolume(s.key, v), 60);
    vol.addEventListener('pointerdown', () => (dragging = true));
    vol.addEventListener('pointerup', () => (dragging = false));
    vol.addEventListener('input', () => {
      num.textContent = vol.value;
      send(vol.value / 100);
    });
    const mute = $('.mute', el);
    let muted = s.muted;
    mute.textContent = muted ? '🔇' : '🔊';
    mute.addEventListener('click', async () => {
      muted = !muted;
      mute.textContent = muted ? '🔇' : '🔊';
      await tp.setSessionMute(s.key, muted);
    });
    box.appendChild(el);
  }
}

function bindAudioControls() {
  $('#output-select').addEventListener('change', (e) => tp.setDefaultAudio(e.target.value, 'output').then(() => loadAudio()));
  $('#input-select').addEventListener('change', (e) => tp.setDefaultAudio(e.target.value, 'input').then(() => loadAudio()));
  for (const flow of ['output', 'input']) {
    const r = $(`#${flow}-volume`);
    const send = throttle((v) => tp.setVolume(flow, v), 50);
    r.addEventListener('pointerdown', () => (dragging = true));
    r.addEventListener('pointerup', () => (dragging = false));
    r.addEventListener('input', () => {
      $(`#${flow}-volume-num`).textContent = r.value;
      send(r.value / 100);
    });
  }
  $('#output-mute').addEventListener('click', async () => {
    const muted = await tp.setMute('output', 'toggle');
    $('#output-mute').textContent = muted ? '🔇' : '🔊';
  });
  $('#mic-toggle').addEventListener('click', async () => renderMic(await tp.setMute('input', 'toggle')));
}

// ================================================================ settings
function renderSettings() {
  const st = S.settings;
  $$('[data-setting]').forEach((el) => {
    const v = st[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
  });

  // Taskbar widget (Windows only)
  $('#taskbar-settings').hidden = !S.taskbarSupported;
  const ws = $('#widget-status');
  ws.hidden = !(S.taskbarSupported && st.displayMode !== 'tray' && S.widgetStatus);
  if (!ws.hidden) ws.textContent = t('set.widgetFailed', { reason: t('widget.' + S.widgetStatus) });

  // Tray display choices
  const td = $('#tray-display');
  td.innerHTML = '';
  const opts = [
    ['lowest', t('set.trayLowest')],
    ['icon', t('set.trayIcon')],
    ...S.devices.map((d) => [d.id, d.displayName]),
  ];
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    td.appendChild(o);
  }
  td.value = st.trayDisplay;
  if (td.value !== st.trayDisplay) td.value = 'lowest';

  // Hotkeys
  $$('[data-hotkey]').forEach((b) => {
    if (b.classList.contains('recording')) return;
    const name = b.dataset.hotkey;
    const acc = st.hotkeys[name];
    b.textContent = acc ? prettyAccel(acc) : t('hk.none');
    const status = S.hotkeyStatus[name];
    b.classList.toggle('conflict', status === 'conflict' || status === 'invalid');
    b.title = status === 'conflict' ? t('hk.conflict') : status === 'invalid' ? t('hk.invalid') : '';
  });

  $('#shot-dir').textContent = st.screenshotDir || t('set.defaultShotDir');

  // Providers
  const pl = $('#provider-list');
  pl.innerHTML = '';
  for (const p of S.providers) {
    const row = document.createElement('label');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = p.name + (p.plugin ? ` (${t('set.plugin')})` : '');
    if (p.error) name.title = p.error;
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = p.enabled;
    sw.addEventListener('change', async () => setState(await tp.setSettings({ providers: { [p.id]: { enabled: sw.checked } } })));
    row.append(name, sw);
    pl.appendChild(row);
  }
  $('#version').textContent = `v${S.version}`;
  renderAccentPicker();
}

function bindSettings() {
  $$('[data-setting]').forEach((el) => {
    el.addEventListener('change', async () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') v = Number(v);
      if (el.dataset.setting === 'defaultLowThreshold') v = Math.min(99, Math.max(1, v || 20));
      setState(await tp.setSettings({ [el.dataset.setting]: v }));
    });
  });
  $('#btn-check-updates').addEventListener('click', async () => {
    const out = $('#update-status');
    out.textContent = t('set.checking');
    const r = await tp.checkUpdates();
    out.textContent =
      r.status === 'dev' ? t('set.updDev') : r.status === 'available' ? t('set.updAvailable', { v: r.version }) : r.status === 'latest' ? t('set.updLatest') : t('set.updError', { msg: r.message || '' });
  });
  $('#btn-shot-dir').addEventListener('click', async () => setState(await tp.chooseScreenshotDir()));
  $('#shot-dir').addEventListener('click', () => tp.openScreenshotDir());
  $('#btn-plugins').addEventListener('click', () => tp.openPlugins());
  $('#btn-logs').addEventListener('click', () => tp.openLogs());
  $$('[data-hotkey]').forEach((b) => b.addEventListener('click', () => recordHotkey(b)));
}

// ---------------------------------------------------------------- hotkey recorder
const isMac = () => S.platform === 'darwin';

function prettyAccel(acc) {
  return acc
    .replace('CommandOrControl', isMac() ? '⌘' : 'Ctrl')
    .replace('Alt', isMac() ? '⌥' : 'Alt')
    .replace('Shift', isMac() ? '⇧' : 'Shift')
    .replace('Super', isMac() ? '⌘' : 'Win')
    .replace(/\+/g, isMac() ? '' : ' + ');
}

function keyFromEvent(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return 'num' + c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  const map = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    Backquote: '`', PrintScreen: 'PrintScreen', Pause: 'Pause',
  };
  return map[c] || null;
}

let recording = null;
async function recordHotkey(btn) {
  if (recording) return;
  recording = btn;
  btn.classList.add('recording');
  btn.textContent = t('hk.press');
  await tp.suspendHotkeys(true);

  const finish = async (acc) => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    btn.classList.remove('recording');
    recording = null;
    if (acc !== undefined) {
      const hotkeys = { ...S.settings.hotkeys, [btn.dataset.hotkey]: acc };
      await tp.setSettings({ hotkeys });
    }
    await tp.suspendHotkeys(false);
    setState(await tp.getState());
  };
  const onBlur = () => finish(undefined);
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return finish(undefined);
    if (e.key === 'Backspace' || e.key === 'Delete') return finish('');
    const key = keyFromEvent(e);
    if (!key) return; // modifier only so far
    const mods = [];
    if (e.ctrlKey || (isMac() && e.metaKey)) mods.push('CommandOrControl');
    if (isMac() && e.ctrlKey && e.metaKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!isMac() && e.metaKey) mods.push('Super');
    if (!mods.length && !/^F\d/.test(key)) return; // need a modifier
    finish([...mods, key].join('+'));
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
}

// ================================================================ state
function setState(next) {
  if (!next) return;
  const langChanged = !S || S.lang !== next.lang;
  S = next;
  applyTheme();
  if (langChanged) applyI18n();
  // Don't rebuild a list while the user is typing in it.
  const focused = document.activeElement;
  const typing = focused && focused.matches('input[type="text"], input[type="number"]');
  if (!(typing && $('#device-list').contains(focused))) renderDevices();
  if (!(typing && $('#panel-settings').contains(focused))) renderSettings();
}

async function init() {
  setState(await tp.getState());
  applyI18n();
  bindAudioControls();
  bindSettings();
  bindAccentPicker();
  renderAccentPicker();
  $('#btn-sound-settings').addEventListener('click', () => tp.openSoundSettings());

  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#btn-close').addEventListener('click', () => tp.hide());
  $('#btn-quit').addEventListener('click', () => tp.quit());
  $('#btn-shot-region').addEventListener('click', () => tp.screenshot('region'));
  $('#btn-shot-full').addEventListener('click', () => tp.screenshot('full'));
  $('#btn-refresh').addEventListener('click', async () => {
    const b = $('#btn-refresh');
    b.classList.add('spin');
    try {
      setState(await tp.refresh());
      if (activeTab === 'audio') loadAudio();
    } finally {
      b.classList.remove('spin');
    }
  });

  tp.on('state:update', (s) => setState(s));
  tp.on('mic:update', ({ muted }) => renderMic(muted));
  tp.on('popup:shown', ({ tab }) => {
    if (tab) setTab(tab);
    else if (activeTab === 'audio') loadAudio();
    renderDevices(); // refresh relative times
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !recording) tp.hide();
  });
}

init();
