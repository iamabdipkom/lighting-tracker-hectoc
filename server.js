require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { engine } = require('express-handlebars');

// Paths adjusted to find files directly in your main root directory
const Product = require('./product'); 
const { trackPrices, syncCatalog } = require('./tracker');
const { getSitemapUrls } = require('./cronJob');
const { fetchFullCatalog } = require('./catalog');
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

const STORE_BASE_URL = 'https://www.bestbuylighting.com.au';

// Continuously tracks every product on the site, and as soon as one full
// pass finishes goes back to the top of the loop after a short pause - so
// the catalog is being re-checked continuously, 24/7, for as long as the
// server is running.
//
// NOTE ON THE DELAY: this used to be zero-delay ("restart the instant the
// previous pass finishes"). In practice that's what triggered the 429
// (rate limited) responses from the store's /products.json endpoint - the
// loop was re-hitting it again the instant it finished, with no break at
// all. A 429 forces a fallback to the much slower per-page scrape, which
// then hammers the store even harder and can saturate the process enough
// that Render's own health check stops getting a response (the "No open
// HTTP ports detected" messages). A short, bounded pause here is what
// actually keeps this fast and stable, rather than caught in a
// rate-limit -> slow-fallback -> unresponsive loop.
const CYCLE_DELAY_MS = parseInt(process.env.CYCLE_DELAY_MS, 10) || 5000;

// Fast path: pull the whole catalog in bulk from Shopify's public
// /products.json endpoint (catalog.js) and reconcile it in a couple of DB
// round-trips via tracker.syncCatalog(). No per-product HTTP scraping at
// all, which is what makes a full lap take seconds instead of tens of
// minutes to hours.
//
// Fallback: if the bulk endpoint ever fails (blocked, store disables it,
// network hiccup), fall back to the slower sitemap + per-page HTML scrape
// so tracking doesn't stop entirely - it just runs at the old, slower pace
// until the fast path works again on the next lap.
async function runContinuousTrackingLoop() {
  while (true) {
    try {
      const products = await fetchFullCatalog(STORE_BASE_URL);
      if (products.length === 0) {
        throw new Error('Bulk catalog endpoint returned 0 products');
      }
      console.log(`🚀 Fast catalog sync: ${products.length} products fetched in bulk.`);
      await syncCatalog(products);
    } catch (fastPathError) {
      console.error(`⚠️ Fast catalog path failed (${fastPathError.message}), falling back to sitemap scrape for this lap.`);
      try {
        const urls = await getSitemapUrls();
        if (urls.length > 0) {
          console.log(`🐢 Fallback: scraping ${urls.length} product pages individually...`);
          await trackPrices(urls);
        } else {
          console.error('⚠️ Fallback sitemap also returned no product URLs.');
        }
      } catch (fallbackError) {
        console.error('❌ Continuous tracking loop error (both paths failed):', fallbackError.message);
      }
    }
    await new Promise(resolve => setTimeout(resolve, CYCLE_DELAY_MS));
  }
}
