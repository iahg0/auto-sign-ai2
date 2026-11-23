// ==UserScript==
// @name         御爱同萌每日暖心福袋自动领取
// @namespace    https://www.ai2.moe/
// @version      1.1.1
// @description  在已登录且通过 Cloudflare 验证的浏览器会话中，自动领取 ai2.moe 的每日暖心福袋。
// @author       Codex
// @match        https://www.ai2.moe/*
// @match        https://ai2.moe/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = Object.freeze({
    buyPath:
      '/membersshop/buy-use/19-%E8%90%8C%E6%B1%81%E7%9B%B2%E7%9B%92%EF%BC%88%E6%AF%8F%E6%97%A5%E6%9A%96%E5%BF%83%E7%A6%8F%E8%A2%8B%EF%BC%89/',
    cooldownMs: 20 * 60 * 60 * 1000,
    cooldownBufferMs: 5 * 60 * 1000,
    cooldownRetryMs: 30 * 60 * 1000,
    genericRetryMs: 15 * 60 * 1000,
    cloudflareRetryMs: 5 * 60 * 1000,
    initialDelayMs: 2500,
    minimumTimerDelayMs: 250,
    maximumTimerDelayMs: 2147000000,
    bootRetryDelayMs: 5000,
    bootRetryLimit: 12,
    requestTimeoutMs: 30 * 1000,
    lockMs: 2 * 60 * 1000,
  });

  const KEYS = Object.freeze({
    nextAt: 'ai2DailyBonus.nextAt',
    lastSuccessAt: 'ai2DailyBonus.lastSuccessAt',
    lastMessage: 'ai2DailyBonus.lastMessage',
    lockAt: 'ai2DailyBonus.lockAt',
  });

  const storage = {
    get(key, fallback) {
      try {
        return GM_getValue(key, fallback);
      } catch {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
      }
    },
    set(key, value) {
      try {
        GM_setValue(key, value);
      } catch {
        window.localStorage.setItem(key, String(value));
      }
    },
  };

  let running = false;
  let checkTimer = null;
  let toastTimer = null;
  let loginNoticeShown = false;
  let bootRetryCount = 0;
  let pageCooldownSynced = false;

  function pageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  function getIps() {
    return pageWindow().ips || null;
  }

  function getMemberId() {
    const ips = getIps();
    const value = ips?.getSetting?.('memberID');
    return Number(value) || 0;
  }

  function isLoggedIn() {
    return getMemberId() > 0;
  }

  function buyUrl() {
    return new URL(CONFIG.buyPath, window.location.origin).href;
  }

  function cooldownUntil() {
    const storedNext = Number(storage.get(KEYS.nextAt, 0)) || 0;
    if (storedNext) {
      return storedNext;
    }

    const lastSuccess = Number(storage.get(KEYS.lastSuccessAt, 0)) || 0;
    return lastSuccess
      ? lastSuccess + CONFIG.cooldownMs + CONFIG.cooldownBufferMs
      : 0;
  }

  function setNextAttemptAt(timestamp) {
    storage.set(KEYS.nextAt, Math.round(timestamp));
  }

  function extractServerWaitMs(value) {
    const text = stripMarkup(value);
    const match = text.match(/(?:等待|等候)\s*([\d,]+)\s*秒/i);
    if (!match) {
      return 0;
    }

    const seconds = Number(match[1].replaceAll(',', ''));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  function syncCooldownFromPage() {
    if (pageCooldownSynced || !isDirectClaimPage() || !document.body) {
      return;
    }

    const waitMs = extractServerWaitMs(document.body.innerText || document.body.textContent);
    if (waitMs) {
      setNextAttemptAt(Date.now() + waitMs + CONFIG.cooldownBufferMs);
      pageCooldownSynced = true;
    }
  }

  function formatDateTime(timestamp) {
    if (!timestamp) {
      return '未知';
    }

    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  }

  function formatRemaining(milliseconds) {
    if (milliseconds <= 0) {
      return '现在';
    }

    const totalMinutes = Math.ceil(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours && minutes) {
      return `${hours} 小时 ${minutes} 分钟`;
    }
    if (hours) {
      return `${hours} 小时`;
    }
    return `${minutes} 分钟`;
  }

  function stripMarkup(value) {
    const text = String(value ?? '').trim();
    if (!text) {
      return '';
    }

    try {
      return new DOMParser().parseFromString(text, 'text/html').body.textContent.trim();
    } catch {
      return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function normalizeResponse(response) {
    if (response === null || response === undefined || response === '') {
      return {};
    }
    if (typeof response === 'object') {
      return response;
    }

    const text = String(response).trim();
    try {
      return JSON.parse(text);
    } catch {
      try {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const messageNode = doc.querySelector(
          '.ipsFlashMsg, .ipsMessage, [data-role="flashMessage"], body',
        );
        return { message: messageNode?.textContent?.trim() || text };
      } catch {
        return { message: text };
      }
    }
  }

  function removeToast() {
    document.getElementById('ai2-daily-bonus-toast')?.remove();
  }

  function showToast(message, type = 'info', timeoutMs = 6500) {
    const text = stripMarkup(message) || '每日福袋：操作完成';
    console.info(`[AI2 每日福袋] ${text}`);

    if (!document.body) {
      return;
    }

    removeToast();
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }

    const palette = {
      success: { accent: '#2f8f68', background: '#f4fbf7', border: '#b9dfcc' },
      error: { accent: '#b94a48', background: '#fff7f6', border: '#ecc6c3' },
      info: { accent: '#3a6ea8', background: '#f6f9fd', border: '#cbd9e8' },
    }[type] || { accent: '#3a6ea8', background: '#f6f9fd', border: '#cbd9e8' };

    const toast = document.createElement('div');
    toast.id = 'ai2-daily-bonus-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = text;
    toast.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'max-width:min(380px,calc(100vw - 40px))',
      'padding:12px 16px',
      `border:1px solid ${palette.border}`,
      `border-left:4px solid ${palette.accent}`,
      'border-radius:6px',
      `background:${palette.background}`,
      'color:#29313c',
      'box-shadow:0 8px 26px rgba(30,42,58,.18)',
      'font:14px/1.55 "Microsoft YaHei",sans-serif',
      'letter-spacing:0',
      'cursor:pointer',
      'white-space:normal',
      'word-break:break-word',
    ].join(';');

    toast.addEventListener('click', removeToast, { once: true });
    document.body.appendChild(toast);

    toastTimer = window.setTimeout(() => {
      removeToast();
      toastTimer = null;
    }, timeoutMs);
  }

  function requestClaim() {
    const ips = getIps();
    const ajax = ips?.getAjax?.();
    if (typeof ajax !== 'function') {
      throw new Error('站点脚本尚未加载完成，请稍后重试。');
    }

    return new Promise((resolve, reject) => {
      const request = ajax(buyUrl(), {
        timeout: CONFIG.requestTimeoutMs,
        bypassRedirect: true,
      });

      if (!request?.done || !request?.fail) {
        reject(new Error('无法创建站内领取请求。'));
        return;
      }

      request
        .done((response) => resolve(response))
        .fail((xhr, textStatus, errorThrown) => {
          const error = new Error(
            xhr?.responseJSON?.error ||
              xhr?.responseJSON?.message ||
              errorThrown ||
              textStatus ||
              '领取请求失败',
          );
          error.xhr = xhr;
          error.textStatus = textStatus;
          reject(error);
        });
    });
  }

  function failureText(error) {
    const chunks = [error?.message, error?.textStatus];
    const xhr = error?.xhr;

    if (xhr) {
      chunks.push(
        xhr.responseJSON?.error,
        xhr.responseJSON?.message,
        typeof xhr.responseText === 'string' ? xhr.responseText.slice(0, 1200) : '',
      );
    }

    return stripMarkup(chunks.filter(Boolean).join(' '));
  }

  async function claimDailyBonus(options = {}) {
    const manual = options.manual === true;

    if (running) {
      if (manual) {
        showToast('正在领取，请稍候。', 'info', 3500);
      }
      return;
    }

    const lockAt = Number(storage.get(KEYS.lockAt, 0)) || 0;
    if (!manual && lockAt && Date.now() - lockAt < CONFIG.lockMs) {
      return;
    }

    if (!isLoggedIn()) {
      if (manual || !loginNoticeShown) {
        showToast('请先登录 ai2.moe。登录后刷新页面，脚本会自动继续。', 'info');
        loginNoticeShown = true;
      }
      return;
    }

    running = true;
    loginNoticeShown = false;
    storage.set(KEYS.lockAt, Date.now());

    try {
      const response = await requestClaim();
      const payload = normalizeResponse(response);
      const serverError = payload?.error;

      if (serverError) {
        throw new Error(
          typeof serverError === 'string' ? serverError : serverError.message || '领取失败',
        );
      }

      const now = Date.now();
      const nextAt = now + CONFIG.cooldownMs + CONFIG.cooldownBufferMs;
      const message = stripMarkup(payload?.message) || '每日暖心福袋领取成功。';

      storage.set(KEYS.lastSuccessAt, now);
      storage.set(KEYS.nextAt, nextAt);
      storage.set(KEYS.lastMessage, message);

      showToast(`${message} 下次可领取：${formatDateTime(nextAt)}。`, 'success', 8500);
    } catch (error) {
      const text = failureText(error) || '领取失败，请稍后重试。';
      const xhr = error?.xhr;
      const isLoginProblem =
        xhr?.status === 401 ||
        /MEMBERSSHOPGUEST|访客|请先登录|需要登录|not logged|guest|login required/i.test(text);
      const isCloudflareProblem =
        /cloudflare|challenge|cf-mitigated|just a moment|安全检查|验证浏览器/i.test(text) ||
        (xhr?.status === 403 && !isLoginProblem);
      const isCooldown =
        /冷却|还没到|未到|稍后|已经领取|已经购买|最近购买|才能再次(?:领取|购买)|等待\s*[\d,]+\s*(?:秒|分钟|小时)|\d+\s*(?:小时|分钟).*(?:领取|购买)|too soon|cooldown|recently/i.test(
          text,
        );

      if (isLoginProblem) {
        setNextAttemptAt(Date.now() + CONFIG.genericRetryMs);
        showToast('登录状态已失效，请重新登录后刷新页面。', 'info');
      } else if (isCloudflareProblem) {
        setNextAttemptAt(Date.now() + CONFIG.cloudflareRetryMs);
        showToast('Cloudflare 会话需要重新验证，请刷新页面后再试。', 'error');
      } else if (isCooldown) {
        const serverWaitMs = extractServerWaitMs(text);
        setNextAttemptAt(
          Date.now() + (serverWaitMs || CONFIG.cooldownRetryMs) + CONFIG.cooldownBufferMs,
        );
        showToast(`${text} 稍后会自动重试。`, 'info');
      } else {
        setNextAttemptAt(Date.now() + CONFIG.genericRetryMs);
        showToast(`${text} 稍后会自动重试。`, 'error');
      }

      console.warn('[AI2 每日福袋]', error);
    } finally {
      storage.set(KEYS.lockAt, 0);
      running = false;
    }
  }

  function showStatus() {
    syncCooldownFromPage();

    if (!isLoggedIn()) {
      showToast('尚未登录，登录并刷新页面后会开始自动领取。', 'info');
      return;
    }

    const nextAt = cooldownUntil();
    const lastMessage = storage.get(KEYS.lastMessage, '');
    if (nextAt > Date.now()) {
      showToast(
        `${lastMessage ? `${lastMessage} ` : ''}下次检查：${formatDateTime(nextAt)}（约 ${formatRemaining(
          nextAt - Date.now(),
        )} 后）。`,
        'info',
        8000,
      );
      return;
    }

    showToast('当前可以领取，脚本会自动安排下一次检查。', 'info');
  }

  function resetLocalSchedule() {
    storage.set(KEYS.nextAt, 0);
    storage.set(KEYS.lastSuccessAt, 0);
    storage.set(KEYS.lastMessage, '');
    storage.set(KEYS.lockAt, 0);
    showToast('本地冷却记录已重置，下一次检查将立即执行。', 'info');
    scheduleNextCheck();
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') {
      return;
    }

    GM_registerMenuCommand('每日福袋：立即领取', () => {
      void manualClaim();
    });
    GM_registerMenuCommand('每日福袋：查看状态', showStatus);
    GM_registerMenuCommand('每日福袋：重置本地冷却', resetLocalSchedule);
  }

  function isDirectClaimPage() {
    return window.location.pathname.startsWith('/membersshop/buy-use/19');
  }

  function clearCheckTimer() {
    if (checkTimer !== null) {
      window.clearTimeout(checkTimer);
      checkTimer = null;
    }
  }

  function scheduleNextCheck(options = {}) {
    clearCheckTimer();

    if (isDirectClaimPage() || running) {
      return;
    }

    if (!getIps()) {
      if (bootRetryCount < CONFIG.bootRetryLimit) {
        bootRetryCount += 1;
        checkTimer = window.setTimeout(() => {
          checkTimer = null;
          scheduleNextCheck();
        }, CONFIG.bootRetryDelayMs);
      }
      return;
    }

    bootRetryCount = 0;

    if (!isLoggedIn()) {
      return;
    }

    const nextAt = cooldownUntil();
    const needsInitialDelay = options.initial === true && !nextAt;
    const delay = nextAt
      ? Math.max(nextAt - Date.now() + 500, CONFIG.minimumTimerDelayMs)
      : needsInitialDelay
        ? CONFIG.initialDelayMs
        : CONFIG.minimumTimerDelayMs;

    checkTimer = window.setTimeout(() => {
      checkTimer = null;
      void scheduledCheck();
    }, Math.min(delay, CONFIG.maximumTimerDelayMs));
  }

  async function scheduledCheck() {
    if (isDirectClaimPage() || running) {
      return;
    }
    if (!isLoggedIn()) {
      return;
    }
    if (Date.now() < cooldownUntil()) {
      scheduleNextCheck();
      return;
    }
    await claimDailyBonus();
    scheduleNextCheck();
  }

  async function manualClaim() {
    if (isDirectClaimPage()) {
      syncCooldownFromPage();
      showStatus();
      return;
    }

    const nextAt = cooldownUntil();
    if (nextAt > Date.now()) {
      showToast(`本地冷却中，下次可领取：${formatDateTime(nextAt)}。`, 'info', 6000);
      scheduleNextCheck();
      return;
    }

    await claimDailyBonus({ manual: true });
    scheduleNextCheck();
  }

  function exposeDebugApi() {
    try {
      pageWindow().__AI2_DAILY_BONUS__ = Object.freeze({
        claim: () => manualClaim(),
        status: () => ({
          loggedIn: isLoggedIn(),
          nextAt: cooldownUntil(),
          lastSuccessAt: Number(storage.get(KEYS.lastSuccessAt, 0)) || 0,
          lastMessage: storage.get(KEYS.lastMessage, ''),
          running,
        }),
        reset: resetLocalSchedule,
      });
    } catch {
      // The console helper is optional.
    }
  }

  registerMenuCommands();
  exposeDebugApi();
  syncCooldownFromPage();
  scheduleNextCheck({ initial: true });

  window.addEventListener('pagehide', () => {
    clearCheckTimer();
  });

  window.addEventListener('pageshow', () => {
    scheduleNextCheck();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleNextCheck();
    }
  });
})();
