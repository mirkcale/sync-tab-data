'use strict';

const SETTINGS_KEY = 'settings';
const SNAPSHOT_FORMAT = 'tab-data-sync/snapshot';
const SNAPSHOT_VERSION = 1;
const PBKDF2_ITERATIONS = 310000;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const BROWSER_LABELS = {
  chrome: 'Chrome',
  edge: 'Edge',
  opera: 'Opera',
  brave: 'Brave',
  unknown: '未知浏览器'
};

const ui = {
  sourceTab: byId('sourceTab'),
  sourceMeta: byId('sourceMeta'),
  refreshTabs: byId('refreshTabs'),
  targetTabPane: byId('targetTabPane'),
  targetUrlPane: byId('targetUrlPane'),
  targetTab: byId('targetTab'),
  targetUrl: byId('targetUrl'),
  targetMeta: byId('targetMeta'),
  kindLocal: byId('kindLocal'),
  kindSession: byId('kindSession'),
  kindCookie: byId('kindCookie'),
  storageMode: byId('storageMode'),
  rewriteDomain: byId('rewriteDomain'),
  reloadTarget: byId('reloadTarget'),
  panelSync: byId('panelSync'),
  panelTransfer: byId('panelTransfer'),
  panelButtons: Array.from(document.querySelectorAll('[data-panel]')),
  run: byId('run'),
  status: byId('status'),
  log: byId('log'),
  openTarget: byId('openTarget'),
  modeButtons: Array.from(document.querySelectorAll('[data-target-mode]')),
  exportPassphrase: byId('exportPassphrase'),
  exportFile: byId('exportFile'),
  exportClipboard: byId('exportClipboard'),
  importFileButton: byId('importFileButton'),
  importClipboard: byId('importClipboard'),
  snapshotFile: byId('snapshotFile'),
  snapshotPreview: byId('snapshotPreview'),
  snapshotMeta: byId('snapshotMeta'),
  snapshotPassphrase: byId('snapshotPassphrase'),
  importApply: byId('importApply')
};

let allTabs = [];
let targetMode = 'tab';
let panelMode = 'sync';
let busy = false;
let lastTargetTabId = null;
let pendingSnapshot = null;
let pendingEnvelope = null;

init();

async function init() {
  ui.refreshTabs.addEventListener('click', () => void refreshTabs());
  ui.run.addEventListener('click', () => void runSync());
  ui.openTarget.addEventListener('click', () => {
    if (lastTargetTabId === null) return;
    void chrome.tabs.update(lastTargetTabId, { active: true });
    window.close();
  });

  ui.sourceTab.addEventListener('change', () => {
    renderTargetTabs();
    updateMeta();
    void saveSettings();
  });
  ui.targetTab.addEventListener('change', updateMeta);

  for (const button of ui.modeButtons) {
    button.addEventListener('click', () => setTargetMode(button.dataset.targetMode));
  }
  for (const button of ui.panelButtons) {
    button.addEventListener('click', () => setPanelMode(button.dataset.panel));
  }

  for (const element of [
    ui.kindLocal,
    ui.kindSession,
    ui.kindCookie,
    ui.storageMode,
    ui.rewriteDomain,
    ui.reloadTarget
  ]) {
    element.addEventListener('change', () => void saveSettings());
  }

  ui.targetUrl.addEventListener('change', () => void saveSettings());
  ui.targetUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSync();
    }
  });

  ui.exportFile.addEventListener('click', () => void exportSnapshot('file'));
  ui.exportClipboard.addEventListener('click', () => void exportSnapshot('clipboard'));
  ui.importFileButton.addEventListener('click', () => ui.snapshotFile.click());
  ui.importClipboard.addEventListener('click', () => void importFromClipboard());
  ui.importApply.addEventListener('click', () => void applyImport());
  ui.snapshotFile.addEventListener('change', () => void importFromFile());

  await restoreSettings();
  syncImportButtonState();
  await refreshTabs();
}

