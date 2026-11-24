'use strict';
const { app, BrowserWindow, Tray, Menu, shell, globalShortcut, session, nativeImage, Notification, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const agent = require('./agent');

const START_URL = 'https://chat.suvreno.ir/index.html';
app.setAppUserModelId('ir.suvreno.desktop');

// گوگل ورود در مرورگرهای توکار را مسدود می‌کند؛ پس مثل یک Chrome معمولی خودمان را معرفی می‌کنیم.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  process.versions.chrome + ' Safari/537.36';
app.userAgentFallback = CHROME_UA;

/* ---------- کمکی‌ها ---------- */
function parse(u) { try { return new URL(u); } catch (e) { return null; } }
function isSuvreno(u) {
  const p = parse(u); if (!p || p.protocol !== 'https:') return false;
  const h = p.hostname.toLowerCase();
  return h === 'suvreno.ir' || h.endsWith('.suvreno.ir') || h.endsWith('.workers.dev');
}
function isAuth(u) {
  const p = parse(u); if (!p || p.protocol !== 'https:') return false;
  const h = p.hostname.toLowerCase();
  return h.endsWith('.google.com') || h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.gstatic.com');
}
const allowedInApp = (u) => isSuvreno(u) || isAuth(u);
function iconPath() {
  const p = path.join(__dirname, 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

/* ---------- تنظیمات ---------- */
let settings = { closeToTray: true, autoStart: false, alwaysOnTop: false, bounds: null, maximized: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch (e) {} }
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (e) {} }

/* ---------- وضعیت ---------- */
let mainWin = null, tray = null, quitting = false;
let mini = false, prevBounds = null, prevMax = false;
const startHidden = process.argv.includes('--hidden');

/* ---------- پنجره ---------- */
function showOffline(win) {
  const html = '<!doctype html><meta charset="utf-8"><body dir="rtl" style="margin:0;background:#0b0b12;color:#eee;' +
    'font-family:Tahoma,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
    '<div><h2>اتصال به اینترنت برقرار نیست</h2><p>هر ۵ ثانیه دوباره تلاش می‌کنم…</p></div></body>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  clearTimeout(win._retry);
  win._retry = setTimeout(() => { if (!win.isDestroyed()) win.loadURL(START_URL); }, 5000);
}

function saveBounds(win) {
  if (!win || win.isDestroyed() || mini) return;
  settings.maximized = win.isMaximized();
  if (!win.isMaximized() && !win.isMinimized()) settings.bounds = win.getBounds();
  saveSettings();
}

function createWindow(isMain) {
  const b = (isMain && settings.bounds) ? settings.bounds : { width: 1180, height: 800 };
  const win = new BrowserWindow(Object.assign({}, b, {
    minWidth: 380, minHeight: 520, show: false, autoHideMenuBar: true,
    backgroundColor: '#0b0b12', title: 'Suvreno', icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  }));
  if (isMain && settings.maximized) win.maximize();
  if (isMain && settings.alwaysOnTop) win.setAlwaysOnTop(true);

  win.once('ready-to-show', () => { if (!(isMain && startHidden && tray)) win.show(); });
  win.loadURL(START_URL);

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (allowedInApp(url)) win.loadURL(url);
    else if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!allowedInApp(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOffline(win);
  });
  wc.on('context-menu', (e, params) => {
    const items = [];
    if (params.linkURL) items.push({ label: 'باز کردن لینک در مرورگر', click: () => shell.openExternal(params.linkURL) });
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('close', (e) => {
    if (!isMain) return;
    if (!quitting && settings.closeToTray && tray) { e.preventDefault(); win.hide(); return; }
    saveBounds(win);
  });
  win.on('closed', () => { if (isMain) mainWin = null; });
  return win;
}

function focusChatInput(win) {
  win.webContents.executeJavaScript(
    "(function(){var e=document.querySelector('textarea,[contenteditable=\"true\"]');if(e)e.focus();})()"
  ).catch(() => {});
}
function showMain(focusInput) {
  if (!mainWin) { mainWin = createWindow(true); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
  if (focusInput) focusChatInput(mainWin);
}
function toggleMain() {
  if (mainWin && mainWin.isVisible() && mainWin.isFocused()) mainWin.hide();
  else showMain(true);
}

/* ---------- قابلیت‌های مخصوص دسکتاپ ---------- */
function toggleMini() {
  showMain(false);
  const w = mainWin; if (!w) return;
  if (!mini) {
    prevBounds = w.getBounds(); prevMax = w.isMaximized();
    if (prevMax) w.unmaximize();
    const wa = screen.getDisplayMatching(prevBounds).workArea;
    const width = 420, height = 680;
    w.setBounds({ x: wa.x + wa.width - width - 16, y: wa.y + wa.height - height - 16, width, height });
    w.setAlwaysOnTop(true, 'floating');
    mini = true;
  } else {
    w.setAlwaysOnTop(!!settings.alwaysOnTop);
    if (prevBounds) w.setBounds(prevBounds);
    if (prevMax) w.maximize();
    mini = false;
  }
  rebuildUI();
}
function setAlwaysOnTop(v) {
  settings.alwaysOnTop = !!v; saveSettings();
  if (mainWin && !mini) mainWin.setAlwaysOnTop(settings.alwaysOnTop);
  rebuildUI();
}
function setAutoStart(v) {
  settings.autoStart = !!v; saveSettings();
  app.setLoginItemSettings({ openAtLogin: settings.autoStart, args: ['--hidden'] });
  rebuildUI();
}
function setCloseToTray(v) { settings.closeToTray = !!v; saveSettings(); rebuildUI(); }

/* ---------- منو و تری ---------- */
function toggles() {
  return [
    { label: 'همیشه روی بقیه‌ی پنجره‌ها', type: 'checkbox', checked: settings.alwaysOnTop, click: (m) => setAlwaysOnTop(m.checked) },
    { label: 'اجرا همراه با ویندوز', type: 'checkbox', checked: settings.autoStart, click: (m) => setAutoStart(m.checked) },
    { label: 'با بستن پنجره، در پس‌زمینه بماند', type: 'checkbox', checked: settings.closeToTray, click: (m) => setCloseToTray(m.checked) }
  ];
}
function rebuildUI() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Suvreno', submenu: [
      { label: 'پنجره‌ی جدید', accelerator: 'CommandOrControl+N', click: () => createWindow(false) },
      { label: mini ? 'خروج از حالت مینی (Ctrl+Shift+M)' : 'حالت مینی در گوشه‌ی صفحه (Ctrl+Shift+M)', click: toggleMini },
      { type: 'separator' }, ...toggles(), { type: 'separator' },
      { label: 'خروج کامل', click: () => { quitting = true; app.quit(); } }
    ] },
    { role: 'editMenu' },
    { label: 'نما', submenu: [
      { role: 'reload' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }
    ] }
  ]));
  if (tray) tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'نمایش Suvreno  (Ctrl+Shift+Space)', click: () => showMain(true) },
    { label: mini ? 'خروج از حالت مینی' : 'حالت مینی', click: toggleMini },
    { type: 'separator' }, ...toggles(), { type: 'separator' },
    { label: 'خروج کامل', click: () => { quitting = true; app.quit(); } }
  ]));
}
function createTray() {
  const p = iconPath(); if (!p) return;
  tray = new Tray(nativeImage.createFromPath(p).resize({ width: 16, height: 16 }));
  tray.setToolTip('Suvreno');
  tray.on('click', () => showMain(true));
}

