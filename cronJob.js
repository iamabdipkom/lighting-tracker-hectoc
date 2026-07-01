const cron = require('node-cron');
const nodemailer = require('nodemailer');
// ✅ FIXED: Path adjusted to find product.js directly in your root folder layout
const Product = require('./product'); 
const { trackPrices } = require('./tracker');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// Automatically pulls store sitemap items for the scheduled cron cycles.
// Shopify stores publish a top-level sitemap INDEX at /sitemap.xml that links out
// to separate sitemaps per content type (products, collections, pages, blogs) with
// store-specific filenames - hardcoding "sitemap_products_1.xml" isn't safe. Instead
// we read the index first, then follow every "sitemap_products*" entry it lists.
async function getSitemapUrls() {
  const parser = new XMLParser();
  const requestOptions = {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LightingTrackerBot/1.0)' },
    timeout: 15000
  };

  try {
    const indexResponse = await axios.get('https://www.bestbuylighting.com.au/sitemap.xml', requestOptions);
    const indexObj = parser.parse(indexResponse.data);

    const sitemapEntries = indexObj?.sitemapindex?.sitemap;
    const allSitemaps = Array.isArray(sitemapEntries) ? sitemapEntries : [sitemapEntries].filter(Boolean);
    const productSitemapUrls = allSitemaps
      .map(entry => entry.loc)
      .filter(loc => loc && loc.includes('sitemap_products'));

    if (productSitemapUrls.length === 0) {
      console.error('❌ Cron sitemap pull found no product sitemaps listed in the index.');
      return [];
    }

    let productUrls = [];
    for (const sitemapUrl of productSitemapUrls) {
      const response = await axios.get(sitemapUrl, requestOptions);
      const jsonObj = parser.parse(response.data);
      const urlEntries = jsonObj?.urlset?.url;
      const entries = Array.isArray(urlEntries) ? urlEntries : [urlEntries].filter(Boolean);
      productUrls = productUrls.concat(entries.map(item => item.loc));
    }

    return productUrls;
  } catch (error) {
    console.error("❌ Cron sitemap pull failed:", error.message);
    return [];
  }
}

// Configures automated background email alerting dispatch engine
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Scheduled cron cycle: Executes every single day at midnight (00:00)
cron.schedule('0 0 * * *', async () => {
  console.log("⏰ Scheduled midnight database audit and price verification cycle spinning up...");
  
  const urls = await getSitemapUrls();
  if (urls.length > 0) {
    // Execute full catalog update scanning sequence
    await trackPrices(urls);
    
    try {
      // Gather any items that registered a price variation flag during the loop
      const changedProducts = await Product.find({ hasChangedToday: true }).lean();
      
      if (changedProducts.length > 0) {
        let emailContent = '<h3>🚨 Price Shift Discovered for Tracked Catalog Items</h3><ul>';
        changedProducts.forEach(p => {
          emailContent += `<li><strong>${p.name}</strong> has updated. New Price: $${p.currentPrice}. <a href="${p.url}">View Item</a></li>`;
        });
        emailContent += '</ul>';
        
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.REPORT_EMAILS,
          subject: `🛒 Price Alert Update: ${changedProducts.length} Changes Detected!`,
          html: emailContent
        });
        console.log("📩 Automated daily variation digests dispatched to target email inbox vectors.");
      } else {
        console.log("🧘 Audit complete. No item changes found today. Email dispatch suppressed.");
      }
    } catch (emailError) {
      console.error("❌ Failed to compile or send cron daily alert email:", emailError.message);
    }
  }

  await resetDailyChangeFlags();
}, {
  scheduled: true,
  timezone: "Australia/Sydney"
});

console.log("⏰ Background cron schedule verified and running in Australia/Sydney time.");

// Reset the "changed today" flag for the whole catalog once daily, right after
// the audit + email above. tracker.js's continuous loop only ever flips this
// flag to true on a real price change and never resets it itself (so it can
// run every few minutes all day without wiping earlier same-day alerts) -
// this cron job is the one place that clears it, giving a clean slate per day.
async function resetDailyChangeFlags() {
  try {
    const result = await Product.updateMany({}, { $set: { hasChangedToday: false } });
    console.log(`🧹 Daily reset: cleared hasChangedToday on ${result.modifiedCount} products.`);
  } catch (error) {
    console.error('❌ Failed to reset daily change flags:', error.message);
  }
}

module.exports = { getSitemapUrls, resetDailyChangeFlags };
