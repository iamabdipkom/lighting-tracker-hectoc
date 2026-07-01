const axios = require('axios');
const cheerio = require('cheerio');
// ✅ FIXED: Path adjusted to find product.js directly in your root folder layout
const Product = require('./product'); 

// Main function to iterate through store links and scrape data points
async function trackPrices(urls) {
  console.log(`⏱️ Beginning sync loop for ${urls.length} target records...`);
  
  for (const url of urls) {
    try {
      // Small defensive delay to prevent aggressive rate limiting on the cloud IP
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      
      // Parse structured details out of standard storefront layout wrappers
      const title = $('.product-meta__title').text().trim() || $('h1').text().trim();
      const priceRaw = $('.price--highlight').text().trim() || $('.price').text().trim();
      const sku = $('.product-meta__sku-number').text().trim() || 'N/A';
      
      if (!title || !priceRaw) continue;
      
      // Clean up currency signs and commas to extract a true mathematical decimal
      const numericPrice = parseFloat(priceRaw.replace(/[^0-9.]/g, ''));
      
      // Look for a matching historical document in MongoDB Cluster
      let product = await Product.findOne({ url });
      
      if (!product) {
        // Build initial inventory baseline for newly discovered items
        product = new Product({
          title,
          url,
          sku,
          originalPrice: numericPrice,
          currentPrice: numericPrice,
          priceHistory: [{ price: numericPrice, date: new Date() }],
          hasChangedToday: false,
          lastUpdated: new Date()
        });
        await product.save();
        console.log(`🆕 Registered baseline catalog item: "${title.substring(0, 30)}..." at $${numericPrice}`);
      } else {
        // Run comparison matrices against the existing cloud data record
        if (numericPrice !== product.currentPrice) {
          console.log(`🚨 PRICE DRIFT DETECTED for "${title.substring(0, 30)}...": $${product.currentPrice} -> $${numericPrice}`);
          
          product.priceHistory.push({ price: numericPrice, date: new Date() });
          product.currentPrice = numericPrice;
          product.hasChangedToday = true;
          product.lastUpdated = new Date();
          await product.save();
        } else {
          // Document checked, price stable
          product.hasChangedToday = false;
          product.lastUpdated = new Date();
          await product.save();
        }
      }
    } catch (error) {
      console.error(`⚠️ Edge node bypass failed for URL: ${url.substring(0, 40)}... - ${error.message}`);
    }
  }
  console.log("🏁 Cycle complete! Cloud tracking matrix idling until next interval.");
}

module.exports = { trackPrices };
