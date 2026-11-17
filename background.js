'use strict';

importScripts('compat.js');

/**
 * 后台 Service Worker。
 *
 * 支持三类操作（popup 通过 runtime port 发起）：
 * - start    ：源标签页 → 目标页面（站内同步）
 * - snapshot ：源标签页 → 快照对象（用于跨浏览器导出）
 * - import   ：快照数据 → 目标页面（用于跨浏览器导入）
 *
 * Cookie 走 chrome.cookies API（可以读到 HttpOnly Cookie）；
 * Web Storage 走 chrome.scripting 注入脚本，在页面上下文中读写。
 */

const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const STORAGE_AREAS = ['localStorage', 'sessionStorage'];
const SUPPORTED_KINDS = new Set([...STORAGE_AREAS, 'cookie']);
const SNAPSHOT_FORMAT = 'tab-data-sync/snapshot';
const SNAPSHOT_VERSION = 1;
const LOAD_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 150;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sync') return;

  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
  });

  const send = (message) => {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
    }
  };

  port.onMessage.addListener((message) => {
    if (!message || !message.type) return;

    const log = (level, text) => send({ type: 'log', level, message: text });
    const handler = HANDLERS[message.type];

    if (!handler) {
      send({ type: 'done', ok: false, error: `未知操作：${message.type}` });
      return;
    }

    Promise.resolve()
      .then(() => handler(message.payload || {}, log))
      .then((result) => send({ type: 'done', ok: true, ...result }))
      .catch((error) => {
        console.error('[Tab Data Sync]', error);
        send({ type: 'done', ok: false, error: toMessage(error) });
      });
  });
});

const HANDLERS = {
  start: async (payload, log) => ({ summary: await runJob(payload, log) }),
  snapshot: async (payload, log) => ({ snapshot: await buildSnapshot(payload, log) }),
  import: async (payload, log) => ({ summary: await runImport(payload, log) })
};

/* ------------------------------------------------------------------ */
/* 站内同步                                                           */
/* ------------------------------------------------------------------ */

async function runJob(payload, log) {
  const features = prepareFeatures(payload);
  const kinds = normalizeKinds(payload.kinds);
  if (!kinds.length) throw new Error('请至少勾选一项要同步的内容');

  const { sourceTab, data } = await readSourceData(payload.sourceTabId, kinds, features, log);
  const target = await resolveTarget(payload.target, log);

  if (target.tab.id === sourceTab.id) {
    throw new Error('源标签页和目标标签页不能是同一个');
  }

  return writeData(target, data, payload, features, log);
}

/**
 * 每次操作前解析本次可用的可选特性，并切换传输方式。
 * featureMode 来自弹窗设置：auto（默认）| compat（强制兼容）
 */
function prepareFeatures(payload) {
  tdsSetTransportMode(payload.featureMode);
  return tdsResolveFeatures(payload.featureMode);
}

/* ------------------------------------------------------------------ */
/* 跨浏览器快照                                                        */
/* ------------------------------------------------------------------ */

async function buildSnapshot(payload, log) {
  const features = prepareFeatures(payload);
  const kinds = normalizeKinds(payload.kinds);
  if (!kinds.length) throw new Error('请至少选择一项要导出的数据');

  const { sourceUrl, data } = await readSourceData(payload.sourceTabId, kinds, features, log);

  const snapshotData = {};
  for (const area of STORAGE_AREAS) {
    if (data[area]) snapshotData[area] = data[area];
  }

  if (data.cookies) {
    snapshotData.cookies = data.cookies.map(serializeCookie);
    const partitioned = data.cookies.filter((cookie) => cookie.partitionKey).length;
    if (partitioned) {
      log('info', `其中 ${partitioned} 个是分区 Cookie，导入端需要 Chromium 119+`);
    }
  }

  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      browser: detectBrowserName(),
      url: sourceUrl.href,
      origin: sourceUrl.origin
    },
    data: snapshotData
  };

  log('ok', '快照已生成');
  return snapshot;
}

async function runImport(payload, log) {
  const features = prepareFeatures(payload);
  const data = normalizeSnapshotData(payload.data);
  const target = await resolveTarget(payload.target, log);
  return writeData(target, data, payload, features, log);
}

