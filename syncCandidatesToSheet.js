import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Candidate from './models/Candidate.js';
import { syncCandidateToSheet } from './services/googleSheetsService.js';

dotenv.config();

async function syncAllCandidates() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected\n');

  const candidates = await Candidate.find({}).sort({ createdAt: 1 });
  console.log(`📋 Found ${candidates.length} Candidate(s) to sync\n`);

  for (const cand of candidates) {
    try {
      console.log(`➕ Syncing candidate: "${cand.details?.fullName || cand.fileName}" (ID: ${cand._id})`);
      await syncCandidateToSheet(cand);
    } catch (err) {
      console.error(`   ❌ Failed for "${cand.details?.fullName || cand.fileName}": ${err.message}`);
    }
  }

  console.log('\n🎉 Candidate sync complete!');
  process.exit(0);
}

syncAllCandidates().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
