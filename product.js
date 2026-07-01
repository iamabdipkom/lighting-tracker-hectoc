const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  sku: { type: String, default: 'N/A' },
  currentPrice: { type: Number, required: true },
  lastUpdated: { type: Date, default: Date.now },
  hasChangedToday: { type: Boolean, default: false },
  previousPrice: { type: Number, default: null },
  priceChangedAt: { type: Date, default: null },
  // Every distinct price this product has ever been seen at, oldest first.
  // This is what lets you compare against old values instead of just the
  // single most recent previousPrice.
  priceHistory: {
    type: [{ price: Number, date: { type: Date, default: Date.now } }],
    default: []
  }
});

module.exports = mongoose.model('Product', ProductSchema);
