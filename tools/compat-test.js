'use strict';

/**
 * 环境兼容测试（不启动浏览器）：
 *
 * 1) 模拟 Edge 92（Chromium 92，早期 MV3）：
 *    - chrome.* 只有回调形式、没有 Promise
 *    - 分区 Cookie 不支持
 * 2) 模拟 Chrome 122+：
 *    - chrome.* 支持 Promise
 *    - 支持分区 Cookie（CHIPS）
 *    - 兼容模式设置可以强制回退到回调
 *
 * 用法：node tools/compat-test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UA_EDGE_92 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36 Edg/92.0.902.62';
const UA_CHROME_122 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  (${detail})` : ''}`);
}

class FakeStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }
  get length() {
    return this.map.size;
  }
  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  clear() {
    this.map.clear();
  }
}

function createPage(entries = {}) {
  const page = {
    localStorage: new FakeStorage(entries.localStorage),
    sessionStorage: new FakeStorage(entries.sessionStorage)
  };
  page.window = { localStorage: page.localStorage, sessionStorage: page.sessionStorage };
  return page;
}

function cookieKey(cookie) {
  const topLevelSite = cookie.partitionKey ? cookie.partitionKey.topLevelSite : '';
  return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}\u0000${topLevelSite}`;
}

/**
 * 模拟 chrome.*：
 * - 传了回调 → 回调形式（不会返回 Promise）
 * - 没传回调 → 返回 Promise（模拟 Chrome 122+）
 */
function createChromeMock(sandbox) {
  const state = {
    tabs: new Map(),
    pages: new Map(),
    cookies: new Map(),
    reloaded: [],
    nextTabId: 100
  };

  let chromeMock;

  const later = (fn) => setTimeout(fn, 0);

  function fail(callback, message) {
    chromeMock.runtime.lastError = { message };
    try {
      if (callback) callback();
    } finally {
      chromeMock.runtime.lastError = undefined;
    }
  }

  function reply(callback, value) {
    chromeMock.runtime.lastError = undefined;
    if (callback) callback(value);
  }

  function dual(handler) {
    return function (...rawArgs) {
      const args = rawArgs.slice();
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;

      if (callback) {
        later(() => {
          handler(args, (error, value) => {
            if (error) fail(callback, error.message);
            else reply(callback, value);
          });
        });
        return undefined;
      }

      return new Promise((resolve, reject) => {
        later(() => {
          handler(args, (error, value) => {
            if (error) reject(new Error(error.message));
            else resolve(value);
          });
        });
      });
    };
  }

  function addTab(id, url, entries, title) {
    const tab = { id, url, title: title || url, status: 'complete', active: false };
    state.tabs.set(id, tab);
    state.pages.set(id, createPage(entries));
    return tab;
  }

  const tabs = {
    get: dual(([tabId], done) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return done(new Error(`No tab with id: ${tabId}`));
      done(null, { ...tab });
    }),
    query: dual((_args, done) => {
      done(null, Array.from(state.tabs.values()).map((tab) => ({ ...tab })));
    }),
    create: dual(([props], done) => {
      const id = state.nextTabId++;
      const tab = addTab(id, props.url, {});
      done(null, { ...tab });
    }),
    update: dual(([tabId, props], done) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return done(new Error(`No tab with id: ${tabId}`));
      Object.assign(tab, props);
      done(null, { ...tab });
    }),
    reload: dual(([tabId], done) => {
      state.reloaded.push(tabId);
      done(null);
    })
  };

  const cookies = {
    getAll: dual(([details], done) => {
      const host = new URL(details.url).hostname;
      const topLevelSite = details.partitionKey ? details.partitionKey.topLevelSite : null;

      const list = Array.from(state.cookies.values())
        .filter((cookie) => {
          const base = cookie.domain.replace(/^\./, '');
          if (host !== base && !host.endsWith(`.${base}`)) return false;
          const cookieTop = cookie.partitionKey ? cookie.partitionKey.topLevelSite : null;
          return cookieTop === topLevelSite;
        })
        .map((cookie) => ({ ...cookie }));

      done(null, list);
    }),
    set: dual(([details], done) => {
      let parsed;
      try {
        parsed = new URL(details.url);
      } catch {
        return done(new Error('Invalid url'));
      }

      const host = parsed.hostname;
      const domain = details.domain || host;
      const base = domain.replace(/^\./, '');
      if (host !== base && !host.endsWith(`.${base}`)) {
        return done(new Error(`Failed to parse or set cookie named "${details.name}".`));
      }
      if (details.partitionKey && !details.secure) {
        return done(new Error('Partitioned cookie must be secure'));
      }

      const cookie = {
        name: details.name,
        value: details.value,
        domain,
        hostOnly: !details.domain,
        path: details.path || '/',
        secure: Boolean(details.secure),
        httpOnly: Boolean(details.httpOnly),
        sameSite: details.sameSite || 'unspecified',
        session: details.expirationDate === undefined
      };
      if (details.expirationDate !== undefined) cookie.expirationDate = details.expirationDate;
      if (details.partitionKey) cookie.partitionKey = { topLevelSite: details.partitionKey.topLevelSite };

      state.cookies.set(cookieKey(cookie), cookie);
      done(null, { ...cookie });
    })
  };

  const scripting = {
    executeScript: dual(([injection], done) => {
      const page = state.pages.get(injection.target.tabId);
      if (!page) return done(new Error(`No tab with id: ${injection.target.tabId}`));

      const previousWindow = sandbox.window;
      sandbox.window = page.window;
      try {
        const result = injection.func(...(injection.args || []));
        done(null, [{ frameId: 0, result }]);
      } catch (error) {
        done(error);
      } finally {
        sandbox.window = previousWindow;
      }
    })
  };

  chromeMock = {
    runtime: {
      lastError: undefined,
      onConnect: { listeners: [], addListener(listener) { this.listeners.push(listener); } }
    },
    tabs,
    cookies,
    scripting
  };

  return { chrome: chromeMock, state, addTab };
}

