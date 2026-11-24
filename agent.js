'use strict';
/* ایجنت دسکتاپ Suvreno (روی ویندوز)
   - مغز (تصمیم‌گیری) روی Worker است؛ این فایل فقط «دست‌ها» را دارد: خواندن/نوشتن/حذف فایل داخل «پوشه‌ی کاری»ی که کاربر انتخاب کرده،
     باز کردن سایت در مرورگر پیش‌فرض و باز کردن چند برنامه‌ی مجاز.
   - امنیت: همه‌ی مسیرها داخل پوشه‌ی کاری قفل‌اند (بدون .. و بدون خروج با symlink)، حذف همیشه «انتقال به سطل زباله» است،
     و حذف / جایگزین‌کردن فایل / باز کردن برنامه همیشه با پنجره‌ی تأییدِ خودِ سیستم (نه صفحه‌ی وب) از کاربر پرسیده می‌شود.
   - فقط صفحه‌های suvreno.ir (نه هر workers.dev) اجازه‌ی استفاده از این پل را دارند. */
const { BrowserWindow, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

/* آدرس workers.dev در ایران اغلب فیلتر است؛ مثل net.js سایت، اول دامنه‌ی اختصاصی را امتحان می‌کنیم و اگر جواب نداد workers.dev */
let BASES = ['https://plus-api.suvreno.ir/', 'https://suvreno-plus.sydabolfazlmohsenpour.workers.dev/'];
let basePref = 0;
let ctx = { settings: {}, saveSettings() {} };

/* ---------- کمکی‌ها ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
const cfg = () => { if (!ctx.settings.agent || typeof ctx.settings.agent !== 'object') ctx.settings.agent = {}; return ctx.settings.agent; };
const persist = () => { try { ctx.saveSettings(); } catch (e) {} };
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

/* برنامه‌های قابل باز شدن (فقط از همین فهرست؛ هرگز نامِ برنامه از مدل مستقیم اجرا نمی‌شود) */
const APPS = [
  [/notepad|نوت ?پد|دفترچه|یادداشت/i, 'notepad.exe', 'Notepad'],
  [/calc|ماشین ?حساب/i, 'calc.exe', 'Calculator'],
  [/paint|پینت|نقاشی/i, 'mspaint.exe', 'Paint'],
  [/explorer|اکسپلورر|فایل ?منیجر|file ?manager/i, 'explorer.exe', 'File Explorer'],
  [/chrome|کروم/i, 'chrome', 'Chrome'],
  [/\bedge\b|مایکروسافت ?اج/i, 'msedge', 'Edge'],
  [/firefox|فایرفاکس/i, 'firefox', 'Firefox'],
  [/winword|\bword\b|ورد/i, 'winword', 'Word'],
  [/excel|اکسل/i, 'excel', 'Excel'],
  [/powerpoint|powerpnt|پاورپوینت/i, 'powerpnt', 'PowerPoint'],
  [/vs ?code|visual studio code|ویژوال/i, 'code', 'VS Code'],
  [/spotify|اسپاتیفای/i, 'spotify', 'Spotify'],
  [/telegram|تلگرام/i, 'telegram', 'Telegram'],
  [/\bvlc\b/i, 'vlc', 'VLC'],
  [/snipping|اسنیپ|قیچی/i, 'snippingtool', 'Snipping Tool']
];
const findApp = (name) => { const n = String(name || ''); for (const a of APPS) if (a[0].test(n)) return { exe: a[1], label: a[2] }; return null; };
const EXEC_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.lnk', '.hta', '.jar', '.reg', '.dll', '.cpl', '.url', '.msc', '.application', '.appref-ms', '.pif', '.gadget', '.sh', '.app']);

/* ---------- توکن (رمزگذاری‌شده با خودِ ویندوز، اگر در دسترس باشد) ---------- */
function getToken() {
  const a = cfg(); if (!a.token) return '';
  try {
    if (a.enc) return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(a.token, 'base64')) : '';
    return String(a.token);
  } catch (e) { return ''; }
}
function setToken(t) {
  const a = cfg();
  if (!t) { delete a.token; delete a.enc; }
  else {
    try {
      if (safeStorage.isEncryptionAvailable()) { a.token = safeStorage.encryptString(t).toString('base64'); a.enc = true; }
      else { a.token = t; a.enc = false; }
    } catch (e) { a.token = t; a.enc = false; }
  }
  persist();
}

