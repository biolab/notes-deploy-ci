import { chromium } from 'playwright';
import * as fs from 'fs';

const CONCURRENCY = 10;


(async () => {
  const urlsToCheck = process.argv.slice(2).map((url) => [url]);
  const results = {};  // key is target url, value [status, ok (true/false), source-url]

  const browser = await chromium.launch();
  //const browser = await chromium.launch({ headless: false });

  const worker = async () => {
      while (urlsToCheck.length > 0) {
        const [url, sourceUrl] = urlsToCheck.shift();
        if (url in results) {
          continue;
        }
        else {
          results[url] = [];  // assign yourself to this url
        }

        const page = await browser.newPage();
        try {
          let response;
          try {
            if (!sourceUrl) {
              response = await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
            } else {
              response = await page.request.head(url);
            }
          }
          catch (err) {
            results[url] = [err.message ? err.message.split('\n')[0] : 'Unknown Error', false, sourceUrl];
            continue;
          }
          results[url] = [response.status(), response.ok(), sourceUrl];
          if (response.ok()) {
            const extractedUrls = await page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a')).map(a => a.href);
              const imgs = Array.from(document.querySelectorAll('img')).map(img => img.src);
              return [...links, ...imgs]
                 .filter(url => typeof url === 'string' && url.trim().startsWith("http"))
                 .map(url => {
                      try {
                        const parsed = new URL(url);
                        parsed.hash = '';
                        return decodeURI(parsed.toString());
                      } catch {
                        return null;
                      }
                    })
                .filter(Boolean);
            });
            if (!sourceUrl) { // don't recurse
              urlsToCheck.push(...extractedUrls.map(newUrl => [newUrl, url]));
            }
          }
        } catch (error) {
          results[url] = ['FAILED/TIMEOUT', false, sourceUrl];
        } finally {
          await page.close();
        }
      }
    };

  const workerPool = [];
  const activeWorkers = Math.min(CONCURRENCY, urlsToCheck.length);
  for (let i = 0; i < activeWorkers; i++) {
    workerPool.push(worker());
  }

  await Promise.all(workerPool);
  await browser.close();

  let markdown = `## 🔗 Broken Link Checker Results\n\n`;
  markdown += `| Status | Code | URL |\n|---|---|---|\n`;
  markdown += Object.entries(results)
    .sort(([url1, [, ok1]], [url2, [, ok2]]) => !ok1 && ok2 || url1 < url2 ? -1 : 1)
    .map(([url, [status, ok, sourceUrl]]) => `| ${ok ? '✅' : '❌'} ${status} | ${url} | ${sourceUrl} |\n`)
    .join("");

  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  const brokenCount = Object.values(results).filter(([, ok]) => !ok).length;
  if (brokenCount > 0) {
    console.error(`Found ${brokenCount} broken links!`);
    process.exit(1);
  } else {
    console.log("All links are healthy!");
  }
})();
