#!/usr/bin/env node
/**
 * EasyBrowser MCP Server
 *
 * 依赖前置条件：
 *   1. EasyBrowser 启动器（EasyLauncher）已运行并登录
 *   2. Local API 为付费 VIP 功能，需开通后才可使用（默认 http://127.0.0.1:50325）
 *
 * 架构：
 *   - 自定义 env_* tools：通过 EasyBrowser Local API 管理指纹环境
 *   - browser_* tools：代理 patchright-mcp 提供完整浏览器操作能力（含 ref 系统）
 *
 * 用法（stdio，给 Kiro / Claude / Cursor 等 IDE 用）：
 *   node src/server.js
 *
 * 用法（HTTP 模式，多客户端并发）：
 *   node src/server.js --port 8931
 *
 * MCP 配置示例：
 *   {
 *     "mcpServers": {
 *       "easybrowser": {
 *         "command": "node",
 *         "args": ["E:/MyProject/EasyBrowserMCP/src/server.js"]
 *       }
 *     }
 *   }
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createConnection } = require('patchright/lib/mcp/index');
const { EasyBrowserClient } = require('./easybrowser-client.js');

const eb = new EasyBrowserClient(process.env.EASYBROWSER_URL || 'http://127.0.0.1:50325');
let innerClient = null;
let debugPort = null;

// ─── patchright-mcp 内部连接管理 ───

async function ensureInnerClient() {
  if (innerClient) return;
  if (!debugPort) {
    const data = await eb.browserStart();
    debugPort = data.debug_port;
  }
  const innerServer = await createConnection({
    browser: { cdpEndpoint: `http://127.0.0.1:${debugPort}` },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await innerServer.connect(serverTransport);
  innerClient = new Client({ name: 'easybrowser-bridge', version: '1.0.0' });
  await innerClient.connect(clientTransport);
}

async function reconnectInner() {
  if (innerClient) { await innerClient.close().catch(() => {}); innerClient = null; }
  await ensureInnerClient();
}

// ─── 工具函数 ───

function ok(msg) {
  return { content: [{ type: 'text', text: msg }] };
}
function err(e) {
  return { content: [{ type: 'text', text: `错误: ${e.message || e}` }], isError: true };
}

// ─── 环境管理 Tools ───

const ENV_TOOLS = [
  // ── 查询 ──
  {
    name: 'env_list',
    description: '列出所有指纹浏览器环境。返回 env_id、名称、标签、代理信息。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '按名称模糊搜索（可选）' },
        tag:  { type: 'string', description: '按标签筛选（可选）' },
        page: { type: 'number', description: '页码，默认 1' },
        page_size: { type: 'number', description: '每页数量，默认 20' },
      },
    },
    handler: async (args) => {
      const params = {};
      if (args.name)      params.name = args.name;
      if (args.tag)       params.tag = args.tag;
      if (args.page)      params.page = args.page;
      if (args.page_size) params.page_size = args.page_size;
      const data = await eb.listContainers(params);
      if (!data.list?.length) return '无环境，请先在 EasyBrowser 中创建环境。';
      const lines = data.list.map(e =>
        `[${e.id}] ${e.name}  tag:${e.tag || '-'}  proxy:${(e.proxy || '-').slice(0, 50)}`
      );
      return `共 ${data.total || lines.length} 个环境：\n${lines.join('\n')}`;
    },
  },

  {
    name: 'env_list_running',
    description: '列出当前正在运行（已打开浏览器）的环境。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const data = await eb.listRunning();
      if (!data.list?.length) return '当前没有运行中的环境。';
      const lines = data.list.map(e => `[${e.id}] ${e.name}`);
      return `运行中 ${lines.length} 个：\n${lines.join('\n')}`;
    },
  },

  {
    name: 'env_status',
    description: '查看 EasyBrowser 启动器状态和账号信息（可用于确认 Local API 是否正常）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [status, account] = await Promise.all([
        eb.status().catch(e => ({ error: e.message })),
        eb.accountInfo().catch(e => ({ error: e.message })),
      ]);
      return JSON.stringify({ status, account }, null, 2);
    },
  },

  // ── 环境生命周期 ──
  {
    name: 'env_open',
    description: '打开指定环境的浏览器 Tab（携带独立指纹和代理）。打开后使用 browser_snapshot 查看页面。',
    inputSchema: {
      type: 'object',
      properties: {
        env_id: { type: 'string', description: '环境 ID（来自 env_list）' },
        url:    { type: 'string', description: '打开的 URL（可选，不填则打开上次记录的页面）' },
      },
      required: ['env_id'],
    },
    handler: async (args) => {
      if (!debugPort) {
        const d = await eb.browserStart();
        debugPort = d.debug_port;
      }
      const tabData = await eb.newTab(args.env_id, args.url || undefined);
      // 等待页面加载后重连 patchright-mcp，使其感知新 tab
      await new Promise(r => setTimeout(r, 3000));
      await reconnectInner();
      return `环境 ${args.env_id} 已打开。\ntarget_id: ${tabData.target_id}\n\n现在可以使用 browser_snapshot 查看页面内容。`;
    },
  },

  {
    name: 'env_close',
    description: '关闭指定环境的浏览器 Tab。',
    inputSchema: {
      type: 'object',
      properties: {
        env_id:    { type: 'string', description: '环境 ID' },
        target_id: { type: 'string', description: 'Tab 的 target_id（来自 env_open，可选）' },
      },
      required: ['env_id'],
    },
    handler: async (args) => {
      await eb.closeTab(args.env_id, args.target_id || undefined);
      return `环境 ${args.env_id} Tab 已关闭。`;
    },
  },

  {
    name: 'env_stop_browser',
    description: '关闭整个浏览器进程（关闭所有环境的所有 Tab）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (innerClient) { await innerClient.close().catch(() => {}); innerClient = null; }
      await eb.browserStop();
      debugPort = null;
      return '浏览器进程已关闭。';
    },
  },

  // ── 环境 CRUD ──
  {
    name: 'env_create',
    description: '创建新的指纹浏览器环境。',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: '环境名称' },
        tag:   { type: 'string', description: '标签（可选）' },
        proxy: { type: 'string', description: '代理地址，格式 http://user:pass@host:port（可选）' },
        os:    { type: 'string', description: '操作系统指纹：windows / mac / linux（可选）' },
        note:  { type: 'string', description: '备注（可选）' },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const body = { name: args.name };
      if (args.tag)   body.tag = args.tag;
      if (args.proxy) body.proxy = args.proxy;
      if (args.os)    body.os = args.os;
      if (args.note)  body.note = args.note;
      const data = await eb.createContainer(body);
      return `环境创建成功。\nID: ${data.id}\n名称: ${args.name}`;
    },
  },

  {
    name: 'env_update',
    description: '更新指纹浏览器环境的配置（名称、代理、标签等）。',
    inputSchema: {
      type: 'object',
      properties: {
        env_id: { type: 'string', description: '环境 ID' },
        name:   { type: 'string', description: '新名称（可选）' },
        tag:    { type: 'string', description: '新标签（可选）' },
        proxy:  { type: 'string', description: '新代理地址（可选）' },
        note:   { type: 'string', description: '备注（可选）' },
      },
      required: ['env_id'],
    },
    handler: async (args) => {
      const body = { id: args.env_id };
      if (args.name)  body.name = args.name;
      if (args.tag)   body.tag = args.tag;
      if (args.proxy) body.proxy = args.proxy;
      if (args.note)  body.note = args.note;
      await eb.updateContainer(body);
      return `环境 ${args.env_id} 已更新。`;
    },
  },

  {
    name: 'env_delete',
    description: '删除一个或多个指纹浏览器环境（不可恢复，请谨慎操作）。',
    inputSchema: {
      type: 'object',
      properties: {
        env_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的环境 ID 列表',
        },
      },
      required: ['env_ids'],
    },
    handler: async (args) => {
      await eb.deleteContainers(args.env_ids);
      return `已删除 ${args.env_ids.length} 个环境：${args.env_ids.join(', ')}`;
    },
  },

  // ── 2FA ──
  {
    name: 'env_get_2fa',
    description: '获取环境绑定的 2FA/TOTP 验证码（6位数字，30秒有效）。',
    inputSchema: {
      type: 'object',
      properties: {
        env_id: { type: 'string', description: '环境 ID' },
      },
      required: ['env_id'],
    },
    handler: async (args) => {
      const data = await eb.getTotp(args.env_id);
      return `验证码: ${data.code}（剩余 ${data.remaining}s 过期）`;
    },
  },

  // ── Tab 管理 ──
  {
    name: 'env_tab_list',
    description: '列出当前浏览器中所有打开的 Tab（跨所有环境）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const data = await eb.tabList();
      if (!data.list?.length) return '当前没有打开的 Tab。';
      const lines = data.list.map(t =>
        `[${t.target_id}] env:${t.id}  ${t.url || '(no url)'}`
      );
      return lines.join('\n');
    },
  },
];

// ─── patchright-mcp tools 定义（完整列表，代理转发）───

const PATCHRIGHT_TOOLS = [
  {
    name: 'browser_snapshot',
    description: '获取当前页面的无障碍快照（推荐优先使用，比截图更高效）。每个元素带有 [ref=eN] 标识，可用于精确点击/输入。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: '点击页面元素。优先使用快照中的 ref 参数精确定位。',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: '元素的人类可读描述（辅助说明）' },
        ref:     { type: 'string', description: '来自 browser_snapshot 的元素 ref，如 e12' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description: '在输入框中输入文字。',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: '元素描述（辅助说明）' },
        ref:     { type: 'string', description: '来自 browser_snapshot 的元素 ref' },
        text:    { type: 'string', description: '要输入的文字' },
        submit:  { type: 'boolean', description: '输入后是否按 Enter，默认 false' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_navigate',
    description: '导航到指定 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_navigate_back',
    description: '返回上一页。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_navigate_forward',
    description: '前进到下一页。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_press_key',
    description: '按下键盘按键。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '按键名，如 Enter、Tab、Escape、ArrowDown、F5 等' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_hover',
    description: '鼠标悬停在元素上（触发 hover 效果或下拉菜单）。',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref:     { type: 'string', description: '元素 ref' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_drag',
    description: '拖拽元素到另一个元素。',
    inputSchema: {
      type: 'object',
      properties: {
        startElement: { type: 'string' },
        startRef:     { type: 'string', description: '起始元素 ref' },
        endElement:   { type: 'string' },
        endRef:       { type: 'string', description: '目标元素 ref' },
      },
      required: ['startRef', 'endRef'],
    },
  },
  {
    name: 'browser_select_option',
    description: '在下拉框（select）中选择选项。',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string' },
        ref:     { type: 'string', description: '下拉框元素 ref' },
        values:  { type: 'array', items: { type: 'string' }, description: '要选择的值列表' },
      },
      required: ['ref', 'values'],
    },
  },
  {
    name: 'browser_take_screenshot',
    description: '截取当前页面截图（返回图片）。',
    inputSchema: {
      type: 'object',
      properties: {
        type:     { type: 'string', description: '格式：png 或 jpeg，默认 png' },
        fullPage: { type: 'boolean', description: '是否截取整页，默认 false' },
      },
    },
  },
  {
    name: 'browser_scroll',
    description: '滚动页面或指定元素。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: '方向：up / down / left / right' },
        amount:    { type: 'number', description: '滚动距离（像素），默认 500' },
        ref:       { type: 'string', description: '要滚动的元素 ref（不填则滚动整页）' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_wait_for',
    description: '等待指定时间，或等待某段文字出现/消失。',
    inputSchema: {
      type: 'object',
      properties: {
        time:     { type: 'number', description: '等待秒数' },
        text:     { type: 'string', description: '等待该文字出现' },
        textGone: { type: 'string', description: '等待该文字消失' },
      },
    },
  },
  {
    name: 'browser_tabs',
    description: '管理浏览器 Tab：列出、新建、关闭、切换。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list / new / close / select' },
        index:  { type: 'number', description: 'Tab 索引（close/select 时使用）' },
        url:    { type: 'string', description: '新建 Tab 时的 URL（可选）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_evaluate',
    description: '在页面中执行 JavaScript 代码并返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        function: { type: 'string', description: '要执行的 JS 函数体，如 "() => document.title"' },
      },
      required: ['function'],
    },
  },
  {
    name: 'browser_console_messages',
    description: '获取页面控制台输出的所有消息（用于调试）。',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: '过滤级别：log / warn / error（不填则返回全部）' },
      },
    },
  },
  {
    name: 'browser_network_requests',
    description: '获取页面发出的所有网络请求记录。',
    inputSchema: {
      type: 'object',
      properties: {
        includeStatic: { type: 'boolean', description: '是否包含静态资源请求，默认 false' },
      },
    },
  },
  {
    name: 'browser_handle_dialog',
    description: '处理浏览器弹出的 alert / confirm / prompt 对话框。',
    inputSchema: {
      type: 'object',
      properties: {
        accept:     { type: 'boolean', description: 'true 确认，false 取消' },
        promptText: { type: 'string', description: 'prompt 对话框的输入内容（可选）' },
      },
      required: ['accept'],
    },
  },
  {
    name: 'browser_file_upload',
    description: '上传文件到文件选择框。',
    inputSchema: {
      type: 'object',
      properties: {
        ref:   { type: 'string', description: '文件输入框的元素 ref' },
        paths: { type: 'array', items: { type: 'string' }, description: '本地文件路径列表' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'browser_resize',
    description: '调整浏览器窗口大小。',
    inputSchema: {
      type: 'object',
      properties: {
        width:  { type: 'number', description: '宽度（像素）' },
        height: { type: 'number', description: '高度（像素）' },
      },
      required: ['width', 'height'],
    },
  },
  {
    name: 'browser_run_code',
    description: '运行 Patchright 代码片段（高级用法，直接操作 page 对象）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '接收 page 参数的 async JS 函数，如 "async (page) => { await page.reload(); }"' },
      },
      required: ['code'],
    },
  },
];

// ─── MCP Server 主体 ───

async function createMcpServer() {
  const allTools = [
    ...ENV_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ...PATCHRIGHT_TOOLS,
  ];

  const server = new Server(
    { name: 'easybrowser', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // 环境管理 tool
    const envTool = ENV_TOOLS.find(t => t.name === name);
    if (envTool) {
      try {
        const result = await envTool.handler(args || {});
        return ok(result);
      } catch (e) {
        return err(e);
      }
    }

    // patchright-mcp 代理
    try {
      await ensureInnerClient();
      return await innerClient.callTool({ name, arguments: args || {} });
    } catch (e) {
      // 连接断开时尝试重连一次
      try {
        await reconnectInner();
        return await innerClient.callTool({ name, arguments: args || {} });
      } catch (e2) {
        return err(e2);
      }
    }
  });

  return server;
}

// ─── 启动 ───

async function main() {
  const portArg = process.argv.find(a => a.startsWith('--port'));

  if (portArg) {
    // HTTP 模式（多客户端并发）
    const port = parseInt(portArg.split('=')[1]) || 8931;
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const http = require('http');
    const crypto = require('crypto');

    const sessions = new Map();
    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Use /mcp endpoint.');
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
        const server = await createMcpServer();
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`EasyBrowser MCP Server (HTTP) → http://127.0.0.1:${port}/mcp`);
    });
  } else {
    // Stdio 模式（给 IDE 插件用）
    const server = await createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('EasyBrowser MCP Server (stdio) ready.');
  }
}

main().catch(e => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
