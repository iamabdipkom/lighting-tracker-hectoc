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
  
  // ✅ BYPASS PATHWAY: Put your exact target store URLs inside this array!
  const manualUrls = [
    'https://www.bestbuylighting.com.au/products/domino-3-in-1-led-exhaust-fan-bathroom-heater-3-colors-led-brenton',
    'https://www.bestbuylighting.com.au/products/fino-ultra-slim-led-exhaust-fan-round-square-trio-color-martec'
  ];

  console.log(`🚀 Bypassing sitemap wall. Initializing direct scraping cycle for ${manualUrls.length} items...`);
  trackPrices(manualUrls);
});
