const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const Product = require('./models/Product');

async function trackPrices(urls) {
  // Configured specifically to run efficiently on macOS
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  // Set user agent to simulate a standard MacBook Chrome browser to prevent blocking
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const html = await page.content();
      const $ = cheerio.load(html);

      // --- TARGET CLASSES (See "The Heads Up" Section below) ---
      const productName = $('.product-meta__title, h1.product-title, .product-single__title').first().text().trim();
      const priceText = $('.price-item--sale, .price__current, .price-item').first().text().trim();
      
      const scrapedPrice = parseFloat(priceText.replace(/[^0-9.]/g, ''));

      if (!scrapedPrice || !productName) {
        console.log(`[Skipped] Could not parse details for: ${url}`);
        continue;
      }

      let product = await Product.findOne({ url });

      if (!product) {
        // Step A: First time discovering the product (e.g., $5 baseline)
        product = new Product({
          name: productName,
          url: url,
          currentPrice: scrapedPrice
        });
        await product.save();
        console.log(`[Initial Track] Saved ${productName} with base price: $${scrapedPrice}`);
      } else {
        // Step B: Subsequent checks (e.g., comparing current price against old $5 baseline)
        if (scrapedPrice !== product.currentPrice) {
          console.log(`[ALERT] Price Shift: ${productName} moved from $${product.currentPrice} to $${scrapedPrice}`);
          
          product.previousPrice = product.currentPrice;
          product.currentPrice = scrapedPrice; // $10 now becomes the new baseline
          product.hasChangedToday = true;
          product.priceChangedAt = new Date();
          
          await product.save();
        }
      }
    } catch (error) {
      console.error(`Mac Scraping Error for ${url}:`, error.message);
    }
  }
  await browser.close();
}

module.exports = { trackPrices };