/* ---------- IPC (فقط برای سایتِ سوورنو) ---------- */
function senderOk(e) { return isSuvreno(e.senderFrame ? e.senderFrame.url : e.sender.getURL()); }
ipcMain.on('sd:version', (e) => { e.returnValue = senderOk(e) ? app.getVersion() : ''; });
ipcMain.handle('sd:aot', (e, v) => { if (!senderOk(e)) return false; setAlwaysOnTop(v); return settings.alwaysOnTop; });
ipcMain.handle('sd:mini', (e) => { if (!senderOk(e)) return false; toggleMini(); return mini; });
ipcMain.handle('sd:notify', (e, t, b) => {
  if (!senderOk(e) || !Notification.isSupported()) return false;
  const n = new Notification({ title: String(t).slice(0, 100), body: String(b).slice(0, 300), icon: iconPath() });
  n.on('click', () => showMain(true));
  n.show();
  return true;
});

/* ---------- ایجنت دسکتاپ (فایل‌ها، باز کردن سایت/برنامه؛ همه‌چیز در agent.js) ---------- */
agent.register({ ipcMain, settings, saveSettings });

/* ---------- شروع ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain(true));
  app.on('before-quit', () => { quitting = true; saveBounds(mainWin); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { if (!tray || quitting) app.quit(); });

  app.whenReady().then(() => {
    loadSettings();
    const ses = session.defaultSession;
    ses.setUserAgent(CHROME_UA);
    const okPerms = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'];
    ses.setPermissionRequestHandler((wc, perm, cb, details) => {
      cb(okPerms.includes(perm) && isSuvreno((details && details.requestingUrl) || wc.getURL()));
    });
    ses.setPermissionCheckHandler((wc, perm, origin) => okPerms.includes(perm) && isSuvreno(origin));

    createTray();
    mainWin = createWindow(true);
    rebuildUI();

    globalShortcut.register('CommandOrControl+Shift+Space', toggleMain);
    globalShortcut.register('CommandOrControl+Shift+M', toggleMini);
  });
}