function serializeCookie(cookie) {
  const out = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: Boolean(cookie.hostOnly),
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || 'unspecified'
  };
  if (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
    out.expirationDate = cookie.expirationDate;
  }
  if (cookie.partitionKey) out.partitioned = true;
  return out;
}

function normalizeSnapshotData(raw) {
  if (!isPlainObject(raw)) throw new Error('快照内容无效');

  const data = {};

  for (const area of STORAGE_AREAS) {
    if (raw[area] === undefined) continue;
    const source = raw[area];
    if (!isPlainObject(source)) throw new Error(`快照中的 ${area} 格式无效`);

    const clean = {};
    for (const [key, value] of Object.entries(source)) {
      if (key && typeof value === 'string') clean[key] = value;
    }
    data[area] = clean;
  }

  if (raw.cookies !== undefined) {
    if (!Array.isArray(raw.cookies)) throw new Error('快照中的 Cookie 格式无效');
    data.cookies = raw.cookies.filter(isCookieLike).map(normalizeCookie);
  }

  if (!data.localStorage && !data.sessionStorage && !data.cookies) {
    throw new Error('快照中没有可导入的数据');
  }

  return data;
}

function isCookieLike(cookie) {
  return (
    isPlainObject(cookie) &&
    typeof cookie.name === 'string' &&
    cookie.name !== '' &&
    typeof cookie.value === 'string' &&
    typeof cookie.domain === 'string' &&
    cookie.domain !== ''
  );
}

function normalizeCookie(cookie) {
  const sameSite = ['no_restriction', 'lax', 'strict', 'unspecified'].includes(cookie.sameSite)
    ? cookie.sameSite
    : 'unspecified';

  const out = {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain),
    hostOnly: cookie.hostOnly === true,
    path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite,
    partitioned: cookie.partitioned === true
  };

  if (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
    out.expirationDate = cookie.expirationDate;
  }

  return out;
}

function detectBrowserName() {
  return TDS_ENV.browser;
}

/* ------------------------------------------------------------------ */
/* 读取源页面                                                          */
/* ------------------------------------------------------------------ */

function normalizeKinds(raw) {
  return Array.isArray(raw) ? raw.filter((kind) => SUPPORTED_KINDS.has(kind)) : [];
}

async function readSourceData(sourceTabId, kinds, features, log) {
  const sourceTab = await getTab(Number(sourceTabId));
  const sourceUrl = parseWebUrl(sourceTab.url, '源标签页');
  log('info', `源页面：${sourceUrl.href}`);

  const data = {};

  for (const area of STORAGE_AREAS) {
    if (!kinds.includes(area)) continue;
    const items = await readStorage(sourceTab.id, area);
    data[area] = items;
    log('info', `${area}：从源页面读取到 ${Object.keys(items).length} 项`);
  }

  if (kinds.includes('cookie')) {
    data.cookies = await readCookies(sourceUrl, features, log);
    log('info', `Cookie：从源页面读取到 ${data.cookies.length} 个`);
  }

  return { sourceTab, sourceUrl, data };
}

async function readCookies(sourceUrl, features, log) {
  let cookies;
  try {
    cookies = await callChrome(chrome.cookies, 'getAll', { url: sourceUrl.href });
  } catch (error) {
    throw new Error(`读取源页面 Cookie 失败：${toMessage(error)}`);
  }

  // 分区 Cookie（CHIPS）需要带上 topLevelSite 单独读取，Chromium 119+ 才支持
  if (!features.partitionedCookies) return cookies;

  try {
    const partitioned = await callChrome(chrome.cookies, 'getAll', {
      url: sourceUrl.href,
      partitionKey: { topLevelSite: sourceUrl.origin }
    });

    const seen = new Set(cookies.map(cookieKey));
    let added = 0;
    for (const cookie of partitioned) {
      const key = cookieKey(cookie);
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(cookie);
      added += 1;
    }
    if (added) log('info', `分区 Cookie：额外读取到 ${added} 个`);
  } catch (error) {
    log('warn', `读取分区 Cookie 失败：${toMessage(error)}`);
  }

  return cookies;
}

