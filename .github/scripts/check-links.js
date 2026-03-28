import { chromium } from 'playwright';
import * as fs from 'fs';

const CONCURRENCY = 10;
const blockedDomains = [
  'youtube.com',
  '4beta.orangedatamining.com',
  'youtu.be',
  'googletagmanager.com',
  'google-analytics.com',
];


(async () => {

  const urlsToCheck = process.argv.slice(2);
  let urlPtr = 0;
  const getNextUrl = async () =>
    await navigator.locks.request(
      'crawler-queue',
      async () => urlPtr < urlsToCheck.length ? urlsToCheck[urlPtr++] : null);

  const results = {};  // key is target url, value [status, ok (true/false), source-url]

  const browser = await chromium.launch();
  //const browser = await chromium.launch({ headless: false });

  const worker = async () => {
    for(let url; url = await getNextUrl(); ) {
      const page = await browser.newPage();
      const probe = async (url, sourceUrl) => {
        results[url] = ["PROCESSING"];
        try {
          const response = await page.context().request.head(url);
          results[url] = [response.status(), response.ok(), sourceUrl];
          return response.ok();
        }
        catch (err) {
          results[url] = [err.message ? err.message.split('\n')[0] : 'Unknown Error', false, sourceUrl];
          //results[url] = ["CONN", false, sourceUrl];
          return false;
        }
      }

      if (!await probe(url)) {
        continue;
      }

      await page.route('**/*', (route) => {
        const url = route.request().url();
        const type = route.request().resourceType();
        if (type === 'subframe' || blockedDomains.some(domain => url.includes(domain))) {
          return route.abort();
        }
        return route.continue();
      });

      try {
        const response = await page.goto(url, { waitUntil: "networkidle", timeout: 5000 });
        if (response.ok()) {
          const extractedUrls = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a')).map(a => a.href);
            const imgs = Array.from(document.querySelectorAll('img')).map(img => img.src);
            return [...links, ...imgs]
              .filter(url => typeof url === 'string' && url.trim().startsWith("http"))
              .map(url => {
                try {
                  const parsed = new URL(url);
                  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    return null;
                  }
                  parsed.hash = '';
                  return parsed.href;
                } catch(e){
                  results[url] = ["MALFORMED", false, sourceUrl];
                  return null;
                }
              })
              .filter(Boolean);
          });
          for(const subUrl of extractedUrls) {
            await probe(subUrl, url);
          }
        }
      } catch (err) {
        if (err.name !== 'TimeoutError') {
          results[url] = ['FAILED', false, sourceUrl];
        }
      } finally {
        await page.close();
      }
    }
  }

  const workerPool = [];
  const activeWorkers = Math.min(CONCURRENCY, urlsToCheck.length);
  for (let i = 0; i < activeWorkers; i++) {
    workerPool.push(worker());
  }

  await Promise.all(workerPool);
  await browser.close();

  const brokenLinks = Object.values(results).filter(([, ok]) => !ok);

  let markdown = `\n\n`;
  if (brokenLinks.length > 0) {
      markdown += `| Code | URL | source URL |\n|---|---|---|\n`;
      markdown += Object.entries(results)
        .filter(([, [, ok]]) => !ok)
        .map(([url, [status,, sourceUrl]]) => `| ${status} | ${url} | ${sourceUrl} |\n`)
    .join("");
  }
  markdown += `
<details><summary>List of checked URLs</summary>

${ Object.keys(results).map((s) => `- ${s}\n`).join("") }

</details>
`;

  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }

  if (brokenLinks.length > 0) {
    console.error(`Found ${brokenLinks.length} broken links!`);
    process.exit(1);
  } else {
    console.log("All links are healthy.");
  }
})();