/* ---------- پوشه‌ی کاری و مسیرهای امن ---------- */
function badWorkspace(dir) {
  const p = path.resolve(dir), low = p.toLowerCase();
  if (p === path.parse(p).root) return 'ریشه‌ی درایو';
  if (low === path.resolve(os.homedir()).toLowerCase()) return 'پوشه‌ی اصلی کاربر';
  const sys = [process.env.windir, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean).map((x) => path.resolve(x).toLowerCase());
  if (sys.some((s) => low === s || low.startsWith(s + path.sep))) return 'پوشه‌ی سیستم';
  if (process.env.APPDATA) {
    const ad = path.resolve(path.dirname(process.env.APPDATA)).toLowerCase();
    if (low === ad || low.startsWith(ad + path.sep)) return 'پوشه‌ی AppData';
  }
  if (low.split(path.sep).some((s) => s === '.ssh' || s === '.aws' || s === '.gnupg')) return 'پوشه‌ی کلیدها';
  return '';
}
function wsRoot() { const w = cfg().workspace; try { return w && fs.statSync(w).isDirectory() ? w : ''; } catch (e) { return ''; } }
const FILE_ACTS = new Set(['list', 'read', 'write', 'append', 'mkdir', 'move', 'delete', 'open_file']);

/* مسیر نسبی ← مسیر کامل داخل پوشه‌ی کاری؛ هر خروج از پوشه خطا می‌دهد */
function resolveIn(rel, allowRoot) {
  const root = wsRoot(); if (!root) throw new Error('پوشه‌ی کاری انتخاب نشده است.');
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').trim();
  if (r === '' || r === '.') { if (allowRoot) return root; throw new Error('مسیر خالی است.'); }
  if (/^[a-zA-Z]:|^\//.test(r) || /[<>:"|?*\u0000-\u001f]/.test(r)) throw new Error('مسیر نامعتبر است.');
  const segs = r.split('/').filter((s) => s && s !== '.');
  if (!segs.length || segs.some((s) => s === '..' || /[. ]$/.test(s) || s.length > 120 || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s))) throw new Error('مسیر نامعتبر است.');
  const full = path.resolve(root, ...segs), rr = path.relative(root, full);
  if (!rr || rr.startsWith('..') || path.isAbsolute(rr)) throw new Error('مسیر بیرون از پوشه‌ی کاری است.');
  let probe = full;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const r2 = path.relative(fs.realpathSync(root), fs.realpathSync(probe));
  if (r2.startsWith('..') || path.isAbsolute(r2)) throw new Error('مسیر بیرون از پوشه‌ی کاری است.');
  return full;
}
function treeText(root, maxEntries) {
  const lines = [], SKIP = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);
  (function walk(dir, depth, prefix) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (lines.length >= maxEntries) return;
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) { lines.push(prefix + e.name + '/'); if (depth < 2) walk(path.join(dir, e.name), depth + 1, prefix + e.name + '/'); }
      else { let sz = ''; try { sz = ' (' + fmtSize(fs.statSync(path.join(dir, e.name)).size) + ')'; } catch (e2) {} lines.push(prefix + e.name + sz); }
    }
  })(root, 1, '');
  if (lines.length >= maxEntries) lines.push('… (more items not shown)');
  return lines.join('\n') || '(empty folder)';
}
function buildPage(lastResult) {
  const root = wsRoot();
  if (!root) return { url: '', title: '(no workspace folder)', text: 'WORKSPACE: none selected yet. If you need files, use a file action: the user will be asked to pick a folder.\n\nLAST RESULT:\n' + (lastResult || '(none)'), els: [] };
  return { url: '', title: path.basename(root), text: 'LAST RESULT:\n' + clip(lastResult || '(none)', 9500) + '\n\nWORKSPACE FOLDER "' + path.basename(root) + '" (paths are relative to it). TREE:\n' + clip(treeText(root, 90), 1800), els: [] };
}

/* ---------- وضعیت اجرا ---------- */
let run = { active: false, stop: false, wc: null, ac: null, reply: null, approved: false, taskId: '' };
function emit(o) {
  const wc = run.wc; if (!wc || wc.isDestroyed()) return;
  try { wc.executeJavaScript('window.amAgentEvent&&window.amAgentEvent(' + JSON.stringify(JSON.stringify(o)) + ')').catch(() => {}); } catch (e) {}
}
const win = () => { try { return run.wc && !run.wc.isDestroyed() ? BrowserWindow.fromWebContents(run.wc) : BrowserWindow.getFocusedWindow(); } catch (e) { return null; } };
async function box(opts) {
  const w = win(), o = Object.assign({ type: 'question', noLink: true, title: 'ایجنت Suvreno', cancelId: 1 }, opts);
  const r = w ? await dialog.showMessageBox(w, o) : await dialog.showMessageBox(o);
  return r.response;
}

