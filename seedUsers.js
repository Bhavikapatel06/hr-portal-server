import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

const userSchema = new mongoose.Schema({
  name:  { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role:  { type: String, enum: ['candidate', 'department_head', 'hr', 'admin', 'interviewer'], default: 'candidate' },
  department: { type: String, default: '' },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const USERS = [
  { name: 'Admin',      email: 'admin@hrportal.com',     password: 'admin123',     role: 'admin' },
  { name: 'Candidate',  email: 'candidate@hrportal.com', password: 'candidate123', role: 'candidate' },
  { name: 'Dept Head',  email: 'depthead@hrportal.com',  password: 'depthead123',  role: 'department_head', department: 'Engineering' },
  { name: 'HR Manager', email: 'hr@hrportal.com',        password: 'hr123456',     role: 'hr' },
  { name: 'Interviewer', email: 'interviewer@hrportal.com', password: 'interviewer123', role: 'interviewer' },
];

async function seedUsers() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    for (const u of USERS) {
      const exists = await User.findOne({ email: u.email });
      if (exists) {
        exists.role = u.role;
        if (u.department !== undefined) {
          exists.department = u.department;
        }
        await exists.save();
        console.log(`⚠️  User already exists: ${u.email} — updated role/department`);
        continue;
      }
      const hashed = await bcrypt.hash(u.password, 12);
      await User.create({ ...u, password: hashed });
      console.log(`✅ Created user: ${u.email} (${u.role})`);
    }

    console.log('\n🎉 All users seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seedUsers();
