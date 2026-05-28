import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import mrfRoutes from './routes/mrfRoutes.js';
import candidateRoutes from './routes/candidateRoutes.js';
import JobOpening from './models/JobOpening.js';

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB().then(() => seedDatabase());

const app = express();

// Middlewares
app.use(cors({
  origin: '*', // Allow all origins for simplicity in local development
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static uploaded files (in case frontend needs to download/view the resume)
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/mrf', mrfRoutes);
app.use('/api', candidateRoutes);

// Root endpoint status
app.get('/', (req, res) => {
  res.json({ message: 'HR Portal API Server is running smoothly' });
});

// Seed default data if database is empty
const seedDatabase = async () => {
  try {
    const count = await JobOpening.countDocuments();
    if (count === 0) {
      console.log('Database is empty. Seeding default Job Openings...');
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
    console.error('Seeding database failed:', error.message);
  }
};

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong on the server!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running in development mode on port ${PORT}`);
});
