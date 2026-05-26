# EasyBrowser MCP

将 [EasyBrowser](https://easybrowser.net) 指纹浏览器能力通过 MCP 协议暴露给 AI 工具。一次部署，Claude Code / Kiro / Cursor / VS Code Copilot / Cline / Windsurf 等所有支持 MCP 的客户端均可直接使用。

## 核心能力

- **环境隔离**：每个环境独立指纹、代理、Cookie，互不干扰
- **多 Tab 支持**：同一环境可打开多个 Tab，通过 `tab_index` 路由操作
- **2FA 集成**：直接获取环境绑定的 TOTP 验证码
- **全套浏览器操作**：导航、点击、输入、截图、快照、滚动、JS 执行等

## 前置条件

- Node.js >= 18
- EasyBrowser 启动器已运行并登录（默认 `http://127.0.0.1:50325`）

## 安装

```bash
git clone <repo-url> E:\MyProject\EasyBrowserMCP
cd E:\MyProject\EasyBrowserMCP
npm install
```

## 配置 MCP 客户端

以下配置适用于所有支持 MCP 的 AI 工具：

```json
{
  "mcpServers": {
    "easybrowser": {
      "command": "node",
      "args": ["E:/MyProject/EasyBrowserMCP/src/server.js"]
    }
  }
}
```

<details>
<summary><b>Kiro</b></summary>

编辑 `.kiro/settings/mcp.json`：

```json
{
  "mcpServers": {
    "easybrowser": {
      "command": "node",
      "args": ["E:/MyProject/EasyBrowserMCP/src/server.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add easybrowser node E:/MyProject/EasyBrowserMCP/src/server.js
```
</details>

<details>
<summary><b>Cursor</b></summary>

`Settings` → `MCP` → `Add new MCP Server`，类型选 `command`，命令填：

```
node E:/MyProject/EasyBrowserMCP/src/server.js
```
</details>

<details>
<summary><b>VS Code (Copilot)</b></summary>

`.vscode/mcp.json`：

```json
{
  "mcpServers": {
    "easybrowser": {
      "command": "node",
      "args": ["E:/MyProject/EasyBrowserMCP/src/server.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Cline</b></summary>

编辑 `cline_mcp_settings.json`：

```json
{
  "mcpServers": {
    "easybrowser": {
      "type": "stdio",
      "command": "node",
      "args": ["E:/MyProject/EasyBrowserMCP/src/server.js"],
      "disabled": false
    }
  }
}
```
</details>

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EASYBROWSER_URL` | EasyBrowser API 地址 | `http://127.0.0.1:50325` |

## Tools

### 环境管理

| Tool | 说明 | 参数 |
|------|------|------|
| `env_list` | 列出所有环境 | `name?` `tag?` |
| `env_list_running` | 列出运行中的环境 | — |
| `env_open` | 打开环境 Tab | `env_id` `url?` |
| `env_close` | 关闭环境 Tab | `env_id` `tab_index?` |
| `env_tabs` | 查看环境已打开的 Tab | `env_id` |
| `env_get_2fa` | 获取 TOTP 验证码 | `env_id` |

### 浏览器操作

所有操作需要 `env_id`，可选 `tab_index`（默认 0，即第一个 Tab）。

| Tool | 说明 | 关键参数 |
|------|------|----------|
| `browser_navigate` | 导航到 URL | `url` |
| `browser_snapshot` | 获取无障碍快照 | — |
| `browser_click` | 点击元素 | `selector` |
| `browser_type` | 输入文字 | `selector` `text` |
| `browser_press_key` | 按键 | `key` (如 Enter, Tab) |
| `browser_scroll` | 滚动 | `direction` `amount?` |
| `browser_screenshot` | 截图 | `full_page?` |
| `browser_get_text` | 获取文本 | `selector?` |
| `browser_wait` | 等待 | `seconds?` 或 `selector?` |
| `browser_evaluate` | 执行 JS | `script` |
| `browser_stop` | 关闭浏览器 | — |

## 使用流程

```
用户: 帮我登录 Facebook 环境 abc123

AI 执行:
  1. env_list()                                    → 确认环境存在
  2. env_open(env_id="abc123", url="https://facebook.com")  → 打开环境
  3. browser_snapshot(env_id="abc123")             → 查看页面结构
  4. browser_type(env_id="abc123", selector="#email", text="user@example.com")
  5. browser_type(env_id="abc123", selector="#pass", text="***")
  6. browser_click(env_id="abc123", selector="text=登录")
  7. env_get_2fa(env_id="abc123")                  → 获取验证码
  8. browser_type(env_id="abc123", selector="#code", text="482901")
  9. browser_click(env_id="abc123", selector="text=继续")
```

## 多环境操作

同一环境多个 Tab：

```
env_open(env_id="abc123", url="https://facebook.com")     → Tab[0]
env_open(env_id="abc123", url="https://instagram.com")    → Tab[1]
browser_click(env_id="abc123", selector="...", tab_index=1)  → 操作 Instagram Tab
```

不同环境：

```
env_open(env_id="abc123", url="https://facebook.com")
env_open(env_id="def456", url="https://facebook.com")
browser_click(env_id="abc123", selector="...")   → 操作环境A
browser_click(env_id="def456", selector="...")   → 操作环境B
```

## 内部架构

```
AI Client (Claude/Kiro/Cursor)
    │ MCP Protocol (stdio)
    ▼
┌─────────────────────────────┐
│  EasyBrowser MCP Server     │
│                             │
│  envMap:                    │
│    "abc123" → [Page, Page]  │  ← 一个环境可多个Tab
│    "def456" → [Page]        │
│                             │
│  EasyBrowserClient          │──→ EasyBrowser API (:50325)
│  Patchright (CDP)           │──→ Browser (debug_port)
└─────────────────────────────┘
```

## License

MIT