function createHarness(userAgent) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    navigator: { userAgent }
  };

  const mock = createChromeMock(sandbox);
  sandbox.chrome = mock.chrome;

  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(code, context, { filename: file });
    }
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, {
    filename: 'background.js'
  });

  const messages = [];
  const port = {
    name: 'sync',
    onDisconnect: { listeners: [], addListener(listener) { this.listeners.push(listener); } },
    onMessage: { listeners: [], addListener(listener) { this.listeners.push(listener); } },
    postMessage(message) {
      messages.push(message);
    },
    disconnect() {
      this.onDisconnect.listeners.forEach((listener) => listener());
    }
  };
  mock.chrome.runtime.onConnect.listeners.forEach((listener) => listener(port));

  function request(type, payload) {
    const start = messages.length;
    port.onMessage.listeners.forEach((listener) => listener({ type, payload }));

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        const done = messages.slice(start).find((message) => message.type === 'done');
        if (done) {
          clearInterval(timer);
          if (done.ok) resolve(done);
          else reject(new Error(done.error));
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`等待 ${type} 结果超时`));
        }
      }, 10);
    });
  }

  return { sandbox, mock, request };
}

const PARTITIONED_SNAPSHOT_COOKIE = {
  name: 'chip',
  value: 'p',
  domain: 'localhost',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'no_restriction',
  partitioned: true
};

/* ------------------------------------------------------------------ */
/* Edge 92：回调 + 无分区 Cookie                                       */
/* ------------------------------------------------------------------ */

