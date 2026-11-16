'use strict';

/**
 * 端到端冒烟测试（Edge / Chromium / Chrome for Testing）。
 * 品牌版 Chrome 137+ 已移除 --load-extension，无法用这种方式加载未打包扩展。
 *
 * 会启动一个 headless 浏览器（独立临时 profile），加载本扩展，然后：
 * 1) 建两个不同 host 的测试页（localhost:8801 / 127.0.0.1:8802）
 * 2) 调用 Service Worker 里的 runJob，验证 Cookie / localStorage / sessionStorage 跨站复制
 * 3) 驱动 popup 页面点击「开始同步」，验证弹窗 ↔ 后台链路
 *
 * 用法：
 *   node tools/smoke-test.js [浏览器路径] [扩展目录]
 *   默认浏览器：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
 *   默认扩展目录：项目根目录
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BROWSER =
  process.argv[2] ||
  process.env.BROWSER_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_DIR = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const PROFILE = path.join(os.tmpdir(), `tds-smoke-${process.pid}`);
const DEBUG_PORT = 9333;
const SOURCE_PORT = 8801;
const TARGET_PORT = 8802;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`执行失败：${description}`);
    }
    return response.result.value;
  }

  close() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function serve(port, name, withCookies = true) {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (withCookies) {
        headers['Set-Cookie'] = [
          `srv_session=${name}-httpOnly; Path=/; HttpOnly; SameSite=Lax`,
          `srv_theme=${name}-theme; Path=/; SameSite=Lax`
        ];
      }
      res.writeHead(200, headers);
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1></body></html>`
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function getJson(url) {
  return (await fetch(url)).json();
}

function stripCookies(list) {
  return list
    .map((c) => `${c.name}=${c.value}@${c.domain}${c.path}${c.secure ? ';secure' : ''}`)
    .sort();
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const sourceServer = await serve(SOURCE_PORT, 'source', true);
  const targetServer = await serve(TARGET_PORT, 'target', false);

  const browserProcess = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let browser;
  let sw;
  const pages = [];

  async function attach(target) {
    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();
    pages.push(cdp);
    return cdp;
  }

  async function findPageTarget(prefix) {
    return waitFor(async () => {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      return (
        list.find(
          (t) =>
            t.type === 'page' &&
            t.url.startsWith(prefix) &&
            t.url !== 'chrome-extension://invalid/' &&
            t.webSocketDebuggerUrl
        ) || null
      );
    }, 15000, `页面 target: ${prefix}`);
  }

  async function createTab(url) {
    const response = await fetch(
      `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' }
    );
    return response.json();
  }

  try {
    await waitFor(async () => {
      try {
        return await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      } catch {
        return null;
      }
    }, 20000, '调试端口');

    const version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.connect();

    // --- 1. 通过 chrome://extensions 取得扩展 ID ---
    const extTarget = await createTab('chrome://extensions');
    const extPage = await attach(extTarget);
    await waitFor(async () => (await extPage.evaluate('document.readyState')) === 'complete', 15000, '扩展页加载');
    const extInfo = await extPage.evaluate(`(async () => {
      const list = await new Promise((resolve) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve));
      return JSON.stringify(list.map((e) => ({ id: e.id, name: e.name, state: e.state, path: e.path })));
    })()`);
    const extensions = JSON.parse(extInfo);
    const own = extensions.find((e) => e.name.includes('Tab Data Sync'));
    check('扩展已加载', Boolean(own), extInfo);
    if (!own) throw new Error('扩展没有被加载');

    // --- 2. 打开 popup 页面（同时唤醒 Service Worker） ---
    const popupTarget = await createTab(`chrome-extension://${own.id}/popup.html`);
    const popupPage = await attach(popupTarget);
    await waitFor(async () => (await popupPage.evaluate('document.readyState')) === 'complete', 15000, 'popup 加载');
    await waitFor(
      async () => (await popupPage.evaluate(`document.getElementById('sourceTab').options.length`)) > 0,
      10000,
      'popup 标签页列表'
    );

    // --- 3. 找到本扩展的 Service Worker ---
    const swTarget = await waitFor(async () => {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      return (
        list.find(
          (t) =>
            t.type === 'service_worker' &&
            t.url.includes(own.id) &&
            t.url.includes('background.js')
        ) || null
      );
    }, 15000, '扩展 Service Worker');
    sw = await attach(swTarget);

    // --- 4. 准备源 / 目标标签页 ---
    const sourceTabId = await sw.evaluate(
      `chrome.tabs.create({ url: 'http://localhost:${SOURCE_PORT}/', active: false }).then((t) => t.id)`
    );
    const targetTabId = await sw.evaluate(
      `chrome.tabs.create({ url: 'http://127.0.0.1:${TARGET_PORT}/', active: false }).then((t) => t.id)`
    );
    check('创建测试标签页', Boolean(sourceTabId && targetTabId), `${sourceTabId} / ${targetTabId}`);

    async function waitTabLoad(tabId, label) {
      await waitFor(async () => {
        const tab = await sw.evaluate(
          `chrome.tabs.get(${tabId}).then((t) => ({ status: t.status, url: t.url }))`
        );
        return tab.status === 'complete' ? tab : null;
      }, 15000, label);
    }
    await waitTabLoad(sourceTabId, '源页面加载');
    await waitTabLoad(targetTabId, '目标页面加载');

    const sourcePage = await attach(await findPageTarget(`http://localhost:${SOURCE_PORT}`));
    const targetPage = await attach(await findPageTarget(`http://127.0.0.1:${TARGET_PORT}`));

    const sourceSetup = await sourcePage.evaluate(`(() => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('token', 'local-token-1');
      localStorage.setItem('theme', 'dark');
      sessionStorage.setItem('flow', 'step-2');
      document.cookie = 'js_cookie=from-js; path=/';
      return {
        local: Object.keys(localStorage).sort().join(','),
        session: sessionStorage.getItem('flow'),
        cookie: document.cookie
      };
    })()`);
    check(
      '源页面数据写入',
      sourceSetup.local === 'theme,token' && sourceSetup.session === 'step-2',
      JSON.stringify(sourceSetup)
    );

    const sourceCookies = await sw.evaluate(
      `chrome.cookies.getAll({ url: 'http://localhost:${SOURCE_PORT}/' })`
    );
    check(
      '源页面 Cookie 就绪',
      stripCookies(sourceCookies).some((c) => c.startsWith('srv_session=source-httpOnly@localhost/')),
      JSON.stringify(stripCookies(sourceCookies))
    );

    // --- 5. 直接调用 runJob：三类数据 + 自动刷新 ---
    const run = await sw.evaluate(`(async () => {
      const logs = [];
      const result = await runJob({
        sourceTabId: ${sourceTabId},
        target: { type: 'tab', tabId: ${targetTabId} },
        kinds: ['localStorage', 'sessionStorage', 'cookie'],
        storageMode: 'merge',
        rewriteCookieDomain: true,
        reloadTarget: true
      }, (level, message) => logs.push(level + ': ' + message));
      return { result, logs };
    })()`);

    check('runJob 完成', Boolean(run && run.result), JSON.stringify(run && run.result));

    await sleep(1500);
    await waitTabLoad(targetTabId, '目标页面刷新');

    const targetCookieList = await sw.evaluate(
      `chrome.cookies.getAll({ url: 'http://127.0.0.1:${TARGET_PORT}/' })`
    );
    const cookies = stripCookies(targetCookieList);
    check(
      'Cookie 已复制到目标 host',
      [
        'js_cookie=from-js@127.0.0.1/',
        'srv_session=source-httpOnly@127.0.0.1/',
        'srv_theme=source-theme@127.0.0.1/'
      ].every((c) => cookies.includes(c)),
      JSON.stringify(cookies)
    );
    check(
      'HttpOnly Cookie 被保留',
      targetCookieList.some((c) => c.name === 'srv_session' && c.httpOnly === true),
      JSON.stringify(targetCookieList.find((c) => c.name === 'srv_session') || null)
    );

    const targetData = await targetPage.evaluate(`(() => ({
      local: { token: localStorage.getItem('token'), theme: localStorage.getItem('theme') },
      session: sessionStorage.getItem('flow'),
      cookie: document.cookie
    }))()`);
    check(
      'localStorage 已写入',
      targetData.local.token === 'local-token-1' && targetData.local.theme === 'dark',
      JSON.stringify(targetData.local)
    );
    check('sessionStorage 已写入', targetData.session === 'step-2', targetData.session);
    check(
      '目标页面 document.cookie 可见',
      targetData.cookie.includes('js_cookie=from-js'),
      targetData.cookie
    );

    // --- 6. 覆盖模式 ---
    await targetPage.evaluate(`localStorage.setItem('extra', 'keep-me')`);
    const overwrite = await sw.evaluate(`(async () => runJob({
      sourceTabId: ${sourceTabId},
      target: { type: 'tab', tabId: ${targetTabId} },
      kinds: ['localStorage'],
      storageMode: 'overwrite',
      rewriteCookieDomain: true,
      reloadTarget: false
    }, () => {}))()`);
    await sleep(300);
    const afterOverwrite = JSON.parse(
      await targetPage.evaluate(
        `JSON.stringify({ extra: localStorage.getItem('extra'), token: localStorage.getItem('token') })`
      )
    );
    check(
      '覆盖模式清空目标旧键',
      afterOverwrite.extra === null &&
        afterOverwrite.token === 'local-token-1' &&
        overwrite.storage.localStorage.written === 2,
      JSON.stringify(afterOverwrite)
    );

    // --- 7. URL 模式（后台新开标签页） ---
    const urlMode = await sw.evaluate(`(async () => {
      const result = await runJob({
        sourceTabId: ${sourceTabId},
        target: { type: 'url', url: 'http://127.0.0.1:${TARGET_PORT}/' },
        kinds: ['localStorage', 'cookie'],
        storageMode: 'merge',
        rewriteCookieDomain: true,
        reloadTarget: true
      }, () => {});
      const tab = await chrome.tabs.get(result.tabId);
      return { result, active: tab.active, url: tab.url };
    })()`);
    check(
      'URL 模式以后台标签页完成',
      Boolean(urlMode?.result?.tabId) &&
        urlMode.active === false &&
        urlMode.url.startsWith('http://127.0.0.1'),
      JSON.stringify(urlMode)
    );

    // --- 8. 关闭域名改写时跨站 Cookie 应被跳过 ---
    const skipMode = await sw.evaluate(`(async () => runJob({
      sourceTabId: ${sourceTabId},
      target: { type: 'tab', tabId: ${targetTabId} },
      kinds: ['cookie'],
      storageMode: 'merge',
      rewriteCookieDomain: false,
      reloadTarget: false
    }, () => {}))()`);
    check(
      '关闭域名改写时跨站 Cookie 被跳过',
      skipMode.cookies.skipped > 0 && skipMode.cookies.written === 0,
      JSON.stringify(skipMode.cookies)
    );

    // --- 9. 通过 popup UI 完整走一遍 ---
    await targetPage.evaluate(`localStorage.clear(); sessionStorage.clear()`);
    await sourcePage.evaluate(
      `localStorage.setItem('ui_marker', 'ui-ok'); sessionStorage.setItem('ui_sess', 's1');`
    );
    // popup 是在测试标签页创建之前打开的，先点一次刷新列表（真实使用路径）
    await popupPage.evaluate(`document.getElementById('refreshTabs').click()`);
    await waitFor(
      async () =>
        (await popupPage.evaluate(`
          Array.from(document.getElementById('targetTab').options).some((o) => o.value === '${targetTabId}')
        `)) === true,
      10000,
      'popup 目标列表'
    );

    await popupPage.evaluate(`(() => {
      const source = document.getElementById('sourceTab');
      source.value = '${sourceTabId}';
      source.dispatchEvent(new Event('change'));
      const target = document.getElementById('targetTab');
      target.value = '${targetTabId}';
      target.dispatchEvent(new Event('change'));
      document.getElementById('reloadTarget').checked = false;
      document.getElementById('kindLocal').checked = true;
      document.getElementById('kindSession').checked = true;
      document.getElementById('kindCookie').checked = true;
      document.getElementById('run').click();
      return true;
    })()`);

    let popupStatus;
    try {
      popupStatus = await waitFor(async () => {
        const status = await popupPage.evaluate(
          `document.getElementById('status').textContent`
        );
        if (!status) return null;
        return status.includes('同步完成') || status.includes('失败') ? status : null;
      }, 15000, 'popup 同步完成');
    } catch (error) {
      const debug = await popupPage.evaluate(`JSON.stringify({
        status: document.getElementById('status').textContent,
        log: document.getElementById('log').textContent,
        source: document.getElementById('sourceTab').value,
        target: document.getElementById('targetTab').value,
        targetMode: typeof targetMode !== 'undefined' ? targetMode : 'n/a',
        options: Array.from(document.getElementById('targetTab').options).map((o) => o.value)
      })`);
      throw new Error(`${error.message} => ${debug}`);
    }

    check(
      'popup 点击同步成功',
      popupStatus.includes('同步完成') && popupStatus.includes('localStorage'),
      popupStatus
    );

    const uiResult = JSON.parse(
      await targetPage.evaluate(
        `JSON.stringify({ local: localStorage.getItem('ui_marker'), session: sessionStorage.getItem('ui_sess') })`
      )
    );
    check(
      'popup 触发的同步生效',
      uiResult.local === 'ui-ok' && uiResult.session === 's1',
      JSON.stringify(uiResult)
    );
    check(
      'popup 日志有输出',
      (await popupPage.evaluate(`document.getElementById('log').textContent.length`)) > 0,
      'ok'
    );

    // --- 10. 快照：导出结构 ---
    const snapshot = await sw.evaluate(`(async () => buildSnapshot({
      sourceTabId: ${sourceTabId},
      kinds: ['localStorage', 'sessionStorage', 'cookie']
    }, () => {}))()`);

    check(
      '快照格式正确',
      snapshot?.format === 'tab-data-sync/snapshot' &&
        snapshot.version === 1 &&
        ['edge', 'chrome'].includes(snapshot.source?.browser) &&
        snapshot.source?.url.startsWith(`http://localhost:${SOURCE_PORT}`),
      JSON.stringify(snapshot?.source)
    );
    check(
      '快照包含三类数据',
      Object.keys(snapshot.data.localStorage || {}).length === 3 &&
        Object.keys(snapshot.data.sessionStorage || {}).length === 2 &&
        snapshot.data.cookies.length === 3,
      JSON.stringify({
        local: Object.keys(snapshot.data.localStorage || {}),
        session: Object.keys(snapshot.data.sessionStorage || {}),
        cookies: snapshot.data.cookies.map((c) => c.name)
      })
    );

    // --- 11. 快照：直接导入 ---
    await targetPage.evaluate('localStorage.clear(); sessionStorage.clear()');
    const importPayload = JSON.stringify({
      target: { type: 'tab', tabId: targetTabId },
      data: snapshot.data,
      storageMode: 'merge',
      rewriteCookieDomain: true,
      reloadTarget: true
    });
    const imported = await sw.evaluate(`(async () => runImport(${importPayload}, () => {}))()`);
    await sleep(1200);
    await waitTabLoad(targetTabId, '导入后刷新');

    const importedData = await targetPage.evaluate(`(() => ({
      token: localStorage.getItem('token'),
      marker: localStorage.getItem('ui_marker'),
      session: sessionStorage.getItem('ui_sess')
    }))()`);
    check(
      '快照数据导入成功',
      imported?.cookies?.written === 3 &&
        importedData.token === 'local-token-1' &&
        importedData.marker === 'ui-ok' &&
        importedData.session === 's1',
      JSON.stringify({ cookies: imported?.cookies, importedData })
    );

    // --- 12. 口令加解密往返 ---
    const cryptoCheck = JSON.parse(
      await popupPage.evaluate(`(async () => {
        const plain = JSON.parse(${JSON.stringify(JSON.stringify(snapshot))});
        const envelope = await encryptSnapshot(plain, 'test-pass');
        const text = JSON.stringify(envelope);
        const decrypted = await decryptSnapshot(envelope, 'test-pass');
        let wrongFailed = false;
        try { await decryptSnapshot(envelope, 'wrong-pass'); } catch { wrongFailed = true; }
        return JSON.stringify({
          encrypted: Boolean(envelope.encrypted),
          noPlaintext: !text.includes('local-token-1'),
          roundTrip: decrypted.data.localStorage.token === 'local-token-1',
          wrongFailed
        });
      })()`)
    );
    check(
      '口令加解密往返正常',
      cryptoCheck.encrypted && cryptoCheck.noPlaintext && cryptoCheck.roundTrip && cryptoCheck.wrongFailed,
      JSON.stringify(cryptoCheck)
    );

    // --- 13. popup：加密快照导入 ---
    await targetPage.evaluate('localStorage.clear(); sessionStorage.clear()');
    const envelopeText = await popupPage.evaluate(
      `(async () => JSON.stringify(await encryptSnapshot(JSON.parse(${JSON.stringify(JSON.stringify(snapshot))}), 'ui-pass')))()`
    );

    const accepted = await popupPage.evaluate(`(async () => {
      setPanelMode('transfer');
      setTargetMode('tab');
      const target = document.getElementById('targetTab');
      target.value = '${targetTabId}';
      target.dispatchEvent(new Event('change'));
      document.getElementById('reloadTarget').checked = true;
      await acceptSnapshotText(${JSON.stringify(envelopeText)});
      return {
        previewVisible: !document.getElementById('snapshotPreview').hidden,
        passVisible: !document.getElementById('snapshotPassphrase').hidden,
        pending: pendingEnvelope !== null,
        buttonText: document.getElementById('importApply').textContent
      };
    })()`);
    check(
      'popup 识别加密快照',
      accepted.previewVisible && accepted.passVisible && accepted.pending,
      JSON.stringify(accepted)
    );

    await popupPage.evaluate(`(() => {
      document.getElementById('snapshotPassphrase').value = 'ui-pass';
      document.getElementById('importApply').click();
      return true;
    })()`);

    const importStatus = await waitFor(async () => {
      const text = await popupPage.evaluate(`document.getElementById('status').textContent`);
      if (!text) return null;
      return text.includes('导入完成') || text.includes('失败') || text.includes('口令') ? text : null;
    }, 15000, 'popup 导入完成');

    check('popup 加密导入成功', importStatus.includes('导入完成'), importStatus);

    await sleep(1200);
    await waitTabLoad(targetTabId, '弹窗导入后刷新');
    const uiImportData = JSON.parse(
      await targetPage.evaluate(`JSON.stringify({
        token: localStorage.getItem('token'),
        marker: localStorage.getItem('ui_marker'),
        session: sessionStorage.getItem('ui_sess')
      })`)
    );
    check(
      'popup 导入数据生效',
      uiImportData.token === 'local-token-1' &&
        uiImportData.marker === 'ui-ok' &&
        uiImportData.session === 's1',
      JSON.stringify(uiImportData)
    );

    console.log('\n--- 后台日志 ---');
    for (const line of run.logs) console.log(line);
  } finally {
    try {
      if (sw) sw.close();
    } catch {
      /* ignore */
    }
    for (const page of pages) {
      try {
        page.close();
      } catch {
        /* ignore */
      }
    }
    try {
      if (browser) browser.close();
    } catch {
      /* ignore */
    }
    try {
      browserProcess.kill();
    } catch {
      /* ignore */
    }
    try {
      sourceServer.close();
    } catch {
      /* ignore */
    }
    try {
      targetServer.close();
    } catch {
      /* ignore */
    }
    await sleep(800);
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n> ${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('\n测试脚本异常：', error.stack || error.message);
  process.exit(2);
});

