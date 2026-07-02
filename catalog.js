const axios = require('axios');
const http = require('http');
const https = require('https');

const PAGE_SIZE = 250; // Shopify's hard max for this endpoint
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 5;
// Small pause between successful page requests. This is what stops us from
// tripping the store's rate limiter in the first place - going full-speed
// with zero pacing is exactly what produced the 429s. A few hundred ms per
// page is negligible against a handful of total requests.
const PAGE_DELAY_MS = parseInt(process.env.CATALOG_PAGE_DELAY_MS, 10) || 800;

const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fetches one products.json page, retrying with backoff specifically on 429
// (rate limited) instead of giving up immediately - a 429 means "slow down",
// not "this failed forever". Honours the Retry-After header when present.
async function fetchPage(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: REQUEST_TIMEOUT_MS,
        httpAgent: keepAliveHttpAgent,
        httpsAgent: keepAliveHttpsAgent
      });
    } catch (error) {
      const status = error.response?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfterHeader = error.response.headers['retry-after'];
        const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : attempt * 2000;
        console.log(`⏳ Rate limited (429) fetching catalog page, waiting ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
}

// Every Shopify store publishes a public catalog endpoint at /products.json
// that returns up to 250 full product records per request - title, sku, and
// every variant's price - with no HTML to download or parse. Paginating
// this endpoint pulls the ENTIRE catalog in a handful of requests instead
// of one request per product. For a few thousand products that's the
// difference between dozens of requests and thousands.
async function fetchFullCatalog(baseUrl) {
  const products = [];
  let page = 1;

  while (true) {
    const url = `${baseUrl}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const response = await fetchPage(url);

    const pageProducts = response.data?.products || [];
    if (pageProducts.length === 0) break;

    for (const p of pageProducts) {
      const variants = p.variants || [];
      if (!p.handle || variants.length === 0) continue;

      const prices = variants
        .map(v => parseFloat(v.price))
        .filter(n => !isNaN(n));
      if (prices.length === 0) continue;

      products.push({
        name: p.title,
        url: `${baseUrl}/products/${p.handle}`,
        sku: variants[0].sku || 'N/A',
        // Use the cheapest variant as the tracked price - matches what a
        // "from $X" listing price usually reflects for multi-variant items.
        currentPrice: Math.min(...prices)
      });
    }

    // Shopify returns fewer than PAGE_SIZE items on the last page.
    if (pageProducts.length < PAGE_SIZE) break;
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return products;
}

module.exports = { fetchFullCatalog };
