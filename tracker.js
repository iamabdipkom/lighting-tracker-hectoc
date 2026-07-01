const axios = require('axios');
const cheerio = require('cheerio');
const Product = require('./product');

// Browser-like headers so the store doesn't immediately treat us as a bot.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9'
};

const REQUEST_TIMEOUT_MS = 15000;

// Fetches raw HTML for a product page.
// Tries a direct request first (fast, no dependency on a third-party proxy).
// Only falls back to the AllOrigins proxy if the direct request is blocked,
// since AllOrigins is a free public service that is often rate-limited or down.
async function fetchHtml(url) {
  try {
    const direct = await axios.get(url, { headers: BROWSER_HEADERS, timeout: REQUEST_TIMEOUT_MS });
    return direct.data;
  } catch (directError) {
    console.log(`↪️ Direct fetch failed (${directError.message}), retrying via proxy for: ${url}`);
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const proxied = await axios.get(proxyUrl, { timeout: REQUEST_TIMEOUT_MS });
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
    throw new Error('Data point missing from HTML packet structure');
  }

  const currentPrice = parseFloat(String(priceRaw).replace(/[^0-9.]/g, ''));
  if (isNaN(currentPrice)) {
    throw new Error(`Could not parse a numeric price from "${priceRaw}"`);
  }

  return { name, currentPrice, sku };
}

async function trackPrices(urls) {
  console.log(`⏱️ Beginning sync loop for ${urls.length} target records...`);

  for (const url of urls) {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));

      let scraped;
      try {
        scraped = await scrapeOnce(url);
      } catch (firstError) {
        // One retry after a short delay - proxies and stores can be flaky under load
        console.log(`🔁 Retrying ${url} after error: ${firstError.message}`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        scraped = await scrapeOnce(url);
      }

      const { name, currentPrice, sku } = scraped;

      // IMPORTANT: field names below must match product.js's schema exactly
      // (name, url, sku, currentPrice, previousPrice, hasChangedToday, priceChangedAt, lastUpdated).
      // The previous version saved "title", "originalPrice" and "priceHistory", none of which
      // exist on the schema - and "name" is a required field that was never being set, so
      // every single save() call was silently throwing a Mongoose ValidationError and getting
      // swallowed by the catch block below (that's the real reason nothing ever reached MongoDB).
      let product = await Product.findOne({ url });

      if (!product) {
        product = new Product({
          name,
          url,
          sku: sku || 'N/A',
          currentPrice,
          previousPrice: null,
          hasChangedToday: false,
          lastUpdated: new Date()
        });
        await product.save();
        console.log(`🆕 SUCCESS! Registered item to database: "${name.substring(0, 30)}..." at $${currentPrice}`);
      } else if (currentPrice !== product.currentPrice) {
        console.log(`🚨 PRICE SHIFT: $${product.currentPrice} -> $${currentPrice}`);
        product.previousPrice = product.currentPrice;
        product.currentPrice = currentPrice;
        product.hasChangedToday = true;
        product.priceChangedAt = new Date();
        product.lastUpdated = new Date();
        await product.save();
      } else {
        product.hasChangedToday = false;
        product.lastUpdated = new Date();
        await product.save();
      }
    } catch (error) {
      console.error(`❌ Scraping bypass pipeline failed for ${url}: ${error.message}`);
    }
  }
  console.log("🏁 Cycle complete! Cloud database records updated.");
}

module.exports = { trackPrices };
