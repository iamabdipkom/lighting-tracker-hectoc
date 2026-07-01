const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  currentPrice: { type: Number, required: true },
  lastUpdated: { type: Date, default: Date.now },
  hasChangedToday: { type: Boolean, default: false },
  previousPrice: { type: Number, default: null },
  priceChangedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Product', ProductSchema);