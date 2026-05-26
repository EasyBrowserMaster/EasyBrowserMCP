#!/usr/bin/env node
/**
 * EasyBrowser MCP 调度测试脚本
 *
 * 测试流程：
 *   1. 连接 MCP Server
 *   2. 列出环境
 *   3. 打开第一个环境
 *   4. 导航到测试页面
 *   5. 获取页面快照
 *   6. 截图
 *   7. 关闭环境
 *
 * 用法: node tests/test-single-env.js
 * 前置: EasyBrowser 启动器已运行
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

// ─── 配置 ───
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');
const TEST_URL = 'https://browserscan.net/';

// ─── 辅助 ───
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

// ─── 主流程 ───
async function main() {
  console.log('\n' + '═'.repeat(50));
  console.log('  EasyBrowser MCP 调度测试');
  console.log('═'.repeat(50));

  // 1. 启动 MCP Server 并连接
  section('连接 MCP Server');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
    stderr: 'pipe',
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  let stderrBuf = '';
  transport.stderr?.on('data', d => { stderrBuf += d.toString(); });

  await client.connect(transport);
  log('✓', 'MCP Server 已连接');

  // 2. 列出可用 tools
  section('列出 Tools');
  const { tools } = await client.listTools();
  log('✓', `共 ${tools.length} 个 tools:`);
  tools.forEach(t => log(' ', `- ${t.name}: ${t.description.slice(0, 40)}`));

  // 3. 列出环境
  section('列出环境 (env_list)');
  const { text: envListText } = await callTool(client, 'env_list');
  log('✓', '环境列表:');
  console.log(envListText.split('\n').map(l => `      ${l}`).join('\n'));

  // 提取第一个环境 ID
  const envIdMatch = envListText.match(/\[([^\]]+)\]/);
  if (!envIdMatch) {
    log('✗', '没有找到可用环境，请先在 EasyBrowser 中创建环境');
    await client.close();
    process.exit(1);
  }
  const envId = envIdMatch[1];
  log('→', `使用环境: ${envId}`);

  // 4. 打开环境
  section(`打开环境 (env_open: ${envId.slice(0, 8)}...)`);
  const { text: openText } = await callTool(client, 'env_open', { env_id: envId, url: TEST_URL });
  log('✓', openText);

  // 5. 等待页面加载
  section('等待页面加载');
  const { text: waitText } = await callTool(client, 'browser_wait', { env_id: envId, seconds: 3 });
  log('✓', waitText);

  // 6. 获取页面快照
  section('获取页面快照 (browser_snapshot)');
  const { text: snapshotText } = await callTool(client, 'browser_snapshot', { env_id: envId });
  log('✓', `快照长度: ${snapshotText.length} 字符`);
  // 只显示前 500 字符
  console.log(snapshotText.slice(0, 500));
  if (snapshotText.length > 500) console.log('      ... (截断)');

  // 7. 获取页面文本
  section('获取页面文本 (browser_get_text)');
  const { text: pageText } = await callTool(client, 'browser_get_text', { env_id: envId });
  log('✓', `文本长度: ${pageText.length} 字符`);
  console.log(pageText.slice(0, 300));
  if (pageText.length > 300) console.log('      ... (截断)');

  // 8. 截图
  section('截图 (browser_screenshot)');
  const { raw: screenshotResult } = await callTool(client, 'browser_screenshot', { env_id: envId });
  const imgContent = screenshotResult.content?.find(c => c.type === 'image');
  if (imgContent) {
    const sizeKB = Math.round(Buffer.from(imgContent.data, 'base64').length / 1024);
    log('✓', `截图成功: ${sizeKB}KB (base64)`);
    // 保存到文件
    const fs = require('fs');
    const outPath = path.join(__dirname, 'screenshot.png');
    fs.writeFileSync(outPath, Buffer.from(imgContent.data, 'base64'));
    log('✓', `已保存到: ${outPath}`);
  } else {
    log('⚠', `截图返回: ${screenshotResult.content?.[0]?.text || 'unknown'}`);
  }

  // 9. 查看环境 Tab
  section('查看环境 Tab (env_tabs)');
  const { text: tabsText } = await callTool(client, 'env_tabs', { env_id: envId });
  log('✓', tabsText);

  // 10. 关闭环境
  section('关闭环境 (env_close)');
  const { text: closeText } = await callTool(client, 'env_close', { env_id: envId });
  log('✓', closeText);

  // 11. 关闭浏览器
  section('关闭浏览器 (browser_stop)');
  const { text: stopText } = await callTool(client, 'browser_stop');
  log('✓', stopText);

  // 报告
  console.log('\n' + '═'.repeat(50));
  console.log('  ✓ 测试完成');
  console.log('═'.repeat(50));

  if (stderrBuf) {
    console.log('\n  Server stderr:');
    console.log(stderrBuf.slice(0, 500));
  }

  await client.close();
}

main().catch(e => {
  console.error('\n  ✗ 测试失败:', e.message || e);
  process.exit(1);
});
