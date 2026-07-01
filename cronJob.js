const cron = require('node-cron');
const nodemailer = require('nodemailer');
// ✅ FIXED: Path adjusted to find product.js directly in your root folder layout
const Product = require('./product'); 
const { trackPrices } = require('./tracker');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// Automatically pulls store sitemap items for the scheduled cron cycles
async function getSitemapUrls() {
  try {
    const response = await axios.get('https://www.bestbuylighting.com.au/sitemap_products_1.xml');
    const parser = new XMLParser();
    const jsonObj = parser.parse(response.data);
    return jsonObj.urlset.url.map(item => item.loc);
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
          emailContent += `<li><strong>${p.title}</strong> has updated. New Price: $${p.currentPrice}. <a href="${p.url}">View Item</a></li>`;
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
}, {
  scheduled: true,
  timezone: "Australia/Sydney"
});

console.log("⏰ Background cron schedule verified and running in Australia/Sydney time.");
