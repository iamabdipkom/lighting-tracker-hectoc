require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { engine } = require('express-handlebars');

// Paths adjusted to find files directly in your main root directory
const Product = require('./product'); 
const { trackPrices } = require('./tracker');
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
app.listen(PORT, async () => {
  console.log(`24/7 Cloud Tracker Dashboard initializing on port ${PORT}`);
  
  // Verified live product URLs (the old ones 404'd: the Radam link had a stale
  // "/collections/new-arrivals/" prefix in front of "/products/", and product
  // id 2483 for the Yoyo light doesn't exist - the real id is 2475).
  const manualUrls = [
    'https://www.bestbuylighting.com.au/products/telbix-radam-8-pendant-light',
    'https://www.bestbuylighting.com.au/products/2475-yoyo-1-light-gold'
  ];

  console.log(`🚀 Bypassing sitemap wall. Initializing direct scraping cycle for ${manualUrls.length} items...`);
  trackPrices(manualUrls);
});
