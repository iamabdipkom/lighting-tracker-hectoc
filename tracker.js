const axios = require('axios');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');
const Product = require('./product');

// How many products we scrape in parallel. This only matters for the slow
// per-page HTML fallback path (the fast bulk /products.json path in
// catalog.js doesn't use this at all). Kept modest on purpose: this path
// hits the store hundreds/thousands of times in a row, and going too high
// is what gets an IP rate-limited (429) or blocked outright - which then
// makes everything slower, not faster. Raise/lower via env if needed.
const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY, 10) || 6;

// Reused, keep-alive connections instead of a fresh TCP+TLS handshake per
// request - this alone removes a large chunk of per-request latency when
// hitting the same host hundreds of times in a row.
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9'
};

const REQUEST_TIMEOUT_MS = 10000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fetches raw HTML for a product page. Tries a direct request first (fast,
// reuses the keep-alive pool). On a 429 (rate limited), backs off and
// retries the direct request rather than immediately treating it as a
// failure - a 429 means "slow down", not "this page is broken". Only falls
// back to the AllOrigins proxy for non-429 failures, since the proxy is a
// free third-party service and is noticeably slower and flakier, so it's a
// last resort, not the default.
async function fetchHtml(url, attempt = 1) {
  try {
    const direct = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent
    });
    return direct.data;
  } catch (directError) {
    const status = directError.response?.status;
    if (status === 429 && attempt < 4) {
      const retryAfterHeader = directError.response.headers['retry-after'];
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : attempt * 1500;
      console.log(`⏳ Rate limited (429) on ${url}, waiting ${waitMs}ms before retry ${attempt}/3...`);
      await sleep(waitMs);
      return fetchHtml(url, attempt + 1);
    }
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const proxied = await axios.get(proxyUrl, {
      timeout: REQUEST_TIMEOUT_MS,
      httpsAgent: keepAliveHttpsAgent
    });
    if (!proxied.data || !proxied.data.contents) {
      throw new Error('Proxy returned no content');
    }
    return proxied.data.contents;
  }
}

// Parses out the fields we care about from a product page's HTML.
async function scrapeOnce(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  const priceRaw =
    $('meta[property="og:price:amount"]').attr('content') ||
    $('.price-item--sale, .price-item--regular, .price').first().text().trim();
  const sku = $('meta[property="og:sku"]').attr('content') || null;

  if (!name || !priceRaw) {
    throw new Error(`Missing ${!name ? 'title' : ''}${!name && !priceRaw ? '/' : ''}${!priceRaw ? 'price' : ''} on page (not a valid product URL?): ${url}`);
  }

  const currentPrice = parseFloat(String(priceRaw).replace(/[^0-9.]/g, ''));
  if (isNaN(currentPrice)) {
    throw new Error(`Could not parse a numeric price from "${priceRaw}"`);
  }

  return { name, currentPrice, sku };
}

// Scrapes one product and reconciles it against MongoDB, preserving every
// past price it has ever had in priceHistory (not just the last one).
async function processProduct(url) {
  let scraped;
  try {
    scraped = await scrapeOnce(url);
  } catch (firstError) {
    // One quick retry - a short jitter, not a multi-second sleep, since
    // most transient failures (timeouts, brief 5xx) clear almost instantly.
    await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 250));
    scraped = await scrapeOnce(url);
  }

  const { name, currentPrice, sku } = scraped;
  const product = await Product.findOne({ url });

  if (!product) {
    await Product.create({
      name,
      url,
      sku: sku || 'N/A',
      currentPrice,
      previousPrice: null,
      hasChangedToday: false,
      lastUpdated: new Date(),
      priceHistory: [{ price: currentPrice, date: new Date() }]
    });
    console.log(`🆕 Registered: "${name.substring(0, 40)}" at $${currentPrice}`);
    return;
  }

  if (currentPrice !== product.currentPrice) {
    console.log(`🚨 PRICE SHIFT [${name.substring(0, 30)}]: $${product.currentPrice} -> $${currentPrice}`);
    product.previousPrice = product.currentPrice;
    product.currentPrice = currentPrice;
    product.hasChangedToday = true;
    product.priceChangedAt = new Date();
    product.lastUpdated = new Date();
    product.priceHistory.push({ price: currentPrice, date: new Date() });
    await product.save();
  } else {
    // Unchanged - just bump lastUpdated. Note: hasChangedToday is deliberately
    // NOT reset here. With this running continuously all day, resetting it on
    // every unchanged pass would erase "changed today" flags set earlier in
    // the same day. It only gets cleared once, by the daily cron reset.
    product.lastUpdated = new Date();
    await product.save();
  }
}