/* ------------------------------------------------------------------ */
/* 标签页列表                                                         */
/* ------------------------------------------------------------------ */

async function refreshTabs() {
  const previousSource = Number(ui.sourceTab.value) || null;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const tabs = await chrome.tabs.query({});
  allTabs = tabs.filter((tab) => isWebUrl(tab.url));

  if (!allTabs.length) {
    fillSelect(ui.sourceTab, [], null);
    fillSelect(ui.targetTab, [], null);
    updateMeta();
    setStatus('error', '没有可用的 http/https 标签页');
    return;
  }

  fillSelect(ui.sourceTab, allTabs, previousSource ?? activeTab?.id);
  renderTargetTabs();
  updateMeta();
}

function renderTargetTabs() {
  const source = selectedTab(ui.sourceTab);
  const previousTarget = Number(ui.targetTab.value) || null;
  fillSelect(ui.targetTab, allTabs, previousTarget, source?.id);
  updateMeta();
}

function fillSelect(select, tabs, preferredId, excludeId) {
  const list = excludeId === undefined ? tabs : tabs.filter((tab) => tab.id !== excludeId);
  select.innerHTML = '';

  if (!list.length) {
    select.append(new Option('没有可用的标签页', ''));
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const tab of list) {
    select.append(new Option(tabLabel(tab), String(tab.id)));
  }

  const preferred = Number(preferredId);
  if (preferred && list.some((tab) => tab.id === preferred)) {
    select.value = String(preferred);
  } else {
    select.value = String(list[0].id);
  }
}

function tabLabel(tab) {
  let host = '';
  try {
    host = new URL(tab.url).host;
  } catch {
    host = tab.url || '';
  }
  const title = (tab.title || '').trim();
  const text = title ? `${host} · ${title}` : host;
  return text.length > 58 ? `${text.slice(0, 57)}…` : text;
}

function selectedTab(select) {
  if (!select || select.disabled) return null;
  const id = Number(select.value);
  if (!id) return null;
  return allTabs.find((tab) => tab.id === id) ?? null;
}

function isWebUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 界面状态                                                           */
/* ------------------------------------------------------------------ */

function setTargetMode(mode) {
  targetMode = mode === 'url' ? 'url' : 'tab';

  for (const button of ui.modeButtons) {
    button.classList.toggle('active', button.dataset.targetMode === targetMode);
  }
  ui.targetTabPane.hidden = targetMode !== 'tab';
  ui.targetUrlPane.hidden = targetMode !== 'url';

  updateMeta();
  void saveSettings();
}

function setPanelMode(mode) {
  panelMode = mode === 'transfer' ? 'transfer' : 'sync';

  for (const button of ui.panelButtons) {
    button.classList.toggle('active', button.dataset.panel === panelMode);
  }
  ui.panelSync.hidden = panelMode !== 'sync';
  ui.panelTransfer.hidden = panelMode !== 'transfer';

  if (panelMode === 'sync') updateMeta();
  void saveSettings();
}

function updateMeta() {
  const source = selectedTab(ui.sourceTab);
  ui.sourceMeta.textContent = source?.url ?? '';

  if (targetMode === 'url') {
    ui.targetMeta.textContent = '目标页面会在后台打开，完成后可点击“查看目标标签页”';
    return;
  }

  const target = selectedTab(ui.targetTab);
  if (target && source && target.id === source.id) {
    ui.targetMeta.textContent = '源标签页和目标标签页不能相同';
  } else {
    ui.targetMeta.textContent = target?.url ?? '';
  }
}

function setBusy(value) {
  busy = value;
  ui.run.disabled = value;
  ui.run.textContent = value ? '处理中…' : '开始同步';
  ui.refreshTabs.disabled = value;
  ui.exportFile.disabled = value;
  ui.exportClipboard.disabled = value;
  ui.importFileButton.disabled = value;
  ui.importClipboard.disabled = value;
  syncImportButtonState();
}