async function api(body, ms) {
  const deadline = Date.now() + (ms || 60000);
  for (let k = 0; k < BASES.length; k++) {
    const idx = (basePref + k) % BASES.length, left = deadline - Date.now();
    if (left < 1500 && k > 0) break;
    const ac = new AbortController(); run.ac = ac;
    const tm = setTimeout(() => ac.abort(), Math.max(1500, k === 0 && BASES.length > 1 ? Math.min(left, 25000) : left));
    try {
      const r = await fetch(BASES[idx], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      const j = await r.json();
      basePref = idx; return j;
    } catch (e) {
      if (run.stop) break;
    } finally { clearTimeout(tm); }
  }
  return { ok: false, error: 'NETWORK', message: run.stop ? 'متوقف شد.' : 'ارتباط با سرور Suvreno برقرار نشد؛ اینترنت را بررسی کن.' };
}

/* ---------- انتخاب پوشه ---------- */
async function pickWorkspace() {
  const w = win(); const opts = { title: 'پوشه‌ی کاری ایجنت Suvreno', buttonLabel: 'انتخاب این پوشه', properties: ['openDirectory', 'createDirectory'] };
  const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, message: 'پوشه‌ای انتخاب نشد.' };
  const dir = r.filePaths[0], bad = badWorkspace(dir);
  if (bad) {
    await box({ type: 'warning', buttons: ['باشه'], message: 'این پوشه مجاز نیست (' + bad + ')', detail: 'یک پوشه‌ی مشخص انتخاب کن؛ مثلاً یک پوشه‌ی تازه داخل Documents یا Desktop.' });
    return { ok: false, message: 'این پوشه مجاز نیست (' + bad + ').' };
  }
  cfg().workspace = dir; persist();
  return { ok: true, workspace: dir, name: path.basename(dir) };
}

