'use strict';
// Polls battery providers, remembers devices, applies user settings and fires notifications.
const { EventEmitter } = require('events');

class DeviceManager extends EventEmitter {
  constructor({ store, providers, notify, log }) {
    super();
    this.store = store;
    this.providers = providers;
    this.notify = notify; // (type, device, extra) => void
    this.log = log;
    this.live = new Map(); // id -> device from the latest poll
    this.state = new Map(); // id -> { lastLevel, lowNotified, fullNotified }
    this.timer = null;
    this.polling = null;
    this.lastPoll = null;
    this.errors = {};
  }

  async init() {
    for (const p of this.providers) {
      try {
        await p.init?.(this.ctx(p));
      } catch (e) {
        this.log(`provider ${p.id} init failed`, e.message);
      }
    }
  }

  ctx(p) {
    return {
      powerSaving: this.store.get('powerSaving'),
      log: (...a) => this.log(`[${p.id}]`, ...a),
    };
  }

  providerEnabled(p) {
    return this.store.get('providers')[p.id]?.enabled !== false;
  }

  start() {
    this.stop();
    this.poll();
    const sec = Math.max(10, Number(this.store.get('pollIntervalSec')) || 60);
    this.timer = setInterval(() => this.poll(), sec * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const seen = new Map();
      await Promise.all(
        this.providers.filter((p) => this.providerEnabled(p)).map(async (p) => {
          try {
            const list = await p.getDevices(this.ctx(p));
            delete this.errors[p.id];
            for (const d of list || []) {
              if (!d || !d.id) continue;
              seen.set(d.id, { ...d, provider: p.id });
            }
          } catch (e) {
            this.errors[p.id] = e.message;
            this.log(`provider ${p.id} failed`, e.message);
          }
        })
      );
      this.live = seen;
      const known = { ...this.store.get('known') };
      const now = Date.now();
      for (const d of seen.values()) {
        known[d.id] = {
          name: d.name,
          kind: d.kind,
          provider: d.provider,
          level: d.level,
          components: d.components,
          connected: d.connected,
          lastSeen: now,
        };
        this.checkNotifications(d);
      }
      this.store.set({ known });
      this.lastPoll = now;
      this.emit('update', this.list());
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  // Lowest relevant level: for earbuds use the buds, not the case.
  effectiveLevel(d) {
    const parts = (d.components || []).filter((c) => c.key !== 'case' && c.level != null);
    if (parts.length) return Math.min(...parts.map((c) => c.level));
    return d.level;
  }

  checkNotifications(d) {
    const s = this.state.get(d.id) || { lastLevel: null, lowNotified: false, fullNotified: false };
    const cfg = this.store.get('devices')[d.id] || {};
    const level = this.effectiveLevel(d);
    if (level == null || cfg.hidden) {
      this.state.set(d.id, s);
      return;
    }
    const low = cfg.lowThreshold ?? this.store.get('defaultLowThreshold');
    const full = this.store.get('fullThreshold');
    const view = this.decorate(d);

    if (this.store.get('notifyLow') && cfg.notifyLow !== false && d.connected !== false) {
      if (level <= low && !s.lowNotified) {
        s.lowNotified = true;
        this.notify('low', view, { level });
      }
    }
    if (level > low + 5) s.lowNotified = false;

    if (this.store.get('notifyFull') && cfg.notifyFull !== false) {
      if (s.lastLevel != null && level > s.lastLevel && level >= full && !s.fullNotified) {
        s.fullNotified = true;
        this.notify('full', view, { level });
      }
    }
    if (level < full - 5) s.fullNotified = false;

    s.lastLevel = level;
    this.state.set(d.id, s);
  }

  decorate(d) {
    const cfg = this.store.get('devices')[d.id] || {};
    return {
      ...d,
      displayName: cfg.alias || d.name,
      hidden: !!cfg.hidden,
      order: cfg.order ?? 9999,
      lowThreshold: cfg.lowThreshold ?? this.store.get('defaultLowThreshold'),
      notifyFull: cfg.notifyFull !== false,
      notifyLow: cfg.notifyLow !== false,
      ownTray: !!cfg.ownTray,
      showOnTaskbar: cfg.showOnTaskbar !== false,
      icon: cfg.icon || null, // data URL of a user-chosen image
      effectiveLevel: this.effectiveLevel(d),
    };
  }

  /** All known devices (live ones first-class, remembered ones marked stale). */
  list() {
    const known = this.store.get('known');
    const out = [];
    for (const [id, k] of Object.entries(known)) {
      const live = this.live.get(id);
      const d = live || { id, ...k, connected: false, stale: true };
      out.push(this.decorate({ id, ...d }));
    }
    out.sort((a, b) => a.order - b.order || String(a.displayName).localeCompare(String(b.displayName)));
    return out;
  }

  forget(id) {
    const known = { ...this.store.get('known') };
    delete known[id];
    const devices = { ...this.store.get('devices') };
    delete devices[id];
    this.store.data.known = known;
    this.store.data.devices = devices;
    this.store.save();
    this.state.delete(id);
    this.emit('update', this.list());
  }

  reorder(ids) {
    const devices = { ...this.store.get('devices') };
    ids.forEach((id, i) => {
      devices[id] = { ...(devices[id] || {}), order: i };
    });
    this.store.set({ devices });
    this.emit('update', this.list());
  }

  dispose() {
    this.stop();
    for (const p of this.providers) {
      try {
        p.dispose?.();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { DeviceManager };
