/**
 * TikTok 养号测试 - 通过 MCP 协议调用
 * 
 * 模拟 AI 客户端通过 MCP tools 操作浏览器：
 * 1. env_open 打开环境
 * 2. browser_navigate 导航
 * 3. browser_evaluate 执行JS（关闭弹窗、滚动视频、查看评论）
 * 4. browser_screenshot 截图确认
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');
const ENV_ID = '02b00892-0c32-439d-a4df-9a478147f3fb';

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || '';
  const image = result.content?.find(c => c.type === 'image');
  return { text, image, raw: result };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('═══ TikTok 养号测试 (via MCP) ═══\n');

  // 连接 MCP Server
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER_PATH], stderr: 'pipe' });
  const client = new Client({ name: 'nurture-test', version: '1.0.0' });
  await client.connect(transport);
  console.log('✓ MCP Server 已连接\n');

  // 1. 打开环境
  console.log('▶ 打开环境...');
  let r = await callTool(client, 'env_open', { env_id: ENV_ID, url: 'https://www.tiktok.com/' });
  console.log(' ', r.text);

  // 2. 等待加载
  console.log('▶ 等待页面加载...');
  await callTool(client, 'browser_wait', { env_id: ENV_ID, seconds: 6 });

  // 3. 截图看初始状态
  console.log('▶ 初始截图...');
  r = await callTool(client, 'browser_screenshot', { env_id: ENV_ID });
  if (r.image) fs.writeFileSync('tests/mcp-tiktok-1.png', Buffer.from(r.image.data, 'base64'));
  console.log('  已保存 tests/mcp-tiktok-1.png');

  // 4. 关闭弹窗 + 滚动视频（用 evaluate 执行复杂逻辑）
  console.log('▶ 关闭弹窗...');
  r = await callTool(client, 'browser_evaluate', {
    env_id: ENV_ID,
    script: `
      // 关闭所有可能的弹窗
      document.querySelectorAll('[aria-label="Close"], [data-e2e="modal-close-inner-button"], button svg').forEach(el => {
        const btn = el.closest('button') || el;
        if (btn.offsetParent !== null) btn.click();
      });
      // 也尝试点击弹窗外部关闭
      const overlay = document.querySelector('[class*="DivModalMask"], [class*="overlay"]');
      if (overlay) overlay.click();
      'done';
    `
  });
  console.log('  结果:', r.text);
  await callTool(client, 'browser_wait', { env_id: ENV_ID, seconds: 2 });

  // 5. 模拟养号：浏览视频
  console.log('\n▶ 开始养号操作...');
  for (let i = 1; i <= 8; i++) {
    const delay = 3 + Math.floor(Math.random() * 5); // 3-7秒

    // 滚动到下一个视频（用JS直接触发，比键盘更可靠）
    await callTool(client, 'browser_evaluate', {
      env_id: ENV_ID,
      script: `
        // 找到视频容器并滚动到下一个
        const container = document.querySelector('[data-e2e="recommend-list-item-container"]')?.parentElement
          || document.querySelector('main')
          || document.scrollingElement;
        if (container) {
          container.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
        }
        'scrolled';
      `
    });

    // 随机操作：30% 概率查看评论
    const action = Math.random();
    let actionDesc = '观看';

    if (action < 0.3 && i > 1) {
      // 查看评论
      actionDesc = '查看评论';
      await callTool(client, 'browser_evaluate', {
        env_id: ENV_ID,
        script: `
          const commentBtn = document.querySelector('[data-e2e="comment-icon"]');
          if (commentBtn) commentBtn.click();
          'clicked comment';
        `
      });
      await callTool(client, 'browser_wait', { env_id: ENV_ID, seconds: 2 });
      // 关闭评论
      await callTool(client, 'browser_evaluate', {
        env_id: ENV_ID,
        script: `
          const closeBtn = document.querySelector('[data-e2e="comment-close"]') 
            || document.querySelector('[aria-label="Close"]');
          if (closeBtn) closeBtn.click();
          'closed comment';
        `
      });
    } else if (action < 0.15 && i > 2) {
      // 5% 概率点赞
      actionDesc = '点赞 ❤️';
      await callTool(client, 'browser_evaluate', {
        env_id: ENV_ID,
        script: `
          const likeBtn = document.querySelector('[data-e2e="like-icon"]');
          if (likeBtn) likeBtn.click();
          'liked';
        `
      });
    }

    console.log(`  视频 ${i}/8 | ${actionDesc} | 停留 ${delay}s`);
    await callTool(client, 'browser_wait', { env_id: ENV_ID, seconds: delay });
  }

  // 6. 最终截图
  console.log('\n▶ 最终截图...');
  r = await callTool(client, 'browser_screenshot', { env_id: ENV_ID });
  if (r.image) fs.writeFileSync('tests/mcp-tiktok-final.png', Buffer.from(r.image.data, 'base64'));
  console.log('  已保存 tests/mcp-tiktok-final.png');

  // 7. 获取当前页面信息
  r = await callTool(client, 'browser_evaluate', {
    env_id: ENV_ID,
    script: `document.title + ' | URL: ' + location.href`
  });
  console.log('  页面:', r.text);

  // 8. 关闭
  console.log('\n▶ 关闭环境...');
  await callTool(client, 'env_close', { env_id: ENV_ID });
  await callTool(client, 'browser_stop');
  console.log('  已关闭');

  await client.close();
  console.log('\n═══ 养号完成 ═══');
}

main().catch(e => {
  console.error('失败:', e.message);
  process.exit(1);
});
