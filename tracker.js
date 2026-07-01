const axios = require('axios');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');
const Product = require('./product');

// How many products we scrape in parallel. This is the main speed lever:
// the old code did everything one-at-a-time with fixed sleeps between each
// request, so total time was ~5s * number of products. Raise/lower via env
// if the site starts throwing 429s/403s at a given concurrency.
const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY, 10) || 10;

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

// Fetches raw HTML for a product page. Tries a direct request first (fast,
// reuses the keep-alive pool). Only falls back to the AllOrigins proxy if
// the direct request is blocked - the proxy is a free third-party service
// and is noticeably slower and flakier, so it's a fallback, not the default.
async function fetchHtml(url) {
  try {
    const direct = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent
    });
    return direct.data;
  } catch (directError) {
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

module.exports = { trackPrices };