function syncImportButtonState() {
  ui.importApply.disabled = busy || (!pendingSnapshot && !pendingEnvelope);
}

function setStatus(kind, text) {
  ui.status.className = text ? `status ${kind}` : 'status';
  ui.status.textContent = text;
}

function clearOutput() {
  ui.log.hidden = true;
  ui.log.textContent = '';
  ui.openTarget.hidden = true;
  lastTargetTabId = null;
  setStatus('', '');
}

function appendLog(level, text) {
  ui.log.hidden = false;
  const line = document.createElement('span');
  line.className = `line ${level || 'info'}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${time}] ${text}`;
  ui.log.append(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus('error', message);
  appendLog('error', message);
}

/* ------------------------------------------------------------------ */
/* 与后台通信                                                          */
/* ------------------------------------------------------------------ */

function runRequest(type, payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'sync' });
    let finished = false;

    port.onMessage.addListener((message) => {
      if (!message) return;

      if (message.type === 'log') {
        appendLog(message.level, message.message);
        return;
      }

      if (message.type !== 'done') return;

      finished = true;
      port.disconnect();

      if (message.ok) resolve(message);
      else reject(new Error(message.error || '操作失败'));
    });

    port.onDisconnect.addListener(() => {
      if (finished) return;
      reject(new Error('与后台的连接已断开，请重试（扩展可能被重新加载）'));
    });

    port.postMessage({ type, payload });
  });
}

/* ------------------------------------------------------------------ */
/* 站内同步                                                           */
/* ------------------------------------------------------------------ */

