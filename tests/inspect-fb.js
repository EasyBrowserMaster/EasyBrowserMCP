const { chromium } = require('patchright');
async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts().flatMap(c => c.pages());
  const page = pages.find(p => p.url().includes('facebook')) || pages[pages.length-1];

  // Scroll down a bit to load feed posts
  await page.mouse.wheel(0, 500);
  await new Promise(r => setTimeout(r, 2000));

  const info = await page.evaluate(`
    (() => {
      // Find feed posts - they usually have data-ad-comet-above-more-menu or contain like/comment/share actions
      const results = [];
      // Look for the action bar (Like, Comment, Share buttons)
      const actionBars = document.querySelectorAll('[aria-label="Like"], [aria-label="Comment"], [aria-label="Share"]');
      actionBars.forEach((el, i) => {
        if (i >= 10) return;
        results.push({
          label: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          tag: el.tagName,
          parent: el.parentElement?.className?.slice(0,50),
          text: el.innerText?.slice(0,20)
        });
      });

      // Also check for spans with "Like" text
      const spans = [];
      document.querySelectorAll('span').forEach(s => {
        const t = s.innerText;
        if (t === 'Like' || t === 'Comment' || t === 'Share' || t === 'Me gusta' || t === 'Comentar' || t === 'Compartir') {
          spans.push({text: t, role: s.closest('[role]')?.getAttribute('role'), ariaLabel: s.closest('[aria-label]')?.getAttribute('aria-label')});
        }
      });

      return JSON.stringify({actionButtons: results, spans: spans.slice(0,15)});
    })()
  `);
  console.log(JSON.parse(info));
  await browser.close();
}
run().catch(e => console.error(e.message));
