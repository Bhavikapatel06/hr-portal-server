/**
 * syncAllToSheet.js
 * One-time script to sync ALL existing MRFs in MongoDB → Google Sheets
 * Run: node syncAllToSheet.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import JobOpening from './models/JobOpening.js';
import { appendMRFToSheet, updateMRFInSheet } from './services/googleSheetsService.js';

dotenv.config();

async function syncAll() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected\n');

  const mrfs = await JobOpening.find({}).sort({ createdAt: 1 });
  console.log(`📋 Found ${mrfs.length} MRF(s) to sync\n`);

  for (const mrf of mrfs) {
    try {
      if (mrf.sheetRowIndex || mrf.mrfSheetRowIndex) {
        // Already has a row — update it
        console.log(`♻️  Updating existing sheet row for: "${mrf.designation}" (MRF ID: ${mrf._id})`);
        await updateMRFInSheet(mrf, mrf.mrfSheetRowIndex || mrf.sheetRowIndex);
      } else {
        // No row yet — append new
        console.log(`➕ Appending new row for: "${mrf.designation}" (MRF ID: ${mrf._id})`);
        const rowIndex = await appendMRFToSheet(mrf);
        if (rowIndex) {
          console.log(`   ✅ Written at row ${rowIndex}`);
        }
      }
    } catch (err) {
      console.error(`   ❌ Failed for "${mrf.designation}": ${err.message}`);
    }
  }

  console.log('\n🎉 Sync complete!');
  process.exit(0);
}

syncAll().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
