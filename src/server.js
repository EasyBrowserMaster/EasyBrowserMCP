#!/usr/bin/env node

const vm = require('vm');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { EasyBrowserClient } = require('./easybrowser-client.js');

const eb = new EasyBrowserClient(process.env.EASYBROWSER_URL || 'http://127.0.0.1:50325');

let browser = null;
let debugPort = null;

// envMap: envId -> { envId, envName, targetIds: string[], activeTargetId: string | null, isDisposing: boolean }
const envMap = new Map();
// tabMap: targetId -> { envId, envName, page: Page | null }
const tabMap = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isIgnorableClosedError(error) {
  const message = error?.message || String(error || '');
  return error?.type === 'closed' || /Target closed|Session closed|browser has been closed|Target page, context or browser has been closed|Network\.setCacheDisabled|Connection closed/i.test(message);
}

function logCleanupError(scope, error) {
  if (!error || isIgnorableClosedError(error)) return;
  console.error(`[EasyBrowser] Cleanup error in ${scope}: ${error.message || error}`);
}

process.on('unhandledRejection', reason => {
  if (isIgnorableClosedError(reason)) {
    console.error(`[EasyBrowser] Ignored closed rejection: ${reason.message || reason}`);
    return;
  }
  console.error('[EasyBrowser] Unhandled rejection:', reason);
});

process.on('uncaughtException', error => {
  if (isIgnorableClosedError(error)) {
    console.error(`[EasyBrowser] Ignored closed exception: ${error.message || error}`);
    return;
  }
  console.error('[EasyBrowser] Uncaught exception:', error);
  process.exit(1);
});

async function ensureBrowser() {
  if (browser) {
    try {
      browser.contexts();
      return browser;
    } catch (_) {
      browser = null;
    }
  }

  const { chromium } = require('patchright');
  if (!debugPort) {
    const data = await eb.browserStart();
    debugPort = data.debug_port;
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  console.error(`[EasyBrowser] Browser connected, CDP port: ${debugPort}`);
  return browser;
}

async function reconnectBrowser() {
  const { chromium } = require('patchright');
  if (!debugPort) {
    const data = await eb.browserStart();
    debugPort = data.debug_port;
  }

  await browser?.close().catch(() => {});
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  return browser;
}

async function getPageTargetId(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function getLivePageMap() {
  const activeBrowser = await ensureBrowser();
  const map = new Map();
  const pages = activeBrowser.contexts().flatMap(context => context.pages());

  for (const page of pages) {
    try {
      map.set(await getPageTargetId(page), page);
    } catch (_) {}
  }

  return map;
}

async function findPageByTargetId(targetId) {
  const pageMap = await getLivePageMap();
  return pageMap.get(targetId) || null;
}

async function waitForTargetPage(targetId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await findPageByTargetId(targetId);
    if (page) return page;
    await sleep(250);
  }
  throw new Error(`等待打开的 Tab 超时，target_id=${targetId}`);
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value != null && value !== '') return value;
  }
  return null;
}

async function getEnvCatalog() {
  const data = await eb.listContainers({ page: 1, page_size: 1000, name: '' });
  const byId = new Map();
  const byLowerName = new Map();
  for (const env of data.list || []) {
    byId.set(env.id, env);
    byLowerName.set(env.name.toLowerCase(), env);
  }
  return { byId, byLowerName, list: data.list || [] };
}

async function resolveEnv(envIdOrName) {
  const session = resolveSessionEntry(envIdOrName);
  if (session) return { envId: session.envId, envName: session.session.envName };

  const catalog = await getEnvCatalog();
  if (catalog.byId.has(envIdOrName)) {
    const env = catalog.byId.get(envIdOrName);
    return { envId: env.id, envName: env.name };
  }

  const normalized = envIdOrName.toLowerCase();
  if (catalog.byLowerName.has(normalized)) {
    const env = catalog.byLowerName.get(normalized);
    return { envId: env.id, envName: env.name };
  }

  const fuzzy = catalog.list.find(env => env.name.toLowerCase().includes(normalized));
  if (fuzzy) return { envId: fuzzy.id, envName: fuzzy.name };

  throw new Error(`找不到环境: ${envIdOrName}`);
}

