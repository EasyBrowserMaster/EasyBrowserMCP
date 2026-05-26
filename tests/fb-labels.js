const { chromium } = require('patchright');
async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts().flatMap(c => c.pages());
  const page = pages.find(p => p.url().includes('facebook'));
  const labels = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="button"][aria-label]')]
      .map(e => e.getAttribute('aria-label'))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 40);
  });
  console.log(labels.join('\n'));
  await browser.close();
}
run();