async function runSync() {
  if (busy) return;

  try {
    const source = selectedTab(ui.sourceTab);
    if (!source) throw new Error('请选择源标签页');

    const kinds = collectKinds();
    if (!kinds.length) throw new Error('请至少勾选一项同步内容');

    const target = resolveTargetSpec();
    if (target.type === 'tab' && target.tabId === source.id) {
      throw new Error('源标签页和目标标签页不能相同');
    }

    clearOutput();
    setBusy(true);
    setStatus('info', '正在同步…');

    const done = await runRequest('start', {
      sourceTabId: source.id,
      target,
      kinds,
      ...writeOptions()
    });

    handleSummary(done.summary);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

function handleSummary(summary, heading = '同步完成') {
  lastTargetTabId = typeof summary?.tabId === 'number' ? summary.tabId : null;

  for (const warning of summary?.warnings || []) appendLog('warn', warning);

  setStatus(summary?.warnings?.length ? 'warn' : 'ok', describeSummary(summary || {}, heading));
  ui.openTarget.hidden = lastTargetTabId === null;
}

function describeSummary(summary, heading = '同步完成') {
  const parts = [];

  const local = summary.storage?.localStorage;
  if (local) parts.push(`localStorage ${local.written}/${local.read} 项`);

  const session = summary.storage?.sessionStorage;
  if (session) parts.push(`sessionStorage ${session.written}/${session.read} 项`);

  if (summary.cookies) {
    const cookies = summary.cookies;
    let text = `Cookie ${cookies.written}/${cookies.read} 个`;
    if (cookies.failed) text += `（失败 ${cookies.failed}）`;
    if (cookies.skipped) text += `（跳过 ${cookies.skipped}）`;
    parts.push(text);
  }

  const body = parts.length ? parts.join(' · ') : '没有可复制的数据';
  return `${heading}：${body}`;
}

/* ------------------------------------------------------------------ */
/* 跨浏览器：导出                                                      */
/* ------------------------------------------------------------------ */

async function exportSnapshot(method) {
  if (busy) return;

  try {
    const source = selectedTab(ui.sourceTab);
    if (!source) throw new Error('请选择源标签页');

    const kinds = collectKinds();
    if (!kinds.length) throw new Error('请至少勾选一项要导出的数据');

    const passphrase = ui.exportPassphrase.value;

    clearOutput();
    setBusy(true);
    setStatus('info', '正在生成快照…');

    const done = await runRequest('snapshot', {
      sourceTabId: source.id,
      kinds
    });

    const snapshot = done.snapshot;
    if (!snapshot) throw new Error('快照生成失败');

    let text;
    if (passphrase) {
      setStatus('info', '正在加密快照…');
      text = JSON.stringify(await encryptSnapshot(snapshot, passphrase));
    } else {
      text = JSON.stringify(snapshot, null, 2);
    }

    const filename = buildSnapshotFilename(snapshot);
    const size = new Blob([text]).size;

    if (method === 'file') {
      downloadText(filename, text);
      setStatus('ok', `快照已下载：${filename}（${formatBytes(size)}）`);
    } else {
      await navigator.clipboard.writeText(text);
      setStatus('ok', `快照已复制到剪贴板（${formatBytes(size)}），可以去另一个浏览器粘贴导入`);
    }

    appendLog('info', `来源：${snapshot.source?.url || '未知页面'}`);
    appendLog('info', `包含：${describeSnapshotData(snapshot.data)}`);
    if (!passphrase) {
      appendLog('warn', '快照未加密，里面包含可直接登录的凭证，请妥善保管');
    }
  } catch (error) {
    if (error?.name === 'NotAllowedError') {
      showError(new Error('无法写入剪贴板，请改用「下载文件」'));
    } else {
      showError(error);
    }
  } finally {
    setBusy(false);
  }
}

function describeSnapshotData(data) {
  const parts = [];
  if (data?.localStorage) parts.push(`localStorage ${Object.keys(data.localStorage).length} 项`);
  if (data?.sessionStorage) parts.push(`sessionStorage ${Object.keys(data.sessionStorage).length} 项`);
  if (data?.cookies) parts.push(`Cookie ${data.cookies.length} 个`);
  return parts.join(' · ') || '无数据';
}

function buildSnapshotFilename(snapshot) {
  let host = 'snapshot';
  try {
    host = new URL(snapshot.source?.url || '').host || 'snapshot';
  } catch {
    /* 保持默认文件名 */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeHost = host.replace(/[^a-z0-9.-]+/gi, '_');
  return `tab-data-sync_${safeHost}_${stamp}.json`;
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ------------------------------------------------------------------ */
/* 跨浏览器：导入                                                      */
/* ------------------------------------------------------------------ */

async function importFromFile() {
  const file = ui.snapshotFile.files?.[0];
  ui.snapshotFile.value = '';
  if (!file) return;

  try {
    if (file.size > MAX_SNAPSHOT_BYTES) {
      throw new Error(`快照文件过大（上限 ${formatBytes(MAX_SNAPSHOT_BYTES)}）`);
    }
    await acceptSnapshotText(await file.text());
  } catch (error) {
    showError(error);
  }
}

async function importFromClipboard() {
  if (busy) return;

  try {
    const text = await navigator.clipboard.readText();
    if (!text) throw new Error('剪贴板为空');
    await acceptSnapshotText(text);
  } catch (error) {
    if (error?.name === 'NotAllowedError') {
      showError(new Error('无法读取剪贴板，请允许剪贴板权限，或改用「选择文件」导入'));
    } else {
      showError(error);
    }
  }
}

async function acceptSnapshotText(text) {
  resetSnapshotState();

  if (text.length > MAX_SNAPSHOT_BYTES) {
    throw new Error(`快照内容过大（上限 ${formatBytes(MAX_SNAPSHOT_BYTES)}）`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 快照');
  }

  if (parsed?.format !== SNAPSHOT_FORMAT) throw new Error('不是本扩展导出的快照');
  if (parsed.version !== SNAPSHOT_VERSION) {
    throw new Error(`不支持的快照版本：${parsed.version}`);
  }

  if (parsed.encrypted) {
    pendingEnvelope = parsed;
    ui.snapshotPreview.hidden = false;
    ui.snapshotPassphrase.hidden = false;
    ui.snapshotPassphrase.value = '';
    ui.snapshotMeta.textContent = '已加密的快照：输入导出时设置的口令后即可导入。';
    ui.importApply.textContent = '解密并导入';
    syncImportButtonState();
    setStatus('info', '快照已加载，等待解密');
    return;
  }

  applySnapshotPreview(parsed);
}

function applySnapshotPreview(snapshot) {
  pendingSnapshot = snapshot;
  pendingEnvelope = null;

  ui.snapshotPreview.hidden = false;
  ui.snapshotPassphrase.hidden = true;
  ui.snapshotPassphrase.value = '';
  ui.importApply.textContent = '导入到目标页面';
  syncImportButtonState();

  const source = snapshot.source || {};
  const browser = BROWSER_LABELS[source.browser] || source.browser || '未知浏览器';
  const created = snapshot.createdAt
    ? new Date(snapshot.createdAt).toLocaleString('zh-CN', { hour12: false })
    : '未知时间';

  ui.snapshotMeta.textContent = [
    `${browser} · ${source.url || '未知页面'}`,
    created,
    describeSnapshotData(snapshot.data)
  ].join(' ｜ ');

  setStatus('info', '快照已加载，点击「导入到目标页面」写入');
  appendLog('info', `已读取快照：${source.origin || source.url || '未知来源'}`);
}

async function applyImport() {
  if (busy) return;

  try {
    let snapshot = pendingSnapshot;

    if (!snapshot) {
      if (!pendingEnvelope) throw new Error('请先选择快照文件，或从剪贴板导入');
      const passphrase = ui.snapshotPassphrase.value;
      if (!passphrase) throw new Error('请输入快照口令');

      setStatus('info', '正在解密…');
      setBusy(true);
      snapshot = await decryptSnapshot(pendingEnvelope, passphrase);
      applySnapshotPreview(snapshot);
    }

    const kinds = collectKinds();
    if (!kinds.length) throw new Error('请至少勾选一项要导入的数据');

    const data = pickSnapshotData(snapshot, kinds);
    if (!Object.keys(data).length) throw new Error('快照里没有勾选类型的数据');

    const target = resolveTargetSpec();

    setBusy(true);
    setStatus('info', '正在写入目标页面…');

    const done = await runRequest('import', {
      target,
      data,
      ...writeOptions()
    });

    handleSummary(done.summary, '导入完成');
  } catch (error) {
    if (pendingEnvelope && !pendingSnapshot && /口令|解密/.test(String(error.message))) {
      ui.snapshotMeta.textContent = '口令不正确或快照已损坏，请重试。';
    }
    showError(error);
  } finally {
    setBusy(false);
  }
}

function pickSnapshotData(snapshot, kinds) {
  const source = snapshot?.data || {};
  const data = {};

  if (kinds.includes('localStorage') && source.localStorage) {
    data.localStorage = source.localStorage;
  }
  if (kinds.includes('sessionStorage') && source.sessionStorage) {
    data.sessionStorage = source.sessionStorage;
  }
  if (kinds.includes('cookie') && Array.isArray(source.cookies)) {
    data.cookies = source.cookies;
  }

  return data;
}

function resetSnapshotState() {
  pendingSnapshot = null;
  pendingEnvelope = null;
  ui.snapshotPreview.hidden = true;
  ui.snapshotMeta.textContent = '';
  ui.snapshotPassphrase.value = '';
  ui.snapshotPassphrase.hidden = true;
  ui.importApply.textContent = '导入到目标页面';
  syncImportButtonState();
}

/* ------------------------------------------------------------------ */
/* 快照加密（WebCrypto: PBKDF2-SHA256 + AES-GCM）                      */
/* ------------------------------------------------------------------ */

async function encryptSnapshot(snapshot, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ['encrypt'], PBKDF2_ITERATIONS);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(snapshot))
  );

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: snapshot.createdAt,
    encrypted: {
      alg: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(cipher))
    }
  };
}