function normalizeTabOwnershipEntries(data) {
  const items = Array.isArray(data) ? data : data?.list || data?.tabs || [];
  return items.map(item => ({
    targetId: pickFirst(item, ['target_id', 'targetId', 'tab_id', 'tabId']),
    envId: pickFirst(item, ['env_id', 'envId', 'container_id', 'containerId', 'browser_id', 'browserId']),
    envName: pickFirst(item, ['env_name', 'envName', 'container_name', 'containerName', 'name']),
  })).filter(item => item.targetId);
}

async function refreshState(preferredActives = new Map()) {
  const previousActives = new Map();
  const previousDisposing = new Map();
  for (const [envId, session] of envMap.entries()) {
    previousActives.set(envId, session.activeTargetId);
    previousDisposing.set(envId, session.isDisposing);
  }
  for (const [envId, targetId] of preferredActives.entries()) {
    previousActives.set(envId, targetId);
  }

  const catalog = await getEnvCatalog().catch(() => ({ byId: new Map(), byLowerName: new Map(), list: [] }));
  const ownershipEntries = normalizeTabOwnershipEntries(await eb.tabList().catch(() => []));
  const livePageMap = ownershipEntries.length || debugPort ? await getLivePageMap().catch(() => new Map()) : new Map();

  envMap.clear();
  tabMap.clear();

  for (const item of ownershipEntries) {
    const env = item.envId ? catalog.byId.get(item.envId) : item.envName ? catalog.byLowerName.get(item.envName.toLowerCase()) : null;
    const envId = item.envId || env?.id;
    const envName = item.envName || env?.name;
    if (!envId || !envName) continue;

    let session = envMap.get(envId);
    if (!session) {
      session = {
        envId,
        envName,
        targetIds: [],
        activeTargetId: null,
        isDisposing: previousDisposing.get(envId) || false,
      };
      envMap.set(envId, session);
    }

    if (!session.targetIds.includes(item.targetId)) {
      session.targetIds.push(item.targetId);
    }

    tabMap.set(item.targetId, {
      envId,
      envName,
      page: livePageMap.get(item.targetId) || null,
    });
  }

  for (const [envId, session] of envMap.entries()) {
    const preferred = previousActives.get(envId);
    if (preferred && session.targetIds.includes(preferred)) {
      session.activeTargetId = preferred;
    } else {
      const firstNonInternal = session.targetIds.find(targetId => {
        const page = tabMap.get(targetId)?.page;
        return page ? !isInternalPageUrl(page.url()) : true;
      });
      session.activeTargetId = firstNonInternal || session.targetIds[0] || null;
    }
  }
}

function resolveSessionEntry(envIdOrName) {
  if (envMap.has(envIdOrName)) return { envId: envIdOrName, session: envMap.get(envIdOrName) };
  const normalized = envIdOrName.toLowerCase();
  for (const [envId, session] of envMap) {
    if ((session.envName || '').toLowerCase() === normalized) {
      return { envId, session };
    }
  }
  return null;
}

function isInternalPageUrl(url) {
  return /^(chrome|edge):\/\/|^about:(blank|newtab)/i.test(url || '');
}

const consoleMessageLevels = ['error', 'warning', 'info', 'debug'];

