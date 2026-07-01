require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { engine } = require('express-handlebars');
const Product = require('./models/Product');
const { trackPrices } = require('./tracker');
require('./cronJob'); 

const app = express();

app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', './views');

// 👇 EXPLICIT STRIPPED LINK WITH NEW CREDENTIALS 👇
// IMPORTANT: Look at the text "cluster0.xxxxx" below. Replace ONLY those specific characters with your real cluster ID from your Atlas page!
const mongoURI = "mongodb+srv://trackeradmin:Lighting123456@cluster0.zwuta1x.mongodb.net/?appName=Cluster0"



mongoose.connect(mongoURI)
  .then(() => console.log("✅ SUCCESS! Connected straight to MongoDB Atlas Cloud Database!"))
  .catch(err => console.error("❌ MongoDB Connection Error: ", err.message));

// Add real URLs here to pull live data instead of example pages
const targetUrls = [
  'https://www.bestbuylighting.com.au/products/example-light-1',
  'https://www.bestbuylighting.com.au/products/example-light-2'
];

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

setInterval(() => {
  console.log('Executing routine continuous 24/7 scraper rotation...');
  trackPrices(targetUrls);
}, 1000 * 60 * 60 * 2);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`24/7 Tracker Dashboard running on http://localhost:${PORT}`);
  trackPrices(targetUrls); 
});