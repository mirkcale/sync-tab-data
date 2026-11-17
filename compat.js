'use strict';

/**
 * 兼容层 + 环境探测（Edge / Chrome 92+）。
 *
 * 1) 传输方式渐进增强
 *    Chrome 122 起所有异步扩展 API 都支持 Promise，现代浏览器直接返回 Promise；
 *    旧版本（如 Edge 92）自动退回回调 + runtime.lastError。
 *
 * 2) 能力探测
 *    按浏览器版本判断可选特性，供后台决定是否启用：
 *    - 分区 Cookie（CHIPS）：Chromium 119+ 才支持 cookies API 的 partitionKey
 *    - 剪贴板 API：部分旧版本只能用 execCommand 回退（在 popup 中处理）
 *
 * 3) 用户设置
 *    tdsSetTransportMode('compat') 可强制走回调、关闭可选特性，
 *    对应弹窗里的「兼容模式」。
 */

const TDS_ENV = (() => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

  const candidates = [
    { browser: 'edge', pattern: /\bEdg(?:e|A|iOS)?\/(\d+(?:\.\d+)*)/ },
    { browser: 'opera', pattern: /\bOPR\/(\d+(?:\.\d+)*)/ },
    { browser: 'brave', pattern: /\bBrave\/(\d+(?:\.\d+)*)/ },
    { browser: 'chrome', pattern: /\b(?:Chrome|Chromium)\/(\d+(?:\.\d+)*)/ }
  ];

  let browser = 'unknown';
  let version = 0;
  let fullVersion = '';

  for (const candidate of candidates) {
    const match = candidate.pattern.exec(ua);
    if (match) {
      browser = candidate.browser;
      fullVersion = match[1];
      version = parseInt(match[1], 10) || 0;
      break;
    }
  }

  const isChromium = browser !== 'unknown';
  const hasClipboardApi =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.clipboard && typeof navigator.clipboard.readText === 'function');

  return {
    browser,
    version,
    fullVersion,
    isChromium,
    features: {
      // Chrome 122: 所有异步扩展 API 都支持 Promise
      promiseApis: isChromium && version >= 122,
      // Chrome 119: cookies API 支持 partitionKey（CHIPS 分区 Cookie）
      partitionedCookies: isChromium && version >= 119,
      clipboardApi: hasClipboardApi
    }
  };
})();

let tdsTransportMode = 'auto';

/** 'auto' | 'compat'，由设置或后台请求决定 */
function tdsSetTransportMode(mode) {
  tdsTransportMode = mode === 'compat' ? 'compat' : 'auto';
}

function tdsTransportInUse() {
  return TDS_ENV.features.promiseApis && tdsTransportMode !== 'compat' ? 'promise' : 'callback';
}

/** 根据设置和浏览器版本，解析本次操作可用的可选特性 */
function tdsResolveFeatures(mode) {
  const compat = mode === 'compat';
  return {
    partitionedCookies: !compat && TDS_ENV.features.partitionedCookies
  };
}

/**
 * 统一调用 chrome.* 异步 API：
 * - 新浏览器（122+）且未开启兼容模式：直接使用 Promise
 * - 其它情况：回调 + runtime.lastError
 *
 * 用法：callChrome(chrome.tabs, 'query', { active: true })
 */
function callChrome(api, method, ...args) {
  if (tdsTransportInUse() === 'promise') {
    let result;
    try {
      result = api[method](...args);
    } catch (error) {
      return Promise.reject(error);
    }
    if (result && typeof result.then === 'function') return result;
    // 走到这里说明该版本并不像预期那样支持 Promise，避免重复执行，直接报错
    return Promise.reject(
      new Error(`${method} 没有返回 Promise，请在弹窗中开启「兼容模式」后重试`)
    );
  }

  return callChromeWithCallback(api, method, args);
}

function callChromeWithCallback(api, method, args) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    // 失败时浏览器会设置 runtime.lastError，必须在回调内同步读取
    const callback = (value) => {
      const runtimeError = chrome.runtime.lastError;
      settle(runtimeError ? new Error(runtimeError.message) : null, value);
    };

    let maybePromise;
    try {
      maybePromise = api[method](...args, callback);
    } catch (error) {
      settle(error);
      return;
    }

    // 兜底：如果某个版本忽略了回调、直接返回 Promise，也能拿到结果
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(
        (value) => settle(null, value),
        (error) => settle(error)
      );
    }
  });
}

// 顶层 const 不会自动成为 globalThis 的属性，这里显式暴露（便于测试与调试）
if (typeof globalThis !== 'undefined') {
  globalThis.TDS_ENV = TDS_ENV;
}

