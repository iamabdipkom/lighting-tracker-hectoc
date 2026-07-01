require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { engine } = require('express-handlebars');

// Paths adjusted to find files directly in your main root directory
const Product = require('./product'); 
const { trackPrices } = require('./tracker');
const { getSitemapUrls } = require('./cronJob');
require('./cronJob'); 

const app = express();

// Configured with defaultLayout: false to bypass looking for a layouts folder completely
app.engine('handlebars', engine({ defaultLayout: false }));
app.set('view engine', 'handlebars');
app.set('views', './'); 

// Dynamically read from Render's Environment Variables setting panel
const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI)
  .then(() => console.log("✅ SUCCESS! Cloud Server Connected straight to MongoDB Atlas!"))
  .catch(err => console.error("❌ MongoDB Connection Error: ", err.message));

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
app.listen(PORT, () => {
  console.log(`24/7 Cloud Tracker Dashboard initializing on port ${PORT}`);
  // Fire-and-forget: the loop below runs for the life of the process,
  // independently of the request/response cycle.
  runContinuousTrackingLoop();
});

// Continuously tracks every product on the site. Pulls the full product list
// from the store's sitemap (not a hardcoded 2-item list), scrapes it with
// tracker.js's concurrent worker pool, and as soon as one full pass finishes
// goes straight back to the top of the loop with no delay - so the catalog is
// being re-checked back-to-back, 24/7, for as long as the server is running.
async function runContinuousTrackingLoop() {
  while (true) {
    try {
      const urls = await getSitemapUrls();
      if (urls.length === 0) {
        console.error('⚠️ Sitemap returned no product URLs - retrying immediately.');
        continue;
      }
      console.log(`🚀 Starting full catalog scraping cycle for ${urls.length} items...`);
      await trackPrices(urls);
    } catch (error) {
      console.error('❌ Continuous tracking loop error:', error.message);
    }
    // No delay - loop restarts the instant the previous pass finishes.
  }
}
