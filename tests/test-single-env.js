#!/usr/bin/env node
/**
 * EasyBrowser MCP 最小 smoke test
 *
 * 测试流程：
 *   1. 连接 MCP Server
 *   2. 列出工具
 *   3. 列出环境并选择第一个
 *   4. 打开环境活动页
 *   5. 等待页面加载
 *   6. 获取页面快照
 *   7. 获取当前 URL
 *   8. 截图
 *   9. 查看活动会话
 *  10. 关闭环境和浏览器
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');
const TEST_URL = 'https://browserscan.net/';

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function section(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ▶ ${title}`);
  console.log(`${'─'.repeat(50)}`);
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || '(image/binary response)';
  return { raw: result, text };
}

async function main() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  EasyBrowser MCP Smoke Test');
  console.log('═'.repeat(50));

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });

  let stderrBuf = '';
  transport.stderr?.on('data', data => {
    stderrBuf += data.toString();
  });

  await client.connect(transport);
  log('✓', 'MCP Server 已连接');

  section('列出 Tools');
  const { tools } = await client.listTools();
  log('✓', `共 ${tools.length} 个 tools`);
  tools.forEach(tool => log(' ', `- ${tool.name}`));

  section('列出环境 (env_list)');
  const { text: envListText } = await callTool(client, 'env_list');
  console.log(envListText.split('\n').map(line => `      ${line}`).join('\n'));

  const envIdMatch = envListText.match(/\[([^\]]+)\]/);
  if (!envIdMatch) {
    log('✗', '没有找到可用环境，请先在 EasyBrowser 中创建环境');
    await client.close();
    process.exit(1);
  }

  const envId = envIdMatch[1];
  log('→', `使用环境: ${envId}`);

  section(`打开环境 (env_open: ${envId.slice(0, 8)}...)`);
  const { text: openText } = await callTool(client, 'env_open', { env_id: envId, url: TEST_URL });
  log('✓', openText);

  section('等待页面加载 (browser_wait_for)');
  const { text: waitText } = await callTool(client, 'browser_wait_for', { env_id: envId, time: 3 });
  log('✓', waitText);

  section('获取页面快照 (browser_snapshot)');
  const { text: snapshotText } = await callTool(client, 'browser_snapshot', { env_id: envId });
  log('✓', `快照长度: ${snapshotText.length} 字符`);
  console.log(snapshotText.slice(0, 500));
  if (snapshotText.length > 500) console.log('      ... (截断)');

  section('获取当前 URL (browser_get_url)');
  const { text: currentUrl } = await callTool(client, 'browser_get_url', { env_id: envId });
  log('✓', currentUrl);

  section('截图 (browser_take_screenshot)');
  const { raw: screenshotResult } = await callTool(client, 'browser_take_screenshot', { env_id: envId });
  const imageContent = screenshotResult.content?.find(item => item.type === 'image');
  if (imageContent) {
    const sizeKB = Math.round(Buffer.from(imageContent.data, 'base64').length / 1024);
    const outPath = path.join(__dirname, 'screenshot.png');
    fs.writeFileSync(outPath, Buffer.from(imageContent.data, 'base64'));
    log('✓', `截图成功: ${sizeKB}KB`);
    log('✓', `已保存到: ${outPath}`);
  } else {
    log('⚠', `截图返回: ${screenshotResult.content?.[0]?.text || 'unknown'}`);
  }

  section('查看活动会话 (env_sessions)');
  const { text: sessionsText } = await callTool(client, 'env_sessions');
  log('✓', sessionsText);

  section('关闭环境 (env_close)');
  const { text: closeText } = await callTool(client, 'env_close', { env_id: envId });
  log('✓', closeText);

  section('关闭浏览器 (env_stop_browser)');
  const { text: stopText } = await callTool(client, 'env_stop_browser');
  log('✓', stopText);

  console.log(`\n${'═'.repeat(50)}`);
  console.log('  ✓ 测试完成');
  console.log('═'.repeat(50));

  if (stderrBuf) {
    console.log('\n  Server stderr:');
    console.log(stderrBuf.slice(0, 800));
  }

  await client.close();
}

main().catch(async error => {
  console.error('\n  ✗ 测试失败:', error.message || error);
  process.exit(1);
});
