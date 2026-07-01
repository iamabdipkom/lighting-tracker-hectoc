require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { engine } = require('express-handlebars');

// Linux Casing Fixes: Lowercase paths to match common file-system uploads safely
const Product = require('./models/product'); 
const { trackPrices } = require('./tracker');
require('./cronJob'); 

const app = express();

app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', './views');

// Dynamically read from Render's Environment Variables setting panel
const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI)
  .then(() => console.log("✅ SUCCESS! Cloud Server Connected straight to MongoDB Atlas!"))
  .catch(err => console.error("❌ MongoDB Connection Error: ", err.message));

// Automatically pulls all products using Shopify sitemap indices
async function discoverAllProducts() {
  try {
    console.log("🔍 Extracting product inventory catalog from site architecture...");
    const response = await axios.get('https://www.bestbuylighting.com.au/sitemap_products_1.xml');
    
    const parser = new XMLParser();
    const jsonObj = parser.parse(response.data);
    
    const urls = jsonObj.urlset.url.map(item => item.loc);
    console.log(`🎯 Auto-discovered ${urls.length} live product links from catalog!`);
    return urls;
  } catch (error) {
    console.error("❌ Failed to auto-pull store sitemap:", error.message);
    return [];
  }
}

app.get('/', async (req, res) => {
  try {
    const alerts = await Product.find({ hasChangedToday: true }).lean();
    const trackedProducts = await Product.find({}).lean();
    const inventory = trackedProducts.map(p => ({
      ...p,
      lastUpdatedFormatted: p.lastUpdated ? new Date(p.lastUpdated).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : 'Pending Initial Check'
    }));
    res.render('dashboard', { alerts, inventory, totalCount: inventory.length });
  } catch (error) {
    res.status(500).send("Error loading dashboard panel: " + error.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`24/7 Cloud Tracker Dashboard initializing on port ${PORT}`);
  
  const dynamicUrls = await discoverAllProducts();
  if (dynamicUrls.length > 0) {
    console.log("🚀 Initializing complete store scraping cycle...");
    trackPrices(dynamicUrls);
  }
});