function cookieKey(cookie) {
  const topLevelSite = cookie.partitionKey ? cookie.partitionKey.topLevelSite : '';
  return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}\u0000${topLevelSite}`;
}

/* ------------------------------------------------------------------ */
/* 写入目标页面                                                        */
/* ------------------------------------------------------------------ */

async function writeData(target, data, options, features, log) {
  const summary = {
    tabId: target.tab.id,
    target: target.url.href,
    storage: {},
    cookies: null,
    warnings: []
  };

  for (const area of STORAGE_AREAS) {
    if (!data[area]) continue;

    const read = Object.keys(data[area]).length;
    if (!read) {
      summary.storage[area] = { read: 0, written: 0 };
      continue;
    }

    const mode = options.storageMode === 'overwrite' ? 'overwrite' : 'merge';
    const result = await writeStorage(target.tab.id, area, data[area], mode);
    summary.storage[area] = { read, written: result.written, total: result.total };

    const cleared = mode === 'overwrite' ? '，已先清空目标旧数据' : '';
    log('ok', `${area}：写入 ${result.written} 项（目标页面现在共 ${result.total} 项${cleared}）`);
  }

  if (data.cookies) {
    summary.cookies = await writeCookies(
      data.cookies,
      target.url,
      options,
      features,
      summary.warnings,
      log
    );
  }

  const hasLocal = summary.storage.localStorage?.written > 0;
  const hasSession = summary.storage.sessionStorage?.written > 0;
  const hasCookie = summary.cookies?.written > 0;

  if (options.reloadTarget !== false && (hasLocal || hasSession || hasCookie)) {
    log('info', '刷新目标页面以让页面读取最新数据…');
    try {
      await callChrome(chrome.tabs, 'reload', target.tab.id);
    } catch (error) {
      summary.warnings.push(`刷新目标页面失败：${toMessage(error)}`);
      log('warn', `刷新目标页面失败：${toMessage(error)}`);
    }
  }

  return summary;
}

/* ------------------------------------------------------------------ */
/* 目标页面的解析                                                      */
/* ------------------------------------------------------------------ */

async function resolveTarget(target, log) {
  if (target && target.type === 'tab') {
    const tab = await getTab(Number(target.tabId));
    const url = parseWebUrl(tab.url, '目标标签页');

    if (tab.status !== 'complete') {
      log('info', '等待目标标签页加载完成…');
      const loaded = await waitForTabLoad(tab.id);
      return { tab: loaded, url: parseWebUrl(loaded.url, '目标标签页') };
    }
    return { tab, url };
  }

  if (!target || target.type !== 'url') {
    throw new Error('请选择目标页面');
  }

  const href = normalizeTargetUrl(target.url);
  log('info', `在后台打开目标页面：${href}`);

  // 用 active:false 打开，避免抢走焦点导致 popup 被关闭
  const tab = await callChrome(chrome.tabs, 'create', { url: href, active: false });
  if (tab.id === undefined) throw new Error('无法创建目标标签页');

  const loaded = await waitForTabLoad(tab.id);
  const url = parseWebUrl(loaded.url, '目标标签页');
  log('info', `目标页面已加载：${url.href}`);
  return { tab: loaded, url };
}

async function waitForTabLoad(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await callChrome(chrome.tabs, 'get', tabId);
    } catch {
      throw new Error('目标标签页已被关闭');
    }
    if (tab.status === 'complete' && tab.url) return tab;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('等待目标页面加载超时，请手动打开该页面后重试');
}

/* ------------------------------------------------------------------ */
/* Web Storage                                                        */
/* ------------------------------------------------------------------ */

async function readStorage(tabId, area) {
  const [injection] = await callChrome(chrome.scripting, 'executeScript', {
    target: { tabId },
    func: (areaName) => {
      const store = areaName === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      const data = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) data[key] = store.getItem(key);
      }
      return data;
    },
    args: [area]
  });

  return injection?.result ?? {};
}

async function writeStorage(tabId, area, items, mode) {
  const [injection] = await callChrome(chrome.scripting, 'executeScript', {
    target: { tabId },
    func: (areaName, data, writeMode) => {
      const store = areaName === 'sessionStorage' ? window.sessionStorage : window.localStorage;
      if (writeMode === 'overwrite') store.clear();
      let written = 0;
      for (const [key, value] of Object.entries(data)) {
        store.setItem(key, value);
        written += 1;
      }
      return { written, total: store.length };
    },
    args: [area, items, mode]
  });

  return injection?.result ?? { written: 0, total: 0 };
}

/* ------------------------------------------------------------------ */
/* Cookie                                                             */
/* ------------------------------------------------------------------ */

async function writeCookies(cookies, targetUrl, options, features, warnings, log) {
  const result = { read: cookies.length, written: 0, failed: 0, skipped: 0 };
  const rewrite = options.rewriteCookieDomain !== false;

  for (const cookie of cookies) {
    const built = buildCookieDetails(cookie, targetUrl, rewrite, features);
    if (built.skip) {
      result.skipped += 1;
      warnings.push(built.skip);
      continue;
    }

    try {
      const stored = await callChrome(chrome.cookies, 'set', built.details);
      if (stored) {
        result.written += 1;
      } else {
        result.failed += 1;
        warnings.push(`Cookie「${cookie.name}」写入失败：被浏览器拒绝`);
      }
    } catch (error) {
      result.failed += 1;
      warnings.push(`Cookie「${cookie.name}」写入失败：${toMessage(error)}`);
    }
  }

  const parts = [`写入 ${result.written} 个`];
  if (result.failed) parts.push(`失败 ${result.failed} 个`);
  if (result.skipped) parts.push(`跳过 ${result.skipped} 个`);
  log(result.failed ? 'warn' : 'ok', `Cookie：${parts.join('，')}`);

  return result;
}

function buildCookieDetails(cookie, targetUrl, rewrite, features) {
  const host = targetUrl.hostname;
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
  const partitioned = Boolean(cookie.partitionKey || cookie.partitioned);

  if (partitioned) {
    if (!features.partitionedCookies) {
      return {
        skip: `跳过分区 Cookie「${cookie.name}」：需要 Chromium 119+（当前浏览器不支持 CHIPS）`
      };
    }
    if (targetUrl.protocol !== 'https:') {
      return {
        skip: `跳过分区 Cookie「${cookie.name}」：分区 Cookie 必须写入 HTTPS 站点`
      };
    }
  }

  const matchesTarget = cookie.hostOnly
    ? host === cookie.domain
    : domainMatches(host, cookie.domain);

  // 域名和目标站点一致时保留原始的 domain 范围（含 .example.com 这类父域 Cookie）
  if (!matchesTarget && !rewrite) {
    return {
      skip: `跳过 Cookie「${cookie.name}」：域名 ${cookie.domain} 与目标站点 ${host} 不匹配（可勾选“Cookie 域名不匹配时改写为目标站点”）`
    };
  }

  const secure = Boolean(cookie.secure) && targetUrl.protocol === 'https:';

  const details = {
    // url 同时决定 cookie 的默认 domain/path，并用于校验 secure 属性
    url: `${targetUrl.protocol}//${targetUrl.host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure,
    httpOnly: Boolean(cookie.httpOnly)
  };

  if (!cookie.hostOnly && matchesTarget) details.domain = cookie.domain;
  if (typeof cookie.expirationDate === 'number') details.expirationDate = cookie.expirationDate;
  if (partitioned) details.partitionKey = { topLevelSite: targetUrl.origin };

  // SameSite=None 必须搭配 Secure，目标站点是 http 时降级为 Lax
  if (cookie.sameSite === 'no_restriction') {
    details.sameSite = secure ? 'no_restriction' : 'lax';
  } else if (cookie.sameSite === 'lax' || cookie.sameSite === 'strict') {
    details.sameSite = cookie.sameSite;
  }

  return { details };
}

function domainMatches(host, domain) {
  const base = domain.startsWith('.') ? domain.slice(1) : domain;
  return host === base || host.endsWith(`.${base}`);
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                           */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function getTab(tabId) {
  return callChrome(chrome.tabs, 'get', tabId).catch(() => {
    throw new Error('标签页已关闭，请刷新列表后重试');
  });
}

function parseWebUrl(raw, label = '页面') {
  let parsed;
  try {
    parsed = new URL(raw || '');
  } catch {
    throw new Error(`${label}地址无效：${raw || '（空）'}`);
  }
  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${label}是 ${parsed.protocol} 页面，扩展只能处理 http/https 页面`);
  }
  return parsed;
}

function normalizeTargetUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('请输入目标页面 URL');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = parseWebUrl(withScheme, '目标页面');
  return parsed.href;
}