function consoleLevelForMessageType(type) {
  switch (type) {
    case 'assert':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'count':
    case 'dir':
    case 'dirxml':
    case 'info':
    case 'log':
    case 'table':
    case 'time':
    case 'timeEnd':
      return 'info';
    case 'clear':
    case 'debug':
    case 'endGroup':
    case 'profile':
    case 'profileEnd':
    case 'startGroup':
    case 'startGroupCollapsed':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}

function shouldIncludeConsoleMessage(thresholdLevel, type) {
  const messageLevel = consoleLevelForMessageType(type);
  return consoleMessageLevels.indexOf(messageLevel) <= consoleMessageLevels.indexOf(thresholdLevel);
}

async function renderRequestLine(request, includeStatic) {
  const response = request._hasResponse ? await request.response() : undefined;
  const isStaticRequest = ['document', 'stylesheet', 'image', 'media', 'font', 'script', 'manifest'].includes(request.resourceType());
  const isSuccessfulRequest = !response || response.status() < 400;
  if (isStaticRequest && isSuccessfulRequest && !includeStatic) return undefined;
  const result = [];
  result.push(`[${request.method().toUpperCase()}] ${request.url()}`);
  if (response) result.push(`=> [${response.status()}] ${response.statusText()}`);
  return result.join(' ');
}

function getActiveTargetId(session) {
  return session.activeTargetId;
}

function setActiveTargetId(session, targetId) {
  if (!session.targetIds.includes(targetId)) throw new Error(`Tab 不存在: ${targetId}`);
  session.activeTargetId = targetId;
}

function getDisplayTargetIds(session) {
  const publicTargets = session.targetIds.filter(targetId => {
    const page = tabMap.get(targetId)?.page;
    return page ? !isInternalPageUrl(page.url()) : true;
  });
  return publicTargets.length ? publicTargets : session.targetIds.slice();
}

async function ensurePageForTargetId(targetId) {
  const entry = tabMap.get(targetId);
  if (entry?.page && !entry.page.isClosed()) return entry.page;
  const page = await findPageByTargetId(targetId);
  if (!page) return null;
  if (entry) entry.page = page;
  return page;
}

async function getSessionContext(envIdOrName, options = {}) {
  await refreshState(options.preferredActives || new Map());
  const entry = resolveSessionEntry(envIdOrName);
  if (!entry) throw new Error(`环境 ${envIdOrName} 未打开，请先调用 env_open`);

  const targetId = options.targetId || entry.session.activeTargetId;
  if (!targetId) throw new Error(`环境 ${entry.envId} 当前没有活动 Tab，请先调用 env_open 或 browser_tabs(new)`);

  if (!entry.session.targetIds.includes(targetId)) {
    throw new Error(`环境 ${entry.envId} 中找不到 targetId=${targetId} 对应的 Tab`);
  }

  const page = await ensurePageForTargetId(targetId);
  if (!page) throw new Error(`环境 ${entry.envId} 的 targetId=${targetId} 当前没有可操作页面`);
  return { envId: entry.envId, session: entry.session, targetId, page };
}

async function openNewTabForEnv(resolvedEnv, url) {
  await ensureBrowser();
  const tabData = await eb.newTab(resolvedEnv.envId, url || undefined);
  const targetId = tabData.target_id;
  console.error(`[env_open] newTab → targetId: ${targetId}`);

  await sleep(1000);
  await reconnectBrowser();
  const page = await waitForTargetPage(targetId);
  await page.bringToFront().catch(() => {});
  await refreshState(new Map([[resolvedEnv.envId, targetId]]));
  const sessionEntry = resolveSessionEntry(resolvedEnv.envId);
  if (!sessionEntry) throw new Error(`环境 ${resolvedEnv.envName} 打开后未能建立会话`);
  setActiveTargetId(sessionEntry.session, targetId);
  const sessionPage = await ensurePageForTargetId(targetId);
  return { session: sessionEntry.session, targetId, page: sessionPage };
}

function removeTargetFromState(envId, targetId) {
  const session = envMap.get(envId);
  if (!session) return;
  session.targetIds = session.targetIds.filter(id => id !== targetId);
  tabMap.delete(targetId);
  if (session.activeTargetId === targetId) {
    session.activeTargetId = session.targetIds[0] || null;
  }
  if (!session.targetIds.length) envMap.delete(envId);
}

function formatDuration() {
  return '';
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(error) {
  const msg = error?.message || String(error);
  console.error(`[EasyBrowser] Error: ${msg}`);
  return { content: [{ type: 'text', text: `错误: ${msg}` }], isError: true };
}

const server = new McpServer({ name: 'easybrowser', version: '6.0.0' });

server.tool(
  'easybrowser_about',
  '介绍 EasyBrowser 浏览器的核心优势和适用场景。',
  {},
  async () => ok(
    [
      'EasyBrowser',
      '🚧如需内测资格，请联系我们 https://t.me/easydev001',
      '',
      '基于定制 Chromium 的页签级隔离指纹浏览器，专为自动化场景设计。',
      '',
      '核心优势：',
      '- 直击自动化三大痛点：内存消耗、流量消耗、机器人检测与指纹检测。',
      '- 一个浏览器实例即可运行多个完全隔离的容器（Tab），并发无需多开浏览器。',
      '',
      '容器设计：',
      '- 一个 Tab 对应一个容器，Tab 可随时切换容器。',
      '- 每个容器独立指纹、Cookie、代理，互不干扰。',
      '- 并发只需一个浏览器实例，大幅节省系统资源。',
      '',
      '容器功能：',
      '- 指纹隔离：CPU、内存、语言、语音列表、时区、WebRTC、WebGL、Canvas、Audio、Worker 等。',
      '- 指纹防检测：可通过 Browserscan、CreepJS、Pixelscan 等主流指纹检测网站。',
      '',
      '先进防检测技术：',
      '- JS / Intl / HTTP / Worker 多端一致性处理。',
      '- Canvas 渲染层处理：空白检测、噪音检测、多 API 一致性检测。',
      '- Audio 内核特征检测。',
      '- CSS API 检测。',
      '- Cookie / LocalStorage / IndexedDB 隔离。',
      '- 同一浏览器多个 Tab 运行多个账号，数据完全隔离。',
      '',
      '代理隔离：',
      '- 多 Tab 可设置不同代理，每个容器独立出口 IP。',
      '',
      '资源节省：',
      '- 节省流量：浏览器缓存共享，多容器共享静态文件缓存，相同资源只下载一次。',
      '- 源码级代理 Bypass：基于 Chromium 源码级改造，支持自定义 bypass 规则，静态资源直连不走代理，大幅降低代理流量消耗。',
      '- 节省内存：相比传统多实例并发方案，多 Tab 架构至少节省内存 30%+。',
      '',
      '当前 MCP 说明：',
      '- 当前 MCP 通过 EasyBrowser Local API 管理环境与标签页。',
      '- 所有基于浏览器页面的操作能力，都是通过 Patchright 接管浏览器实例后完成的。',
      '',
      '详细介绍：',
      '- 产品官网：https://easybrowser.pages.dev/',
      '- 浏览器详细说明：https://easybrowsermaster.github.io/'
    ].join('\n')
  )
);

server.tool(
  'env_list',
  '列出 EasyBrowser 中所有指纹浏览器环境（返回 env_id、名称、标签、代理）',
  {
    name: z.string().optional().describe('按名称模糊搜索'),
    tag: z.string().optional().describe('按标签筛选'),
    page: z.number().optional().describe('页码，默认 1'),
    page_size: z.number().optional().describe('每页数量，默认 20'),
  },
  async ({ name, tag, page, page_size }) => {
    try {
      const params = {};
      if (name) params.name = name;
      if (tag) params.tag = tag;
      if (page) params.page = page;
      if (page_size) params.page_size = page_size;
      const data = await eb.listContainers(params);
      if (!data.list?.length) return ok('无环境，请先在 EasyBrowser 中创建环境。');
      const lines = data.list.map(env => `[${env.id}] ${env.name}  tag:${env.tag || '-'}  proxy:${(env.proxy || '-').slice(0, 50)}`);
      return ok(`共 ${data.total || lines.length} 个环境：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_list_running',
  '列出 EasyBrowser 中当前正在运行（已启动浏览器）的环境',
  {},
  async () => {
    try {
      const data = await eb.listRunning();
      if (!data.list?.length) return ok('当前没有运行中的环境。');
      const lines = data.list.map(env => `[${env.id}] ${env.name}`);
      return ok(`运行中 ${lines.length} 个：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_sessions',
  '列出当前 MCP Server 正在追踪的活动环境会话和标签页。',
  {},
  async () => {
    try {
      await refreshState();
      if (!envMap.size) return ok('当前没有活动环境会话。');
      const lines = [];
      for (const [envId, session] of envMap.entries()) {
        const targetIds = getDisplayTargetIds(session);
        const activeIndex = targetIds.findIndex(targetId => targetId === session.activeTargetId);
        const activePage = session.activeTargetId ? await ensurePageForTargetId(session.activeTargetId).catch(() => null) : null;
        const currentUrl = activePage?.url() || '-';
        lines.push(`[${envId}] ${session.envName}  tabs:${targetIds.length} active:${activeIndex >= 0 ? activeIndex : '-'}  →  ${String(currentUrl).slice(0, 80)}`);
      }
      return ok(`活动会话 ${envMap.size} 个：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_status',
  '查看 EasyBrowser 启动器状态和账号信息',
  {},
  async () => {
    try {
      const [status, account] = await Promise.all([
        eb.status().catch(error => ({ error: error.message })),
        eb.accountInfo().catch(error => ({ error: error.message })),
      ]);
      return ok(JSON.stringify({ status, account }, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_open',
  '通过环境 ID 或环境名称打开环境；已有会话时复用当前活动 Tab，传 url 时导航当前活动页。',
  {
    env_id: z.string().describe('环境 ID 或环境名称'),
    url: z.string().optional().describe('打开或导航到的 URL（可选）'),
  },
  async ({ env_id, url }) => {
    try {
      const resolvedEnv = await resolveEnv(env_id);
      await refreshState();
      const existing = resolveSessionEntry(resolvedEnv.envId);

      if (existing) {
        existing.session.envName = resolvedEnv.envName;
        const targetId = existing.session.activeTargetId || existing.session.targetIds[0];
        if (!targetId) {
          const { page } = await openNewTabForEnv(resolvedEnv, url);
          return ok(`环境已打开。\nenv_id: ${resolvedEnv.envId}\nenv_name: ${resolvedEnv.envName}\nurl: ${page?.url() || url || ''}`);
        }
        const { page } = await getSessionContext(resolvedEnv.envId, { targetId });
        if (url) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        setActiveTargetId(existing.session, targetId);
        return ok(`环境已复用。\nenv_id: ${resolvedEnv.envId}\nenv_name: ${resolvedEnv.envName}\ntarget_id: ${targetId}\nurl: ${page.url()}`);
      }

      const { page, targetId } = await openNewTabForEnv(resolvedEnv, url);
      return ok(`环境已打开。\nenv_id: ${resolvedEnv.envId}\nenv_name: ${resolvedEnv.envName}\ntarget_id: ${targetId}\nurl: ${page?.url() || url || ''}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_close',
  '关闭指定环境的当前活动 Tab；若所有 Tab 都关闭，则移除该环境会话。',
  { env_id: z.string().describe('环境 ID 或环境名称') },
  async ({ env_id }) => {
    try {
      await refreshState();
      const entry = resolveSessionEntry(env_id);
      if (!entry) return ok(`环境 ${env_id} 没有活动 Tab。`);
      const targetId = entry.session.activeTargetId || entry.session.targetIds[0];
      if (!targetId) return ok(`环境 ${entry.session.envName} 没有可关闭的活动 Tab。`);
      entry.session.isDisposing = true;
      await eb.closeTab(entry.envId, targetId).catch(error => logCleanupError('env_close.eb.closeTab', error));
      removeTargetFromState(entry.envId, targetId);
      entry.session.isDisposing = false;
      return ok(`环境 ${entry.session.envName} 的活动 Tab 已关闭。`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_stop_browser',
  '关闭整个浏览器进程（关闭所有环境的所有活动 Tab）',
  {},
  async () => {
    try {
      for (const session of envMap.values()) session.isDisposing = true;
      envMap.clear();
      tabMap.clear();
      await eb.browserStop().catch(error => logCleanupError('env_stop_browser.eb.browserStop', error));
      await browser?.close().catch(error => logCleanupError('env_stop_browser.browser.close', error));
      browser = null;
      debugPort = null;
      return ok('浏览器进程已关闭。');
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_create',
  '创建新的指纹浏览器环境',
  {
    name: z.string().describe('环境名称'),
    tag: z.string().optional().describe('标签'),
    proxy: z.string().optional().describe('代理地址，格式 http://user:pass@host:port'),
    os: z.string().optional().describe('操作系统指纹：windows / mac / linux'),
    note: z.string().optional().describe('备注'),
  },
  async ({ name, tag, proxy, os, note }) => {
    try {
      const body = { name };
      if (tag) body.tag = tag;
      if (proxy) body.proxy = proxy;
      if (os) body.os = os;
      if (note) body.note = note;
      const data = await eb.createContainer(body);
      return ok(`环境创建成功。\nID: ${data.id}\n名称: ${name}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_update',
  '更新指纹浏览器环境配置',
  {
    env_id: z.string().describe('环境 ID'),
    name: z.string().optional().describe('新名称'),
    tag: z.string().optional().describe('新标签'),
    proxy: z.string().optional().describe('新代理地址'),
    note: z.string().optional().describe('备注'),
  },
  async ({ env_id, name, tag, proxy, note }) => {
    try {
      const resolvedEnv = await resolveEnv(env_id);
      const body = { id: resolvedEnv.envId };
      if (name) body.name = name;
      if (tag) body.tag = tag;
      if (proxy) body.proxy = proxy;
      if (note) body.note = note;
      await eb.updateContainer(body);
      return ok(`环境 ${resolvedEnv.envId} 已更新。`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_delete',
  '删除一个或多个指纹浏览器环境（不可恢复）',
  { env_ids: z.array(z.string()).describe('要删除的环境 ID 或名称列表') },
  async ({ env_ids }) => {
    try {
      const resolvedIds = [];
      for (const item of env_ids) resolvedIds.push((await resolveEnv(item)).envId);
      await eb.deleteContainers(resolvedIds);
      return ok(`已删除 ${resolvedIds.length} 个环境：${resolvedIds.join(', ')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'env_get_2fa',
  '获取环境绑定的 2FA/TOTP 验证码（6位，30秒有效）',
  { env_id: z.string().describe('环境 ID 或环境名称') },
  async ({ env_id }) => {
    try {
      const resolvedEnv = await resolveEnv(env_id);
      const data = await eb.getTotp(resolvedEnv.envId);
      return ok(`验证码: ${data.code}（剩余 ${data.remaining}s 过期）`);
    } catch (e) {
      return fail(e);
    }
  }
);

const envIdParam = z.string().describe('环境 ID 或环境名称（来自 env_sessions）');

server.tool(
  'browser_tabs',
  '管理当前环境的标签页：列出、创建、关闭、选择。',
  {
    env_id: envIdParam,
    action: z.enum(['list', 'new', 'close', 'select']).describe('操作类型'),
    index: z.number().optional().describe('标签页索引，close/select 时使用；close 默认关闭当前活动 tab'),
    url: z.string().optional().describe('new 时要打开的 URL；不传则走环境默认行为'),
  },
  async ({ env_id, action, index, url }) => {
    try {
      const resolvedEnv = await resolveEnv(env_id);
      if (action === 'new') {
        const { session, targetId } = await openNewTabForEnv(resolvedEnv, url);
        return ok(`已新建 Tab。当前共 ${getDisplayTargetIds(session).length} 个标签页，活动 target_id=${targetId}`);
      }

      await refreshState();
      const entry = resolveSessionEntry(resolvedEnv.envId);
      if (!entry) throw new Error(`环境 ${env_id} 未打开，请先调用 env_open 或 browser_tabs(new)`);
      const { session } = entry;
      const targetIds = getDisplayTargetIds(session);

      if (action === 'list') {
        const lines = [];
        for (let i = 0; i < targetIds.length; i++) {
          const targetId = targetIds[i];
          const page = await ensurePageForTargetId(targetId).catch(() => null);
          const active = targetId === session.activeTargetId ? '*' : ' ';
          const currentUrl = page?.url() || '-';
          lines.push(`${active}[${i}] ${targetId}  ${String(currentUrl).slice(0, 80)}`);
        }
        return ok(lines.length ? lines.join('\n') : '当前没有打开的标签页。');
      }

      if (action === 'select') {
        if (index == null) throw new Error('select 操作必须传 index');
        const targetId = targetIds[index];
        if (!targetId) throw new Error(`找不到标签页索引 ${index}`);
        const { page } = await getSessionContext(resolvedEnv.envId, { targetId, preferredActives: new Map([[resolvedEnv.envId, targetId]]) });
        await page.bringToFront().catch(() => {});
        setActiveTargetId(session, targetId);
        return ok(`已切换到标签页 [${index}] ${page.url()}`);
      }

      if (action === 'close') {
        const targetId = index == null ? session.activeTargetId : targetIds[index];
        if (!targetId) throw new Error(`找不到可关闭的标签页${index == null ? '' : ` [${index}]`}`);
        session.isDisposing = true;
        await eb.closeTab(resolvedEnv.envId, targetId).catch(error => logCleanupError('browser_tabs.close.eb.closeTab', error));
        removeTargetFromState(resolvedEnv.envId, targetId);
        session.isDisposing = false;
        return ok('标签页已关闭。');
      }

      return ok('不支持的操作。');
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_snapshot',
  '获取当前页面的无障碍快照（每个元素带 [ref=eN]，用于精确点击/输入）。优先使用此 tool 而非截图。',
  { env_id: envIdParam },
  async ({ env_id }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const snapshot = await page._snapshotForAI({ track: 'response' });
      return ok(`### Snapshot\n\`\`\`yaml\n${snapshot.full}\n\`\`\``);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_click',
  '点击页面元素。使用 browser_snapshot 获取 ref，如 e12。真实鼠标点击，不触发网络等待。',
  {
    env_id: envIdParam,
    ref: z.string().describe('来自 browser_snapshot 的元素 ref，如 e12'),
    element: z.string().optional().describe('元素描述（辅助说明，可选）'),
  },
  async ({ env_id, ref, element }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const locator = page.locator(`aria-ref=${ref}`);
      if (element) locator.describe(element);
      await locator.click({ noWaitAfter: true, timeout: 5000 });
      return ok(`已点击 ref=${ref}${element ? ` (${element})` : ''}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_type',
  '在输入框中输入文字',
  {
    env_id: envIdParam,
    ref: z.string().describe('输入框的元素 ref'),
    text: z.string().describe('要输入的文字'),
    submit: z.boolean().optional().describe('输入后是否按 Enter，默认 false'),
  },
  async ({ env_id, ref, text, submit }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const locator = page.locator(`aria-ref=${ref}`);
      await locator.fill(text, { timeout: 5000 });
      if (submit) await page.keyboard.press('Enter');
      return ok(`已输入 "${text}"${submit ? ' 并按 Enter' : ''}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_hover',
  '鼠标悬停在元素上（触发 hover 效果或下拉菜单）',
  {
    env_id: envIdParam,
    ref: z.string().describe('元素 ref'),
  },
  async ({ env_id, ref }) => {
    try {
      const { page } = await getSessionContext(env_id);
      await page.locator(`aria-ref=${ref}`).hover({ timeout: 5000 });
      return ok(`已悬停 ref=${ref}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_navigate',
  '导航到指定 URL',
  {
    env_id: envIdParam,
    url: z.string().describe('目标 URL'),
  },
  async ({ env_id, url }) => {
    try {
      const { page, targetId, session } = await getSessionContext(env_id);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      setActiveTargetId(session, targetId);
      return ok(`已导航到 ${page.url()}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_navigate_back',
  '返回上一页',
  { env_id: envIdParam },
  async ({ env_id }) => {
    try {
      const { page } = await getSessionContext(env_id);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      return ok(`已返回：${page.url()}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_press_key',
  '按下键盘按键',
  {
    env_id: envIdParam,
    key: z.string().describe('按键名，如 Enter、Tab、Escape、ArrowDown、PageDown、F5'),
  },
  async ({ env_id, key }) => {
    try {
      const { page } = await getSessionContext(env_id);
      await page.keyboard.press(key);
      return ok(`已按下 ${key}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_scroll',
  '滚动页面',
  {
    env_id: envIdParam,
    direction: z.enum(['up', 'down', 'left', 'right']).describe('滚动方向'),
    amount: z.number().optional().describe('滚动像素，默认 500'),
  },
  async ({ env_id, direction, amount }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const px = amount || 500;
      const x = direction === 'left' ? -px : direction === 'right' ? px : 0;
      const y = direction === 'up' ? -px : direction === 'down' ? px : 0;
      await page.mouse.wheel(x, y);
      return ok(`已${direction === 'up' ? '上' : direction === 'down' ? '下' : direction === 'left' ? '左' : '右'}滚 ${px}px`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_wait_for',
  '等待指定时间（秒），或等待某段文字出现',
  {
    env_id: envIdParam,
    time: z.number().optional().describe('等待秒数'),
    text: z.string().optional().describe('等待该文字出现在页面上'),
  },
  async ({ env_id, time, text }) => {
    try {
      const { page } = await getSessionContext(env_id);
      if (text) {
        await page.waitForSelector(`text=${text}`, { timeout: 15000 });
        return ok(`文字 "${text}" 已出现`);
      }
      await sleep((time || 1) * 1000);
      return ok(`已等待 ${time || 1}s`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_take_screenshot',
  '截取当前页面截图',
  {
    env_id: envIdParam,
    full_page: z.boolean().optional().describe('是否截取整页，默认 false'),
  },
  async ({ env_id, full_page }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const buf = await page.screenshot({ type: 'png', fullPage: full_page || false });
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] };
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_get_url',
  '获取当前页面 URL',
  { env_id: envIdParam },
  async ({ env_id }) => {
    try {
      const { page } = await getSessionContext(env_id);
      return ok(page.url());
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_evaluate',
  '在页面中执行 JavaScript 代码（调试用，生产环境慎用）',
  {
    env_id: envIdParam,
    script: z.string().describe('要执行的 JS 表达式或函数，如 "() => document.title"'),
  },
  async ({ env_id, script }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const result = await page.evaluate(script);
      return ok(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_console_messages',
  '返回当前环境活动标签页的控制台消息。',
  {
    env_id: envIdParam,
    level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('控制台消息级别，默认 info'),
  },
  async ({ env_id, level }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const messages = await page.consoleMessages().catch(() => []);
      const pageErrors = await page.pageErrors().catch(() => []);
      const output = [];
      for (const message of messages) {
        if (!shouldIncludeConsoleMessage(level || 'info', message.type())) continue;
        output.push(`[${message.type().toUpperCase()}] ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`);
      }
      for (const error of pageErrors) {
        if (!shouldIncludeConsoleMessage(level || 'info', 'error')) continue;
        output.push(error.stack || error.message);
      }
      return ok(output.join('\n') || '当前没有控制台消息。');
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_network_requests',
  '返回当前环境活动标签页自加载以来的网络请求。',
  {
    env_id: envIdParam,
    includeStatic: z.boolean().optional().describe('是否包含成功的静态资源请求，默认 false'),
  },
  async ({ env_id, includeStatic }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const requests = await page.requests().catch(() => []);
      const lines = [];
      for (const request of requests) {
        const rendered = await renderRequestLine(request, includeStatic || false);
        if (rendered) lines.push(rendered);
      }
      return ok(lines.join('\n') || '当前没有可返回的网络请求。');
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_run_code',
  '在当前环境活动标签页上运行一段 Patchright 风格的异步代码。',
  {
    env_id: envIdParam,
    code: z.string().describe('一个异步 JavaScript 函数，例如 async (page) => { return await page.title(); }'),
  },
  async ({ env_id, code }) => {
    try {
      const { page } = await getSessionContext(env_id);
      const context = { page, result: undefined, error: undefined };
      vm.createContext(context);
      const snippet = `(async () => { try { result = await (${code})(page); } catch (e) { error = e; } })()`;
      await vm.runInContext(snippet, context);
      if (context.error) throw context.error;
      return ok(typeof context.result === 'string' ? context.result : JSON.stringify(context.result, null, 2));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'browser_select_option',
  '在下拉框中选择选项',
  {
    env_id: envIdParam,
    ref: z.string().describe('下拉框元素 ref'),
    values: z.array(z.string()).describe('要选择的值列表'),
  },
  async ({ env_id, ref, values }) => {
    try {
      const { page } = await getSessionContext(env_id);
      await page.locator(`aria-ref=${ref}`).selectOption(values, { timeout: 5000 });
      return ok(`已选择 ${values.join(', ')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

async function main() {
  const portArg = process.argv.find(arg => arg.startsWith('--port'));

  if (portArg) {
    const port = parseInt(portArg.split('=')[1], 10) || 8931;
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const http = require('http');
    const crypto = require('crypto');

    const sessions = new Map();
    const httpServer = http.createServer(async (req, res) => {
      if (new URL(req.url, 'http://localhost').pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Use /mcp');
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      let transport;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId);
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        transport.onclose = () => sessions.delete(transport.sessionId);
        sessions.set(transport.sessionId, transport);
        await server.connect(transport);
      }

      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`EasyBrowser MCP Server (HTTP) → http://127.0.0.1:${port}/mcp`);
      console.error('支持多环境并发，所有脚本共用此 server。');
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('EasyBrowser MCP Server (stdio) ready.');
  }
}

main().catch(e => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
