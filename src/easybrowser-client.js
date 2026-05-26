/**
 * EasyBrowser Local API Client
 *
 * 前置条件：
 *   - EasyBrowser 启动器（EasyLauncher）已运行并登录
 *   - Local API 为付费 VIP 功能，需要开通后才能使用
 *   - 默认监听 http://127.0.0.1:50325
 */
class EasyBrowserClient {
  constructor(baseUrl = 'http://127.0.0.1:50325') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async _get(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, v);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || 'EasyBrowser API error');
    return json.data;
  }

  async _post(path, body = {}) {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || 'EasyBrowser API error');
    return json.data;
  }

  // ─── 状态 ───
  status()      { return this._get('/api/v1/status'); }
  accountInfo() { return this._get('/api/v1/account/info'); }

  // ─── 环境管理 ───
  listContainers(params = {})  { return this._get('/api/v1/container/list', params); }
  listRunning()                { return this._get('/api/v1/container/list_running'); }
  createContainer(body)        { return this._post('/api/v1/container/create', body); }
  updateContainer(body)        { return this._post('/api/v1/container/update', body); }
  deleteContainers(ids)        { return this._post('/api/v1/container/delete', { ids }); }
  getTotp(id)                  { return this._get('/api/v1/container/totp', { id }); }

  // ─── 浏览器操作 ───
  browserStart()               { return this._get('/api/v1/browser/start'); }
  browserStop()                { return this._get('/api/v1/browser/stop'); }
  newTab(id, url)              { return this._get('/api/v1/browser/new_tab', { id, url }); }
  closeTab(id, target_id)      { return this._get('/api/v1/browser/close_tab', { id, target_id }); }
  tabList()                    { return this._get('/api/v1/browser/tab_list'); }
}

module.exports = { EasyBrowserClient };