async function decryptSnapshot(envelope, passphrase) {
  const info = envelope?.encrypted;
  if (!info || info.alg !== 'AES-GCM' || info.kdf !== 'PBKDF2-SHA256') {
    throw new Error('不支持的加密方式');
  }

  const iterations = Number(info.iterations);
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 2000000) {
    throw new Error('不支持的加密参数');
  }
  if (
    typeof info.salt !== 'string' ||
    typeof info.iv !== 'string' ||
    typeof info.data !== 'string'
  ) {
    throw new Error('快照加密数据不完整');
  }

  let plain;
  try {
    const key = await deriveKey(passphrase, fromBase64(info.salt), ['decrypt'], iterations);
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(info.iv) },
      key,
      fromBase64(info.data)
    );
  } catch {
    throw new Error('口令不正确，或快照已损坏');
  }

  let snapshot;
  try {
    snapshot = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('快照内容损坏');
  }

  if (snapshot?.format !== SNAPSHOT_FORMAT) throw new Error('解密后的内容不是有效的快照');
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`不支持的快照版本：${snapshot.version}`);
  }

  return snapshot;
}

async function deriveKey(passphrase, salt, usages, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* 公共小工具                                                          */
/* ------------------------------------------------------------------ */

function collectKinds() {
  const kinds = [];
  if (ui.kindLocal.checked) kinds.push('localStorage');
  if (ui.kindSession.checked) kinds.push('sessionStorage');
  if (ui.kindCookie.checked) kinds.push('cookie');
  return kinds;
}

function writeOptions() {
  return {
    storageMode: ui.storageMode.value,
    rewriteCookieDomain: ui.rewriteDomain.checked,
    reloadTarget: ui.reloadTarget.checked
  };
}

function resolveTargetSpec() {
  if (targetMode === 'tab') {
    const tab = selectedTab(ui.targetTab);
    if (!tab) throw new Error('请选择目标标签页');
    return { type: 'tab', tabId: tab.id };
  }

  const url = ui.targetUrl.value.trim();
  if (!url) throw new Error('请输入目标页面 URL');
  return { type: 'url', url };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------------------------------------------ */
/* 设置持久化                                                         */
/* ------------------------------------------------------------------ */

async function saveSettings() {
  const settings = {
    targetMode,
    panelMode,
    kinds: {
      local: ui.kindLocal.checked,
      session: ui.kindSession.checked,
      cookie: ui.kindCookie.checked
    },
    storageMode: ui.storageMode.value,
    rewriteDomain: ui.rewriteDomain.checked,
    reloadTarget: ui.reloadTarget.checked
  };

  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch {
    /* 忽略写入失败，不影响主流程 */
  }
}

async function restoreSettings() {
  let settings;
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    settings = stored[SETTINGS_KEY];
  } catch {
    return;
  }
  if (!settings) return;

  if (settings.kinds) {
    ui.kindLocal.checked = settings.kinds.local !== false;
    ui.kindSession.checked = settings.kinds.session !== false;
    ui.kindCookie.checked = settings.kinds.cookie !== false;
  }
  if (settings.storageMode === 'overwrite') ui.storageMode.value = 'overwrite';
  if (settings.rewriteDomain === false) ui.rewriteDomain.checked = false;
  if (settings.reloadTarget === false) ui.reloadTarget.checked = false;

  setTargetMode(settings.targetMode === 'url' ? 'url' : 'tab');
  setPanelMode(settings.panelMode === 'transfer' ? 'transfer' : 'sync');
}

/* ------------------------------------------------------------------ */

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少元素：${id}`);
  return element;
}
