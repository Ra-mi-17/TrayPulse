'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const LOCALE_DIR = path.join(__dirname, '..', 'locales');
const SUPPORTED = ['ja', 'en'];
const cache = {};

function load(lang) {
  if (!cache[lang]) cache[lang] = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${lang}.json`), 'utf8'));
  return cache[lang];
}

function resolveLang(setting) {
  if (SUPPORTED.includes(setting)) return setting;
  const sys = (app.getPreferredSystemLanguages?.()[0] || app.getLocale() || 'en').toLowerCase();
  return sys.startsWith('ja') ? 'ja' : 'en';
}

function createI18n(setting) {
  const lang = resolveLang(setting);
  const dict = { ...load('en'), ...load(lang) };
  const t = (key, vars = {}) => String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  return { lang, dict, t };
}

module.exports = { createI18n, SUPPORTED };
