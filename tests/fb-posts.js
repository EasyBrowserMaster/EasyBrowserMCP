const { chromium } = require('patchright');
async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts().flatMap(c => c.pages());
  const page = pages.find(p => p.url().includes('facebook'));

  // Scroll to load more
  await page.mouse.wheel(0, 800);
  await new Promise(r => setTimeout(r, 3000));

  const info = await page.evaluate(() => {
    // Strategy: find all Like buttons, then for each one walk up to find the post boundary
    // The post boundary is typically a container that has both the author link and the like button
    const likeBtns = document.querySelectorAll('[role="button"][aria-label="Like"]');
    const posts = [];
    const seen = new Set();

    likeBtns.forEach((btn, i) => {
      if (i >= 10) return;
      // Walk up until we find a container with enough content
      let container = btn.parentElement;
      for (let j = 0; j < 10; j++) {
        if (!container) break;
        container = container.parentElement;
      }
      if (!container) return;

      // Find author: first <a> with a user profile link (contains /user/ or has strong text)
      let author = '';
      const links = container.querySelectorAll('a[href*="/user"], a[href*="/profile"], a[href*="/groups/"], h2 a, h3 a, h4 a, strong');
      for (const link of links) {
        const t = link.innerText?.trim();
        if (t && t.length > 1 && t.length < 60 && !t.includes('Facebook') && !seen.has(t)) {
          author = t;
          break;
        }
      }

      // Find post text: look for dir="auto" spans/divs with actual content
      let postText = '';
      const candidates = container.querySelectorAll('[dir="auto"]');
      for (const c of candidates) {
        const t = c.innerText?.trim() || '';
        if (t.length > 20 && t.length < 500 && !t.includes('Facebook') && t !== author) {
          postText = t;
          break;
        }
      }

      const key = author + postText.slice(0, 30);
      if (seen.has(key)) return;
      seen.add(key);

      posts.push({
        index: i,
        author: author || '(unknown)',
        text: postText.slice(0, 150) || '(no text)',
        isAd: container.innerText?.includes('Sponsored') || container.innerText?.includes('Suggested for you') || false,
      });
    });
    return posts;
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}
run();