async function testEdge92() {
  const harness = createHarness(UA_EDGE_92);
  const { sandbox, mock, request } = harness;

  check(
    'Edge 92：识别浏览器与版本',
    sandbox.TDS_ENV.browser === 'edge' && sandbox.TDS_ENV.version === 92,
    JSON.stringify(sandbox.TDS_ENV.features)
  );
  check('Edge 92：使用回调传输', sandbox.tdsTransportInUse() === 'callback');
  check(
    'Edge 92：分区 Cookie 关闭',
    sandbox.tdsResolveFeatures('auto').partitionedCookies === false
  );

  mock.addTab(1, 'http://localhost:8801/', {
    localStorage: { token: 'compat-token', theme: 'dark' },
    sessionStorage: { flow: 'step-1' }
  });
  mock.addTab(2, 'http://127.0.0.1:8802/', {});

  for (const cookie of [
    { name: 'sid', value: 's-1', domain: 'localhost', hostOnly: true, path: '/', secure: false, httpOnly: true, sameSite: 'lax' },
    { name: 'theme', value: 'dark', domain: 'localhost', hostOnly: true, path: '/', secure: false, httpOnly: false, sameSite: 'lax' }
  ]) {
    mock.state.cookies.set(cookieKey(cookie), cookie);
  }

  const sync = await request('start', {
    sourceTabId: 1,
    target: { type: 'tab', tabId: 2 },
    kinds: ['localStorage', 'sessionStorage', 'cookie'],
    storageMode: 'merge',
    rewriteCookieDomain: true,
    reloadTarget: true
  });

  const targetPage = mock.state.pages.get(2);
  check(
    'Edge 92：同步结果正确',
    sync.summary.storage.localStorage.written === 2 &&
      sync.summary.storage.sessionStorage.written === 1 &&
      sync.summary.cookies.written === 2,
    JSON.stringify(sync.summary)
  );
  check(
    'Edge 92：目标存储已写入',
    targetPage.localStorage.getItem('token') === 'compat-token' &&
      targetPage.sessionStorage.getItem('flow') === 'step-1'
  );
  check(
    'Edge 92：Cookie 已跨域改写',
    Array.from(mock.state.cookies.values()).some(
      (cookie) => cookie.domain === '127.0.0.1' && cookie.name === 'sid' && cookie.value === 's-1'
    )
  );
  check('Edge 92：目标页已刷新', mock.state.reloaded.includes(2));

  const snapshot = await request('snapshot', {
    sourceTabId: 1,
    kinds: ['localStorage', 'sessionStorage', 'cookie']
  });
  check(
    'Edge 92：快照格式正确',
    snapshot.snapshot.format === 'tab-data-sync/snapshot' &&
      snapshot.snapshot.version === 1 &&
      snapshot.snapshot.source.browser === 'edge' &&
      snapshot.snapshot.data.cookies.length === 2,
    JSON.stringify(snapshot.snapshot.source)
  );

  // 导入来自新版浏览器的快照（含分区 Cookie）时，旧版本应跳过它
  const importData = {
    ...snapshot.snapshot.data,
    cookies: [...snapshot.snapshot.data.cookies, PARTITIONED_SNAPSHOT_COOKIE]
  };
  targetPage.localStorage.setItem('extra', 'keep-me');
  const imported = await request('import', {
    target: { type: 'tab', tabId: 2 },
    data: importData,
    storageMode: 'overwrite',
    rewriteCookieDomain: true,
    reloadTarget: false
  });

  check(
    'Edge 92：快照导入正确',
    imported.summary.storage.localStorage.written === 2 &&
      targetPage.localStorage.getItem('extra') === null &&
      targetPage.localStorage.getItem('token') === 'compat-token',
    JSON.stringify(imported.summary.storage)
  );
  check(
    'Edge 92：导入时跳过分区 Cookie',
    imported.summary.cookies.skipped === 1 &&
      !Array.from(mock.state.cookies.values()).some(
        (cookie) => cookie.name === 'chip' && cookie.domain === '127.0.0.1'
      ),
    JSON.stringify(imported.summary.cookies)
  );

  const urlMode = await request('start', {
    sourceTabId: 1,
    target: { type: 'url', url: 'http://127.0.0.1:8802/next' },
    kinds: ['localStorage'],
    storageMode: 'merge',
    rewriteCookieDomain: true,
    reloadTarget: false
  });
  const createdTab = mock.state.tabs.get(urlMode.summary.tabId);
  check(
    'Edge 92：URL 模式可用',
    Boolean(createdTab) &&
      createdTab.url === 'http://127.0.0.1:8802/next' &&
      mock.state.pages.get(createdTab.id).localStorage.getItem('token') === 'compat-token'
  );

  let errorMessage = '';
  try {
    await request('start', {
      sourceTabId: 999,
      target: { type: 'tab', tabId: 2 },
      kinds: ['localStorage']
    });
  } catch (error) {
    errorMessage = error.message;
  }
  check('Edge 92：错误能正确抛出', errorMessage.includes('标签页已关闭'), errorMessage);
}

