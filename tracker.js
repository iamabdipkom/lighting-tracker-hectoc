const axios = require('axios');
const cheerio = require('cheerio');
const Product = require('./product'); 

async function trackPrices(urls) {
  console.log(`⏱️ Beginning sync loop for ${urls.length} target records...`);
  
  for (const url of urls) {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // ✅ FIXED: Routes the request through a proxy wrapper to break the store's server block
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const response = await axios.get(proxyUrl);
      
      // AllOrigins returns the raw HTML inside a .contents property
      const htmlContents = response.data.contents;
      const $ = cheerio.load(htmlContents);
      
      // Updated targeted meta-selectors to reliably extract data points from Shopify layouts
      const title = $('meta[property="og:title"]').attr('content') || $('h1').text().trim();
      const priceRaw = $('meta[property="og:price:amount"]').attr('content') || $('.price').text().trim();
      const sku = $('meta[property="og:sku"]').attr('content') || 'N/A';
      
      if (!title || !priceRaw) {
        console.log(`⚠️ Skiped parsing for URL: Data point missing from HTML packet structure.`);
        continue;
      }
      
      const numericPrice = parseFloat(priceRaw.replace(/[^0-9.]/g, ''));
      if (isNaN(numericPrice)) continue;
      
      let product = await Product.findOne({ url });
      
      if (!product) {
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
        console.log(`🆕 SUCCESS! Registered item to database: "${title.substring(0, 30)}..." at $${numericPrice}`);
      } else {
        if (numericPrice !== product.currentPrice) {
          console.log(`🚨 PRICE SHIFT: $${product.currentPrice} -> $${numericPrice}`);
          product.priceHistory.push({ price: numericPrice, date: new Date() });
          product.currentPrice = numericPrice;
          product.hasChangedToday = true;
          product.lastUpdated = new Date();
          await product.save();
        } else {
          product.hasChangedToday = false;
          product.lastUpdated = new Date();
          await product.save();
        }
      }
    } catch (error) {
      console.error(`❌ Scraping bypass pipeline failed: ${error.message}`);
    }
  }
  console.log("🏁 Cycle complete! Cloud database records updated.");
}

module.exports = { trackPrices };
