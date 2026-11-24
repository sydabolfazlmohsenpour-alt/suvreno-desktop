'use strict';
/* بررسی خودکار نسخه‌ی جدید (دسکتاپ ویندوز) — هم‌ریشه با UpdateChecker.kt در اپ اندروید
   - فایل کوچک desktop-version.json را از سایت می‌خواند: { version, notes: [...] }
   - اگر version از نسخه‌ی نصب‌شده بزرگ‌تر بود، یک پنجره‌ی پرسش نشان می‌دهد؛ «رفتن به صفحه‌ی دانلود» ← PAGE (صفحه‌ی دانلودِ ویندوز).
   - آدرسی که باز می‌شود ثابت است و هرگز از فایل JSON خوانده نمی‌شود؛ پس فایل خراب یا دست‌کاری‌شده نمی‌تواند کاربر را به جای دیگری ببرد.
   - نصب اجباری نیست؛ «بعداً» همان نسخه را ۱ روز ساکت می‌کند. اگر شبکه یا فایل مشکل داشته باشد، هیچ پیامی نشان داده نمی‌شود.
   - «انتشار» مثل اندروید دستی است: تا فایل desktop-version.json را در سایت نگذاری، هیچ پیامی نمی‌آید. */
const { app, dialog, shell, net, BrowserWindow } = require('electron');

let SOURCES = ['https://suvreno.ir/desktop-version.json', 'https://chat.suvreno.ir/desktop-version.json'];
const PAGE = 'https://suvreno.ir/download.html#windows';
const FIRST_DELAY = 8000;          // چند ثانیه بعد از باز شدن برنامه
const EVERY = 6 * 3600 * 1000;     // برنامه در سینی سیستم می‌ماند؛ هر ۶ ساعت دوباره
const MIN_GAP = 30 * 60 * 1000;    // حداقل فاصله‌ی دو بررسی خودکار
const SNOOZE = 24 * 3600 * 1000;   // «بعداً» = ۱ روز
const TIMEOUT = 12000;

let ctx = { settings: {}, saveSettings() {}, getWin: () => null };
let busy = false, pending = false, lastCheck = 0, timer = null;

const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
const cfg = () => { if (!ctx.settings.update || typeof ctx.settings.update !== 'object') ctx.settings.update = {}; return ctx.settings.update; };
const persist = () => { try { ctx.saveSettings(); } catch (e) {} };

/* "1.2.0" ← [1,2,0]؛ هر چیز نامعتبر ← null */
function parseVer(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}$/.test(s)) return null;
  return s.split('.').map(Number);
}
function isNewer(remote, local) {
  const a = parseVer(remote), b = parseVer(local);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchInfo() {
  for (const src of SOURCES) {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const res = await net.fetch(src + '?t=' + Date.now(), { cache: 'no-store', signal: ac.signal });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && typeof j === 'object' && parseVer(j.version)) return j;
    } catch (e) { /* سراغ منبع بعدی */ } finally { clearTimeout(tm); }
  }
  return null;
}

const parentWin = () => { try { return BrowserWindow.getFocusedWindow() || ctx.getWin(); } catch (e) { return null; } };
const isShown = () => { try { const w = ctx.getWin(); return !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized()); } catch (e) { return false; } };
async function box(opts) {
  const w = parentWin(), o = Object.assign({ type: 'info', noLink: true, title: 'Suvreno', cancelId: 1 }, opts);
  const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, o) : await dialog.showMessageBox(o);
  return r.response;
}

/* manual=true: کاربر خودش از منو زده؛ همیشه جواب می‌گیرد (حتی «به‌روز است» یا «خطای شبکه») */
async function check(manual) {
  if (busy) return;
  busy = true; pending = false;
  try {
    lastCheck = Date.now();
    const info = await fetchInfo();
    if (!info) {
      if (manual) await box({ type: 'warning', buttons: ['باشه'], message: 'بررسی نسخه‌ی جدید انجام نشد', detail: 'ارتباط با سرور Suvreno برقرار نشد. اینترنت را بررسی کن و دوباره امتحان کن.' });
      return;
    }
    const cur = app.getVersion();
    if (!isNewer(info.version, cur)) {
      if (manual) await box({ buttons: ['باشه'], message: 'نسخه‌ی تو به‌روز است', detail: 'نسخه‌ی ' + cur + ' آخرین نسخه‌ی Suvreno برای ویندوز است.' });
      return;
    }
    const u = cfg();
    if (!manual && u.snoozeVer === String(info.version) && Date.now() - (u.snoozeAt || 0) < SNOOZE) return;
    /* وقتی برنامه فقط در سینی/پس‌زمینه است مزاحم نمی‌شویم؛ با باز شدن پنجره (nudge) نشان می‌دهیم */
    if (!manual && !isShown()) { pending = true; return; }

    const notes = (Array.isArray(info.notes) ? info.notes : []).map((x) => clip(String(x).replace(/\s+/g, ' ').trim(), 120)).filter(Boolean).slice(0, 8);
    const detail = (notes.length ? 'تغییرات این نسخه:\n' + notes.map((n) => '• ' + n).join('\n') + '\n\n' : '') +
      'با زدن «رفتن به صفحه‌ی دانلود»، صفحه‌ی نصب ویندوز در مرورگر باز می‌شود (راهنمای پیام هشدار ویندوز هم همان‌جاست). ' +
      'بعد از دانلود، Suvreno را ببند و نصب‌کننده‌ی جدید را اجرا کن. نصب اجباری نیست؛ هر وقت خواستی.';
    const r = await box({ type: 'info', buttons: ['رفتن به صفحه‌ی دانلود', 'بعداً'], defaultId: 0, cancelId: 1, message: 'نسخه‌ی جدید Suvreno آمده (نسخه‌ی ' + clip(info.version, 20) + ')', detail: detail + '\n\nنسخه‌ی فعلی تو: ' + cur });
    if (r === 0) { try { await shell.openExternal(PAGE); } catch (e) {} }
    else { u.snoozeVer = String(info.version); u.snoozeAt = Date.now(); persist(); }
  } catch (e) {
    /* بدون سر و صدا */
  } finally { busy = false; }
}

/* با باز شدن پنجره از سینی: اگر قبلاً چیزی منتظر نمایش بود یا مدتی از بررسی گذشته، دوباره بررسی کن */
function nudge() {
  if (busy) return;
  if (pending || Date.now() - lastCheck > MIN_GAP) setTimeout(() => check(false), 1500);
}
function start() {
  if (timer) return;
  setTimeout(() => check(false), FIRST_DELAY);
  timer = setInterval(() => check(false), EVERY);
  if (timer.unref) timer.unref();
}
function register(o) { ctx = { settings: o.settings, saveSettings: o.saveSettings, getWin: o.getWin || (() => null) }; }

module.exports = { register, start, nudge, checkNow: () => check(true), __test: { parseVer, isNewer, check, fetchInfo, cfg, setSources: (s) => { SOURCES = s; }, reset: () => { busy = false; pending = false; lastCheck = 0; }, state: () => ({ busy, pending, lastCheck }), PAGE } };
