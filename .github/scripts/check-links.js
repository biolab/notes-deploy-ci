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
              await page.route('**/*', (route) => {
                const url = route.request().url();
                const type = route.request().resourceType();
                if (type === 'subframe' || url.includes('youtube.com')) {
                  return route.abort();
                }
                route.continue();
              });
              const blockedDomains = [
                  'youtube.com',
                  '4beta.orangedatamining.com',
                  'youtu.be',
                  'googletagmanager.com',
                  'google-analytics.com',
                ];

                const isBlockedDomain = blockedDomains.some(domain => url.includes(domain));
                if (isBlockedDomain) {
                  return route.abort();
                }
              page.on('request', request => console.log(`🚀 Requesting: [${request.resourceType()}] ${request.url()}`));

              // (Optional) Print when it finishes so you can see what is STUCK
              page.on('requestfinished', request => console.log(`✅ Finished: ${request.url()}`));
              page.on('requestfailed', request => console.log(`❌ Failed: ${request.url()}`));
              response = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
            } else {
              response = await page.context().request.head(url);
            }
          }
          catch (err) {
            results[url] = [err.message ? err.message.split('\n')[0] : 'Unknown Error', false, sourceUrl];
            //results[url] = ["CONN", false, sourceUrl];
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
