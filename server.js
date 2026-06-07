import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import mrfRoutes from './routes/mrfRoutes.js';
import candidateRoutes from './routes/candidateRoutes.js';
import authRoutes from './routes/authRoutes.js';
import JobOpening from './models/JobOpening.js';
import User from './models/User.js';
import bcrypt from 'bcryptjs';

dotenv.config();

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Promise Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${err.port || 5000} is already in use. Exiting...`);
    process.exit(1);
  }
  console.error('[Server] Uncaught Exception:', err.message);
});

connectDB().then(() => seedDatabase());

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/mrf', mrfRoutes);
app.use('/api', candidateRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'HR Portal API Server is running smoothly' });
});

// Seed default data
const seedDatabase = async () => {
  try {
    // Seed demo users
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      console.log('Seeding demo users...');
      await User.create([
        {
          name: 'HR Admin',
          email: 'admin@hrportal.com',
          password: 'admin123',
          role: 'admin',
        },
        {
          name: 'Demo Candidate',
          email: 'candidate@hrportal.com',
          password: 'candidate123',
          role: 'candidate',
        },
      ]);
      console.log('Demo users created!');
      console.log('  Admin:     admin@hrportal.com / admin123');
      console.log('  Candidate: candidate@hrportal.com / candidate123');
    }

    // Seed job openings
    const count = await JobOpening.countDocuments();
    if (count === 0) {
      console.log('Seeding default Job Openings...');
      const SEEDS = [
        {
          designation: 'Senior React Developer',
          department: 'Engineering',
          location: 'Ahmedabad',
          experience: '3–5 years',
          noOfPositions: 2,
          levelOfUrgency: 'High',
          reasonForRequest: 'New Position',
          minimumQualification: 'B.E. / B.Tech',
          otherKeySkills: 'React, TypeScript, Node.js, REST APIs',
          purposeOfJob: 'Build and maintain scalable web applications for our SaaS platform.',
          rolesResponsibilities: 'Lead frontend architecture, mentor juniors, conduct code reviews.',
          proposedSalary: '12-18 LPA',
        },
        {
          designation: 'Product Manager',
          department: 'Product',
          location: 'Mumbai',
          experience: '5–8 years',
          noOfPositions: 1,
          levelOfUrgency: 'Medium',
          reasonForRequest: 'Replacement',
          minimumQualification: 'MBA / PGDM',
          otherKeySkills: 'Product Roadmap, Agile, Stakeholder Management, Analytics',
          purposeOfJob: 'Own product strategy and execution for enterprise product line.',
          rolesResponsibilities: 'Define roadmap, collaborate with engineering, represent customer needs.',
          proposedSalary: '20-30 LPA',
        },
        {
          designation: 'HR Business Partner',
          department: 'Human Resources',
          location: 'Ahmedabad',
          experience: '2–4 years',
          noOfPositions: 1,
          levelOfUrgency: 'Low',
          reasonForRequest: 'New Position',
          minimumQualification: 'Post Graduate',
          otherKeySkills: 'Talent Acquisition, Employee Relations, HRIS, Payroll',
          purposeOfJob: 'Partner with business units to deliver strategic HR support.',
          rolesResponsibilities: 'Recruitment, performance management, policy implementation.',
          proposedSalary: '6-10 LPA',
        },
        {
          designation: 'Data Analyst',
          department: 'Analytics',
          location: 'Bangalore',
          experience: '1–3 years',
          noOfPositions: 3,
          levelOfUrgency: 'High',
          reasonForRequest: 'Additional Headcount',
          minimumQualification: 'Graduate (Any)',
          otherKeySkills: 'SQL, Python, Tableau, Excel, Data Modeling',
          purposeOfJob: 'Extract insights from data to drive product and business decisions.',
          rolesResponsibilities: 'Build dashboards, run ad-hoc analysis, present findings to stakeholders.',
          proposedSalary: '5-9 LPA',
        },
        {
          designation: 'Sales Executive',
          department: 'Sales',
          location: 'Delhi',
          experience: '2–5 years',
          noOfPositions: 4,
          levelOfUrgency: 'High',
          reasonForRequest: 'Additional Headcount',
          minimumQualification: 'Graduate (Any)',
          otherKeySkills: 'B2B Sales, CRM, Negotiation, Cold Calling, Lead Generation',
          purposeOfJob: 'Drive revenue growth through new client acquisition.',
          rolesResponsibilities: 'Prospecting, demos, closing deals, account management.',
          proposedSalary: '4-8 LPA',
        }
      ];
      await JobOpening.insertMany(SEEDS);
      console.log('Database seeded successfully!');
    }
  } catch (error) {
    console.error('Seeding failed:', error.message);
  }
};

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running in development mode on port ${PORT}`);
});