// Runs a fixed-size pool of workers that keep pulling the next URL off a
// shared queue until it's empty - this is what gives true parallelism
// instead of one request finishing before the next one starts.
async function runWithConcurrency(urls, concurrency) {
  const queue = [...urls];
  let completed = 0;
  let failed = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      try {
        await processProduct(url);
        completed++;
      } catch (error) {
        failed++;
        console.error(`❌ Scraping bypass pipeline failed for ${url}: ${error.message}`);
      }
    }
  };

  const workerCount = Math.min(concurrency, urls.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, worker));

  return { completed, failed };
}

async function trackPrices(urls) {
  console.log(`⏱️ Beginning sync loop for ${urls.length} target records (concurrency: ${CONCURRENCY})...`);
  const { completed, failed } = await runWithConcurrency(urls, CONCURRENCY);
  console.log(`🏁 Cycle complete! ${completed} updated, ${failed} failed.`);
}

// Reconciles a batch of already-fetched product data (name/url/sku/price)
// against MongoDB. Unlike trackPrices(), this does NO network scraping per
// product - it assumes the data was already pulled in bulk (e.g. from
// catalog.js's /products.json fetch) and just needs to be diffed against
// what's stored. That turns "thousands of HTTP requests" into "handful of
// HTTP requests + 2-3 database round-trips", regardless of catalog size.
async function syncCatalog(products) {
  console.log(`⏱️ Syncing ${products.length} products from catalog snapshot...`);

  const urls = products.map(p => p.url);
  const existingDocs = await Product.find({ url: { $in: urls } }).lean();
  const existingByUrl = new Map(existingDocs.map(doc => [doc.url, doc]));

  const toInsert = [];
  const bulkUpdateOps = [];
  let changedCount = 0;

  for (const { name, url, sku, currentPrice } of products) {
    const existing = existingByUrl.get(url);

    if (!existing) {
      toInsert.push({
        name,
        url,
        sku: sku || 'N/A',
        currentPrice,
        previousPrice: null,
        hasChangedToday: false,
        lastUpdated: new Date(),
        priceHistory: [{ price: currentPrice, date: new Date() }]
      });
      continue;
    }

    if (currentPrice !== existing.currentPrice) {
      changedCount++;
      console.log(`🚨 PRICE SHIFT [${name.substring(0, 30)}]: $${existing.currentPrice} -> $${currentPrice}`);
      bulkUpdateOps.push({
        updateOne: {
          filter: { url },
          update: {
            $set: {
              name,
              sku: sku || 'N/A',
              previousPrice: existing.currentPrice,
              currentPrice,
              hasChangedToday: true,
              priceChangedAt: new Date(),
              lastUpdated: new Date()
            },
            $push: { priceHistory: { price: currentPrice, date: new Date() } }
          }
        }
      });
    } else {
      bulkUpdateOps.push({
        updateOne: {
          filter: { url },
          update: { $set: { name, sku: sku || 'N/A', lastUpdated: new Date() } }
        }
      });
    }
  }

  if (toInsert.length > 0) {
    await Product.insertMany(toInsert, { ordered: false });
  }
  if (bulkUpdateOps.length > 0) {
    await Product.bulkWrite(bulkUpdateOps, { ordered: false });
  }

  console.log(`🏁 Catalog sync complete! ${toInsert.length} new, ${changedCount} changed, ${bulkUpdateOps.length - changedCount} unchanged.`);
}

module.exports = { trackPrices, syncCatalog };