/* ---------- اجرای کارها ---------- */
const needsWs = (a) => FILE_ACTS.has(a);
function launchApp(app) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, note: 'باز کردن برنامه فقط روی ویندوز پشتیبانی می‌شود.' });
    execFile('cmd.exe', ['/d', '/s', '/c', 'start "" "' + app.exe + '"'], { windowsHide: true, windowsVerbatimArguments: true }, (err) => {
      resolve(err ? { ok: false, note: 'برنامه‌ی «' + app.label + '» باز نشد (شاید نصب نباشد).' } : { ok: true, note: 'برنامه‌ی «' + app.label + '» باز شد.' });
    });
  });
}
/* پیش‌بررسی: هر کاری که باید از کاربر پرسیده شود، متن پرسش را برمی‌گرداند */
function confirmText(a) {
  const p = a.path != null ? '«' + a.path + '»' : '';
  if (a.action === 'delete') return { head: 'انتقال به سطل زباله', msg: 'ایجنت می‌خواهد این مورد را به سطل زباله منتقل کند: ' + p, yes: 'انتقال به سطل زباله' };
  if (a.action === 'write' && fs.existsSync(resolveIn(a.path))) return { head: 'جایگزین‌کردن فایل', msg: 'فایل ' + p + ' از قبل وجود دارد. ایجنت می‌خواهد محتوای آن را با متن تازه جایگزین کند (محتوای قبلی از بین می‌رود).', yes: 'جایگزین کن' };
  if (a.action === 'open_app') { const ap = findApp(a.text); return { head: 'باز کردن برنامه', msg: 'ایجنت می‌خواهد برنامه‌ی «' + (ap ? ap.label : clip(a.text, 40)) + '» را باز کند.', yes: 'باز کن' }; }
  if (a.sensitive) return { head: 'تأیید کار حساس', msg: 'ایجنت این کار را حساس می‌داند و تأیید می‌خواهد:\n' + clip(a.thought || a.action + ' ' + (a.path || a.url || a.text || ''), 200), yes: 'انجام بده' };
  return null;
}
async function perform(a) {
  try {
    if (needsWs(a.action) && !wsRoot()) {
      const ok = await box({ buttons: ['انتخاب پوشه', 'لغو'], defaultId: 0, message: 'ایجنت برای این کار به یک پوشه‌ی کاری نیاز دارد', detail: 'فقط داخل پوشه‌ای که انتخاب می‌کنی فایل می‌خواند و می‌نویسد. برای امنیت بهتر است یک پوشه‌ی مخصوص (مثلاً داخل Documents) انتخاب کنی.' });
      if (ok !== 0) return { ok: false, note: 'کاربر پوشه‌ی کاری انتخاب نکرد.' };
      const pw = await pickWorkspace(); if (!pw.ok) return { ok: false, note: pw.message || 'پوشه‌ی کاری انتخاب نشد.' };
    }
    if (run.stop) return { ok: false, note: 'متوقف شد.' };
    const c = confirmText(a);
    if (c) {
      const r = await box({ type: 'warning', buttons: [c.yes, 'نه، لغو'], defaultId: 1, message: c.head, detail: c.msg });
      if (r !== 0) return { ok: false, note: 'کاربر اجازه نداد.' };
    }
    switch (a.action) {
      case 'wait': await sleep(1500); return { ok: true, note: 'کمی صبر شد.' };
      case 'list': {
        const p = resolveIn(a.path, true);
        if (!fs.statSync(p).isDirectory()) throw new Error('این یک پوشه نیست.');
        const ents = fs.readdirSync(p, { withFileTypes: true }).slice(0, 200);
        const body = ents.map((e) => { let sz = ''; if (!e.isDirectory()) { try { sz = ' (' + fmtSize(fs.statSync(path.join(p, e.name)).size) + ')'; } catch (x) {} } return (e.isDirectory() ? '[dir] ' : '[file] ') + e.name + sz; }).join('\n') || '(empty)';
        return { ok: true, note: ents.length + ' مورد', result: 'LIST of "' + (a.path || '.') + '":\n' + body };
      }
      case 'read': {
        const p = resolveIn(a.path), st = fs.statSync(p);
        if (!st.isFile()) throw new Error('این یک فایل نیست.');
        if (st.size > 5 * 1048576) throw new Error('فایل بزرگ‌تر از ۵ مگابایت است.');
        const buf = Buffer.alloc(Math.min(st.size, 200000)), fd = fs.openSync(p, 'r');
        try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        if (buf.subarray(0, 4096).includes(0)) throw new Error('این فایل متنی نیست (باینری است).');
        let text = buf.toString('utf8'); if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        return { ok: true, note: 'خوانده شد (' + fmtSize(st.size) + ')', result: 'FILE "' + a.path + '" (' + fmtSize(st.size) + (st.size > buf.length ? ', only the first part is shown' : '') + '):\n' + clip(text, 9000) };
      }
      case 'write':
      case 'append': {
        const p = resolveIn(a.path), data = String(a.text == null ? '' : a.text);
        if (Buffer.byteLength(data) > 1000000) throw new Error('متن بیش از ۱ مگابایت است.');
        if (fs.existsSync(p) && !fs.statSync(p).isFile()) throw new Error('این مسیر یک پوشه است.');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (a.action === 'append') fs.appendFileSync(p, data, 'utf8'); else fs.writeFileSync(p, data, 'utf8');
        return { ok: true, note: (a.action === 'append' ? 'به انتهای ' : 'نوشته شد: ') + a.path + ' (' + fmtSize(Buffer.byteLength(data)) + ')' };
      }
      case 'mkdir': { const p = resolveIn(a.path); fs.mkdirSync(p, { recursive: true }); return { ok: true, note: 'پوشه ساخته شد: ' + a.path }; }
      case 'move': {
        const from = resolveIn(a.path), to = resolveIn(a.to);
        if (!fs.existsSync(from)) throw new Error('مبدأ پیدا نشد.');
        if (fs.existsSync(to)) throw new Error('مقصد از قبل وجود دارد؛ نام دیگری بده.');
        fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to);
        return { ok: true, note: 'جابه‌جا شد: ' + a.path + ' ← ' + a.to };
      }
      case 'delete': {
        const p = resolveIn(a.path); if (!fs.existsSync(p)) throw new Error('مورد پیدا نشد.');
        await shell.trashItem(p); return { ok: true, note: 'به سطل زباله منتقل شد: ' + a.path };
      }
      case 'open_file': {
        const p = resolveIn(a.path, true);
        if (!fs.existsSync(p)) throw new Error('مورد پیدا نشد.');
        if (fs.statSync(p).isFile() && EXEC_EXT.has(path.extname(p).toLowerCase())) throw new Error('باز کردن برنامه و اسکریپت از این راه مجاز نیست.');
        const er = await shell.openPath(p); if (er) throw new Error('باز نشد.');
        return { ok: true, note: 'باز شد: ' + (a.path || 'پوشه‌ی کاری') };
      }
      case 'open_url': {
        let u; try { u = new URL(String(a.url || '')); } catch (e) { throw new Error('آدرس نامعتبر است.'); }
        if (u.protocol !== 'https:') throw new Error('فقط آدرس https مجاز است.');
        await shell.openExternal(u.toString()); return { ok: true, note: 'در مرورگر باز شد: ' + u.hostname };
      }
      case 'open_app': {
        const ap = findApp(a.text);
        if (!ap) return { ok: false, note: 'این برنامه در فهرست مجاز نیست. مجازها: ' + APPS.map((x) => x[2]).join('، ') };
        return await launchApp(ap);
      }
      default: return { ok: false, note: 'کار ناشناخته.' };
    }
  } catch (e) {
    return { ok: false, note: clip(e && e.message ? e.message : 'خطا', 160) };
  }
}
const waitReply = () => new Promise((resolve) => {
  const tm = setTimeout(() => { run.reply = null; resolve(null); }, 15 * 60000);
  run.reply = (v) => { clearTimeout(tm); run.reply = null; resolve(v); };
});