/* ------------------------------------------------------------------ */
/* Chrome 122+：Promise + 分区 Cookie                                  */
/* ------------------------------------------------------------------ */

async function testChrome122() {
  const { sandbox, mock, request } = createHarness(UA_CHROME_122);

  check(
    'Chrome 122：识别浏览器与版本',
    sandbox.TDS_ENV.browser === 'chrome' && sandbox.TDS_ENV.version === 122,
    JSON.stringify(sandbox.TDS_ENV.features)
  );
  check('Chrome 122：使用 Promise 传输', sandbox.tdsTransportInUse() === 'promise');
  check(
    'Chrome 122：分区 Cookie 开启',
    sandbox.tdsResolveFeatures('auto').partitionedCookies === true
  );
  check(
    '兼容设置关闭分区 Cookie',
    sandbox.tdsResolveFeatures('compat').partitionedCookies === false
  );

  // Promise 路径：调用时不应该再附加回调
  let promiseArgs = null;
  const promiseResult = await sandbox.callChrome(
    {
      ping(...args) {
        promiseArgs = args;
        return Promise.resolve('pong');
      }
    },
    'ping',
    1,
    'a'
  );
  check(
    'Chrome 122：callChrome 走 Promise 且不附加回调',
    promiseResult === 'pong' && Array.isArray(promiseArgs) && promiseArgs.length === 2,
    JSON.stringify(promiseArgs)
  );

  // 兼容模式：强制回退到回调
  sandbox.tdsSetTransportMode('compat');
  const callbackResult = await sandbox.callChrome(
    {
      ping(value, callback) {
        setTimeout(() => callback(`${value}!`), 0);
      }
    },
    'ping',
    'x'
  );
  check('兼容模式：强制使用回调', callbackResult === 'x!');
  sandbox.tdsSetTransportMode('auto');

  // 分区 Cookie：源站 https，目标站 https，应带 topLevelSite 写入
  mock.addTab(1, 'https://source.example.com/', { localStorage: { token: 'p-token' } });
  mock.addTab(2, 'https://target.example.com/', {});

  for (const cookie of [
    {
      name: 'sid',
      value: 's-1',
      domain: 'source.example.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    },
    {
      name: 'chip',
      value: 'p-1',
      domain: 'source.example.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      partitionKey: { topLevelSite: 'https://source.example.com' }
    }
  ]) {
    mock.state.cookies.set(cookieKey(cookie), cookie);
  }

  const sync = await request('start', {
    sourceTabId: 1,
    target: { type: 'tab', tabId: 2 },
    kinds: ['cookie'],
    storageMode: 'merge',
    rewriteCookieDomain: true,
    reloadTarget: false
  });

  const written = Array.from(mock.state.cookies.values()).filter(
    (cookie) => cookie.domain === 'target.example.com'
  );
  const partitioned = written.find((cookie) => cookie.name === 'chip');

  check(
    'Chrome 122：同步使用 Promise 完成',
    sync.summary.cookies.read === 2 &&
      sync.summary.cookies.written === 2 &&
      sync.summary.cookies.failed === 0,
    JSON.stringify(sync.summary.cookies)
  );
  check(
    'Chrome 122：分区 Cookie 带 topLevelSite 写入',
    Boolean(partitioned) &&
      partitioned.partitionKey &&
      partitioned.partitionKey.topLevelSite === 'https://target.example.com',
    JSON.stringify(partitioned)
  );
}

async function main() {
  await testEdge92();
  await testChrome122();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n> ${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('\n兼容测试异常：', error);
  process.exit(2);
});
