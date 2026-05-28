# EasyBrowser MCP

把 [EasyBrowser](https://easybrowser.pages.dev/) 指纹浏览器能力通过 MCP 协议暴露给 AI 工具，并结合 [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) 的 CDP 接管与页面自动化能力。安装后，Claude Code、Cursor、Kiro、Cline、Windsurf 等支持 MCP 的客户端可以直接通过自然语言管理环境、切换标签页、读取页面结构并执行浏览器操作。

如果你想了解 EasyBrowser 浏览器本身的详细能力、架构和使用场景，可以查看：

- [EasyBrowser 浏览器详细介绍](https://easybrowsermaster.github.io/)

当前 MCP 中所有基于浏览器页面的操作能力，都是通过 Patchright 接管浏览器实例后完成的。

## 核心能力

- **环境管理**：列环境、打开环境、关闭环境、查看运行状态
- **多环境路由**：通过环境名称或环境 ID 在一个 MCP server 内切换不同环境
- **标签页管理**：列出、新建、关闭、切换当前环境的标签页
- **页面结构快照**：通过 `browser_snapshot` 获取无障碍快照和元素 `ref`
- **浏览器操作**：点击、输入、悬停、按键、滚动、导航、截图、执行 JS
- **Patchright 接管能力**：通过 CDP 接入浏览器实例，复用 Patchright 的页面自动化和调试能力
- **调试能力**：查看控制台消息、网络请求、运行 Patchright 风格代码
- **2FA 集成**：读取环境绑定的 TOTP 验证码

## 前置条件

- Node.js >= 18
- EasyBrowser 启动器已运行并登录
- EasyBrowser Local API 可访问，默认地址为 `http://127.0.0.1:50325`
- Local API 属于 EasyBrowser VIP 功能

## 安装方式

### 先直接测试 MCP 是否能启动

发布到 npm 后，推荐先直接运行一次，确认本机环境没问题：

```bash
npx -y easybrowser-mcp@latest
```

看到类似下面输出，说明 MCP 已正常以 stdio 模式启动：

```text
EasyBrowser MCP Server (stdio) ready.
```

### Claude Code

Claude Code 支持直接通过命令注册 MCP。注意 `npx` 前要加 `--`，这样后面的参数才会传给 `npx`，不会被 `claude` 自己解析。

```bash
claude mcp add easybrowser --scope user -- npx -y easybrowser-mcp@latest
```

删除命令：

```bash
claude mcp remove easybrowser --scope user
```

如果你是从当前项目目录以 local scope 添加的，则删除时应使用：

```bash
claude mcp remove easybrowser --scope local
```

如果需要指定 EasyBrowser Local API 地址：

```bash
claude mcp add easybrowser --scope user -e EASYBROWSER_URL=http://127.0.0.1:50325 -- npx -y easybrowser-mcp@latest
```

说明：Claude Code 会在启动时尝试连接已注册的 MCP。若 EasyBrowser 本地环境启动较慢，可能会让 Claude 打开后多等待几秒才能输入。遇到这种情况，建议按需添加，用完后移除。

### Kiro / Cursor / Cline / Windsurf / 其他配置型客户端

这类客户端通常也支持 `npx` 启动 MCP，但很多没有像 Claude Code 那样的 `mcp add` 命令，因此一般通过配置文件或设置界面注册。

可使用下面的通用配置：

```json
{
  "mcpServers": {
    "easybrowser": {
      "command": "npx",
      "args": ["-y", "easybrowser-mcp@latest"],
      "env": {
        "EASYBROWSER_URL": "http://127.0.0.1:50325"
      }
    }
  }
}
```

核心点只有三个：

- `command` 使用 `npx`
- `args` 使用 `-y` 和 npm 包名
- 默认走 stdio 模式，不需要额外加 `--port`

### 本地开发接入

如果你是仓库开发者，也可以直接通过源码运行当前项目：

```bash
claude mcp add easybrowser --scope local -- node F:/MyProject/EasyBrowserMCP/src/server.js
```

如果要传环境变量：

```bash
claude mcp add easybrowser --scope local -e EASYBROWSER_URL=http://127.0.0.1:50325 -- node F:/MyProject/EasyBrowserMCP/src/server.js
```

## 启动方式

### stdio 模式

```bash
node src/server.js
```

### HTTP 模式

```bash
node src/server.js --port=8931
```

HTTP 模式下多个客户端共享同一个服务进程，因此也共享同一个环境会话状态。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EASYBROWSER_URL` | EasyBrowser Local API 地址 | `http://127.0.0.1:50325` |

## 自然语言使用方式

安装完成后，你可以直接对 Claude 说：

- “介绍一下 EasyBrowser 浏览器的核心优势”
- “列出 EasyBrowser 里的环境”
- “打开环境 fb-yanghao”
- “在环境 fb-yanghao 里新开一个标签页到 https://example.com”
- “列出环境 fb-yanghao 当前所有标签页”
- “切换到环境 fb-yanghao 的第 2 个标签页”
- “获取环境 fb-yanghao 当前页面快照”
- “读取环境 fb-yanghao 当前页面的控制台消息”
- “查看环境 fb-yanghao 当前页面的网络请求”

## 交互模型

当前版本的核心交互流程是：

1. 用 `env_open(env_id_or_name)` 打开环境，可直接传环境名称
2. 用 `browser_tabs` 管理该环境下的标签页
3. 用 `browser_snapshot(env_id_or_name)` 获取当前活动页面快照
4. 从快照中找到元素 `ref`
5. 用 `browser_click`、`browser_type`、`browser_hover`、`browser_select_option` 等工具操作该 `ref`
6. 页面变化后重新抓快照

注意：
- `ref` 是当前页面状态下的临时标识，页面跳转或局部刷新后可能失效
- `browser_tabs(list)` 默认隐藏 `chrome://`、`about:blank` 等内部页；如果当前环境没有业务页，会回退显示内部页

## Tools

### 环境管理

| Tool | 说明 | 参数 |
|------|------|------|
| `easybrowser_about` | 介绍 EasyBrowser 浏览器的核心优势与适用场景 | — |
| `env_list` | 列出 EasyBrowser 中的环境 | `name?` `tag?` `page?` `page_size?` |
| `env_list_running` | 列出 EasyBrowser 中当前正在运行的环境 | — |
| `env_sessions` | 列出 MCP 当前追踪的环境会话 | — |
| `env_status` | 查看 EasyBrowser 启动器状态和账号信息 | — |
| `env_open` | 打开或复用环境 | `env_id` `url?` |
| `env_close` | 关闭环境的当前活动标签页 | `env_id` |
| `env_stop_browser` | 关闭整个 EasyBrowser 浏览器进程 | — |
| `env_create` | 创建环境 | `name` `tag?` `proxy?` `os?` `note?` |
| `env_update` | 更新环境配置 | `env_id` `name?` `tag?` `proxy?` `note?` |
| `env_delete` | 删除一个或多个环境 | `env_ids` |
| `env_get_2fa` | 获取环境绑定的 TOTP 验证码 | `env_id` |

### 浏览器操作

所有浏览器工具都要求 `env_id`，它可以是环境 ID，也可以是当前已打开会话的环境名称。

| Tool | 说明 | 关键参数 |
|------|------|----------|
| `browser_tabs` | 列出、新建、关闭、切换标签页 | `action` `index?` `url?` |
| `browser_snapshot` | 获取当前活动页面快照，返回 `ref` | — |
| `browser_click` | 点击元素 | `ref` |
| `browser_type` | 输入文字 | `ref` `text` `submit?` |
| `browser_hover` | 悬停元素 | `ref` |
| `browser_navigate` | 导航到 URL | `url` |
| `browser_navigate_back` | 返回上一页 | — |
| `browser_press_key` | 按下键盘按键 | `key` |
| `browser_scroll` | 滚动页面 | `direction` `amount?` |
| `browser_wait_for` | 等待时间或文字出现 | `time?` `text?` |
| `browser_take_screenshot` | 页面截图 | `full_page?` |
| `browser_get_url` | 获取当前活动页面 URL | — |
| `browser_evaluate` | 在页面中执行 JS | `script` |
| `browser_console_messages` | 获取控制台消息 | `level?` |
| `browser_network_requests` | 获取网络请求列表 | `includeStatic?` |
| `browser_run_code` | 运行 Patchright 风格代码 | `code` |
| `browser_select_option` | 选择下拉项 | `ref` `values` |

## 使用示例

### 打开环境并查看页面

```text
env_open(env_id="fb-yanghao")
browser_get_url(env_id="fb-yanghao")
browser_snapshot(env_id="fb-yanghao")
```

### 在同一环境内打开多个标签页

```text
env_open(env_id="fb-yanghao")
browser_tabs(env_id="fb-yanghao", action="new", url="https://example.com")
browser_tabs(env_id="fb-yanghao", action="list")
browser_tabs(env_id="fb-yanghao", action="select", index=1)
browser_get_url(env_id="fb-yanghao")
```

### 不同环境分别操作

```text
env_open(env_id="fb-yanghao")
env_open(env_id="kwda8264@hotmail.com")
env_sessions()
browser_tabs(env_id="fb-yanghao", action="list")
browser_tabs(env_id="kwda8264@hotmail.com", action="list")
```

## 会话模型

当前版本采用最小状态模型：

- `envMap`：维护 `envId -> targetIds + activeTargetId`
- `tabMap`：维护 `targetId -> envId + page handle`
- 环境归属来自 EasyBrowser Local API
- 页面句柄来自 Patchright/CDP
- `targetId` 是两者之间的唯一主键

这意味着：
- 适合多环境、多 tab 路由
- 更适合自然语言切换环境和标签页
- `url`、`title` 等展示信息以运行时现查为主，而不是长期缓存

## 开发与验证

```bash
npm install
npm start
npm run start:http
```

## 发布前检查

在正式发布到 npm 前，至少确认：

- `package.json` 中的 `repository.url` 已改成真实仓库地址
- `name` 是最终 npm 包名
- `version` 正确
- `npx -y easybrowser-mcp@latest` 能正常启动
- `claude mcp add easybrowser --scope user -- npx -y easybrowser-mcp@latest` 能跑通

## License

MIT
