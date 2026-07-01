const cron = require('node-cron');
const nodemailer = require('nodemailer');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');
const Product = require('./models/Product');

cron.schedule('0 0 * * *', async () => {
  console.log('Executing automated Midnight report sequence...');
  
  try {
    const changedProducts = await Product.find({ hasChangedToday: true });

    if (changedProducts.length === 0) {
      console.log('No competitor price adjustments today.');
      return;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `price_report_${dateStr}.csv`;
    const reportsDir = path.join(__dirname, 'reports');
    const filePath = path.join(reportsDir, fileName);

    if (!fs.existsSync(reportsDir)){
        fs.mkdirSync(reportsDir);
    }

    const csvWriter = createCsvWriter({
      path: filePath,
      header: [
        {id: 'name', title: 'Product Name'},
        {id: 'url', title: 'Product Link'},
        {id: 'previousPrice', title: 'Old Price'},
        {id: 'currentPrice', title: 'New Price'},
        {id: 'time', title: 'Change Log Timestamp'}
      ]
    });

    const records = changedProducts.map(p => ({
      name: p.name,
      url: p.url,
      previousPrice: `$${p.previousPrice}`,
      currentPrice: `$${p.currentPrice}`,
      time: p.priceChangedAt.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
    }));

    await csvWriter.writeRecords(records);

    let transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    await transporter.sendMail({
      from: `"Store Price Monitor" <${process.env.EMAIL_USER}>`,
      to: process.env.REPORT_EMAILS,
      subject: `🚨 Best Buy Lighting Price Alterations - ${dateStr}`,
      text: 'Attached is the system CSV file tracking competitor price movements over the last 24 hours.',
      attachments: [{ filename: fileName, path: filePath }]
    });

    // Clear dashboard visual data for the new day
    await Product.updateMany({ hasChangedToday: true }, { hasChangedToday: false });
    console.log('Dashboard items purged. System reset complete.');

    // Enforce strict 7-day retention rule
    cleanOldReports();

  } catch (err) {
    console.error('Automation error:', err);
  }
}, {
  scheduled: true,
  timezone: "Australia/Sydney"
});

function cleanOldReports() {
  const reportsDir = path.join(__dirname, 'reports');
  fs.readdir(reportsDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(reportsDir, file);
      const stat = fs.statSync(filePath);
      const now = new Date().getTime();
      const expirationTime = new Date(stat.ctime).getTime() + (7 * 24 * 60 * 60 * 1000); 

      if (now > expirationTime) {
        fs.unlinkSync(filePath);
        console.log(`[Storage Cleanup] Deleted 7-day old spreadsheet: ${file}`);
      }
    });
  });
}