/* ---------- حلقه‌ی اصلی ---------- */
async function loop(tok, st) {
  const hist = []; let last = '', ended = false;
  const endTask = async (status) => { if (!ended) { ended = true; try { await api({ mode: 'agent-end', agentToken: tok, taskId: st.taskId, status }, 15000); } catch (e) {} } };
  emit({ type: 'started', text: 'ایجنت دسکتاپ شروع کرد (حداکثر ' + st.maxSteps + ' مرحله).' });
  try {
    for (let i = 0; i < 90 && !run.stop; i++) {
      const r = await api({ mode: 'agent-step', agentToken: tok, taskId: st.taskId, page: buildPage(last), history: hist.slice(-8) }, 90000);
      if (run.stop) break;
      if (!r || !r.ok || !r.action) {
        if (r && r.error === 'AGENT_UNAUTH') setToken('');
        emit({ type: 'error', text: (r && r.message) || 'ایجنت متوقف شد.' });
        if (!r || r.error === 'NETWORK') await endTask('failed'); else ended = true;
        return;
      }
      const a = r.action;
      if (a.action === 'done') { ended = true; emit({ type: 'done', text: a.answer || 'کار تموم شد.' }); return; }
      if (a.thought) emit({ type: 'step', text: a.thought });
      if (a.action === 'ask') {
        emit({ type: 'ask', text: a.answer });
        const v = await waitReply();
        if (v === null) { if (!run.stop) emit({ type: 'stopped', text: 'پاسخی نرسید؛ ایجنت متوقف شد.' }); await endTask('stopped'); return; }
        hist.push({ a: 'USER_REPLY', x: clip(v, 300) }); last = ''; continue;
      }
      const res = await perform(a);
      hist.push({ a: a.action, x: clip(a.path || a.url || a.text || '', 100), ok: res.ok, n: clip(res.note, 100) });
      last = res.result || ((res.ok ? '✓ ' : '✗ FAILED: ') + res.note);
      emit({ type: 'step', text: (res.ok ? '✓ ' : '✗ ') + res.note });
      if (r.final) { ended = true; emit({ type: 'done', text: 'کار تمام شد.' }); return; }
    }
    if (run.stop) { emit({ type: 'stopped', text: 'ایجنت متوقف شد.' }); await endTask('stopped'); }
    else { emit({ type: 'error', text: 'تعداد مرحله‌ها از حد گذشت؛ کار را کوتاه‌تر بگو.' }); await endTask('failed'); }
  } catch (e) {
    emit({ type: 'error', text: 'خطای غیرمنتظره: ' + clip(e && e.message, 120) }); await endTask('failed');
  } finally { run.active = false; run.reply = null; }
}

