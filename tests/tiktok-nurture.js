const { chromium } = require('patchright');

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts().flatMap(c => c.pages());
  const page = pages.find(p => p.url().includes('tiktok')) || pages[pages.length - 1];

  // 1. 关闭弹窗 - 直接点击 X 按钮 (svg close icon)
  console.log('1. 关闭弹窗...');
  // 弹窗右上角的 X 按钮
  const closeBtn = page.locator('div[role="dialog"] button, [aria-label="Close"], [data-e2e="modal-close-inner-button"]').first();
  await closeBtn.click({ timeout: 3000 }).catch(async () => {
    // fallback: 点击坐标 (X 按钮大约在弹窗右上角)
    console.log('   用坐标点击 X...');
    await page.mouse.click(800, 237);
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: 'tests/tiktok-after-close.png' });
  console.log('   弹窗处理完毕');

  // 2. 点击视频区域获取焦点
  await page.mouse.click(600, 500);
  await new Promise(r => setTimeout(r, 500));

  // 3. 滚动浏览视频
  console.log('2. 开始浏览视频...');
  for (let i = 1; i <= 5; i++) {
    const delay = 3000 + Math.floor(Math.random() * 4000);
    await new Promise(r => setTimeout(r, delay));
    await page.keyboard.press('ArrowDown');
    await new Promise(r => setTimeout(r, 1500));
    console.log('   视频 ' + i + '/5 (停留' + (delay / 1000).toFixed(1) + 's)');
  }

  // 4. 截图
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'tests/tiktok-final.png' });
  console.log('3. 截图: tests/tiktok-final.png');

  await browser.close();
  console.log('完成!');
}
run().catch(e => console.error('Error:', e.message));