async function start(wc, code, task) {
  if (run.active) return { ok: false, message: 'یک کار ایجنت در حال اجراست.' };
  task = clip(String(task || '').trim(), 600);
  if (task.length < 5) return { ok: false, message: 'کار را کامل‌تر بنویس.' };
  run.wc = wc; run.stop = false;
  let tok = getToken();
  code = String(code || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  if (code) {
    const rr = await api({ mode: 'agent-pair-redeem', code, device: 'desktop' }, 25000);
    if (!rr || !rr.ok || !rr.token) return { ok: false, message: (rr && rr.message) || 'اتصال برقرار نشد.' };
    setToken(rr.token); tok = rr.token;
  }
  if (!tok) return { ok: false, needPair: true, message: 'اول باید این دستگاه به حساب Suvreno وصل شود.' };
  if (!run.approved) {
    const ws = wsRoot();
    const r = await box({ buttons: ['اجازه می‌دهم', 'لغو'], defaultId: 1, message: 'ایجنت Suvreno اجازه می‌خواهد روی این کامپیوتر کار کند', detail: 'کار: ' + clip(task, 220) + '\n\nپوشه‌ی کاری: ' + (ws || 'هنوز انتخاب نشده (در صورت نیاز از تو می‌پرسد)') + '\n\nایجنت فقط داخل پوشه‌ی کاری فایل می‌خواند و می‌نویسد. حذف (به سطل زباله)، جایگزین‌کردن فایل و باز کردن برنامه‌ها همیشه از تو تأیید می‌گیرد. هر لحظه می‌توانی متوقفش کنی.' });
    if (r !== 0) return { ok: false, message: 'لغو شد.' };
    run.approved = true;
  }
  const st = await api({ mode: 'agent-start', agentToken: tok, task, device: 'desktop', caps: [] }, 25000);
  if (!st || !st.ok) {
    if (st && st.error === 'AGENT_UNAUTH') { setToken(''); return { ok: false, needPair: true, message: 'اتصال قبلی معتبر نیست؛ دوباره وصل می‌شوم.' }; }
    return { ok: false, message: (st && st.message) || 'شروع نشد.' };
  }
  run.active = true; run.taskId = st.taskId;
  loop(tok, st);
  return { ok: true, taskId: st.taskId, maxSteps: st.maxSteps, tier: st.tierLabel || '', quota: st.quota || null };
}
function stop() {
  if (!run.active) return { ok: true };
  run.stop = true;
  try { if (run.ac) run.ac.abort(); } catch (e) {}
  if (run.reply) run.reply(null);
  return { ok: true };
}

/* ---------- ثبت IPC ---------- */
const strictOrigin = (u) => { try { const p = new URL(u); const h = p.hostname.toLowerCase(); return p.protocol === 'https:' && (h === 'suvreno.ir' || h.endsWith('.suvreno.ir')); } catch (e) { return false; } };
function register(o) {
  ctx = { settings: o.settings, saveSettings: o.saveSettings };
  const { ipcMain } = o;
  const ok = (e) => strictOrigin(e.senderFrame ? e.senderFrame.url : e.sender.getURL());
  ipcMain.handle('sd:agent-state', (e) => {
    if (!ok(e)) return { available: false };
    const ws = wsRoot();
    return { available: true, hasToken: !!getToken(), running: run.active, workspace: ws, workspaceName: ws ? path.basename(ws) : '' };
  });
  ipcMain.handle('sd:agent-start', (e, code, task) => ok(e) ? start(e.sender, code, task) : { ok: false, message: 'مجاز نیست.' });
  ipcMain.handle('sd:agent-stop', (e) => ok(e) ? stop() : { ok: false });
  ipcMain.handle('sd:agent-reply', (e, text) => { if (!ok(e)) return { ok: false }; if (run.reply) { run.reply(clip(String(text || ''), 600)); return { ok: true }; } return { ok: false }; });
  ipcMain.handle('sd:agent-forget', (e) => { if (!ok(e)) return { ok: false }; stop(); setToken(''); return { ok: true }; });
  ipcMain.handle('sd:agent-pick', async (e) => { if (!ok(e)) return { ok: false }; run.wc = e.sender; return pickWorkspace(); });
  ipcMain.handle('sd:open-url', async (e, u) => {
    if (!ok(e)) return false;
    try { const p = new URL(String(u)); if (p.protocol !== 'https:') return false; await shell.openExternal(p.toString()); return true; } catch (x) { return false; }
  });
}

module.exports = { register, __test: { resolveIn, badWorkspace, perform, buildPage, loop, start, stop, findApp, treeText, cfg, setApi: (u) => { BASES = Array.isArray(u) ? u : [u]; basePref = 0; }, runState: () => run, setCtx: (c) => { ctx = c; } } };
