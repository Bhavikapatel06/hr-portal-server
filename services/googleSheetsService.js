/**
 * googleSheetsService.js
 * Authenticates with Google Sheets API using a Service Account,
 * then provides helpers to sync MRF data to/from a specified spreadsheet.
 *
 * Required env variables:
 *   GOOGLE_SHEET_ID              — The spreadsheet ID from the sheet URL
 *   GOOGLE_SERVICE_ACCOUNT_PATH  — Absolute path to the service account JSON file
 */

import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Column definitions matching the two Google Sheets ───────────────────────
const DEPT_HEAD_MRF_HEADERS = [
  'MRF ID',
  'MRF Status',
  'Designation',
  'Department',
  'Section',
  'Vacancy Location',
  'Number of Vacancies',
  'Requirement Type',
  'Experience Required',
  'Proposed Salary',
  'Level of Urgency',
  'Vacancy Reason',
  'Replacement For',
  'Justification',
  'Purpose of Job',
  'Roles & Responsibilities',
  'Minimum Qualification',
  'Other Key Skills',
  'Reports To',
  'Submitted By',
  'Approved By',
  'Approved At',
  'Created At',
  'Specializations',
  'Age Range',
  'Preferred Industries',
  'IT Requirements'
];

const RECRUITMENT_TRACKER_HEADERS = [
  'MRF ID',
  'Designation',
  'Department',
  'Vacancy Location',
  'Position Status',
  'Requirement Status',
  'Offer Status',
  'Offered Candidate Name',
  'Offered Designation',
  'Offer Date',
  'Tentative DOJ',
  'Actual DOJ',
  'TAT (Days)',
  'pre employee medical status',
  'Source of Hiring',
  'Internal Reference Name',
  'Qualification',
  'Last Organization',
  'Last Location',
  'Last Designation',
  'Total Experience (Years)',
  'Last CTC (LPA)',
  'Offered CTC (LPA)',
  'COC (LPA)',
  'CTC Difference (%)',
  'Recruitment Remarks',
  'Exit Employee Name',
  'Exit Employee Designation',
  'Exit Date',
  'Additional Remarks'
];

// ── Auth helper ─────────────────────────────────────────────────────────────
function getAuthClient() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (!keyPath) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_PATH is not set in .env');
  }

  // Resolve relative to project root (one level up from services/)
  const resolved = path.isAbsolute(keyPath)
    ? keyPath
    : path.resolve(__dirname, '..', keyPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Service account JSON not found at: ${resolved}`);
  }

  const credentials = JSON.parse(fs.readFileSync(resolved, 'utf8'));

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// ── Map an MRF document → row array for HOD MRF Sheet ──────────────────────
function mrfToHODRow(mrf) {
  const fmt = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '';
  return [
    String(mrf._id || ''),           // MRF ID
    mrf.mrfStatus            || '',  // MRF Status
    mrf.designation          || '',  // Designation
    mrf.department           || '',  // Department
    mrf.section              || '',  // Section
    mrf.location             || '',  // Vacancy Location
    mrf.noOfPositions        ?? '',  // Number of Vacancies
    mrf.requirementType      || '',  // Requirement Type
    mrf.experience           || '',  // Experience Required
    mrf.proposedSalary       || '',  // Proposed Salary
    mrf.levelOfUrgency       || '',  // Level of Urgency
    mrf.reasonForRequest     || '',  // Vacancy Reason
    mrf.replacementFor       || '',  // Replacement For
    mrf.justification        || '',  // Justification
    mrf.purposeOfJob         || '',  // Purpose of Job
    mrf.rolesResponsibilities|| '',  // Roles & Responsibilities
    mrf.minimumQualification || '',  // Minimum Qualification
    mrf.otherKeySkills       || '',  // Other Key Skills
    mrf.reportsTo            || '',  // Reports To
    mrf.submittedBy          || '',  // Submitted By
    mrf.approvedBy           || '',  // Approved By
    fmt(mrf.approvedAt),             // Approved At
    fmt(mrf.createdAt),              // Created At
    mrf.specializations      || '',  // Specializations
    mrf.ageRange             || '',  // Age Range
    mrf.preferredIndustries  || '',  // Preferred Industries
    mrf.itRequirements       || '',  // IT Requirements
  ];
}

// ── Map an MRF document → row array for Recruitment Tracker Sheet ───────────
function mrfToTrackerRow(mrf) {
  const fmt = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '';
  return [
    String(mrf._id || ''),           // MRF ID
    mrf.designation          || '',  // Designation
    mrf.department           || '',  // Department
    mrf.location             || '',  // Vacancy Location
    mrf.positionStatus       || '',  // Position Status
    mrf.requirementStatus    || '',  // Requirement Status
    mrf.offerStatus          || '',  // Offer Status
    mrf.offeredCandidateName || '',  // Offered Candidate Name
    mrf.offeredDesignation   || '',  // Offered Designation
    fmt(mrf.offerDate),              // Offer Date
    fmt(mrf.tentativeDOJ),           // Tentative DOJ
    fmt(mrf.actualDOJ),              // Actual DOJ
    mrf.tat                  ?? '',  // TAT (Days)
    mrf.preEmploymentMedicalStatus || '', // pre employee medical status
    mrf.sourceOfHiring       || '',  // Source of Hiring
    mrf.internalRefName      || '',  // Internal Reference Name
    mrf.minimumQualification || '',  // Qualification
    mrf.lastOrganization     || '',  // Last Organization
    mrf.candidateLocation    || '',  // Last Location
    mrf.lastDesignation      || '',  // Last Designation
    mrf.totalPreviousExp     || '',  // Total Experience (Years)
    mrf.lastCTC              || '',  // Last CTC (LPA)
    mrf.offeredCTC           || '',  // Offered CTC (LPA)
    mrf.costOfCompany        || '',  // COC (LPA)
    mrf.ctcDifferencePercent ?? '',  // CTC Difference (%)
    mrf.recruitmentRemarks   || '',  // Recruitment Remarks
    mrf.employeeName         || '',  // Exit Employee Name
    mrf.employeeDesignation  || '',  // Exit Employee Designation
    fmt(mrf.positionStartDate),      // Exit Date
    mrf.additionalRemarks    || '',  // Additional Remarks
  ];
}

// ── Ensure header row and sheets/tabs exist ─────────────────────────────────
async function ensureSheetTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = (meta.data.sheets || []).map(s => s.properties.title);
  
  const requests = [];
  if (!sheetNames.includes('Department Head MRF')) {
    requests.push({
      addSheet: {
        properties: { title: 'Department Head MRF' }
      }
    });
  }
  if (!sheetNames.includes('Recruitment Tracker')) {
    requests.push({
      addSheet: {
        properties: { title: 'Recruitment Tracker' }
      }
    });
  }
  
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests }
    });
  }
  
  // Ensure headers for Department Head MRF
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "'Department Head MRF'!A1",
    valueInputOption: 'RAW',
    requestBody: { values: [DEPT_HEAD_MRF_HEADERS] },
  });

  // Ensure headers for Recruitment Tracker
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "'Recruitment Tracker'!A1",
    valueInputOption: 'RAW',
    requestBody: { values: [RECRUITMENT_TRACKER_HEADERS] },
  });
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Append a new MRF row to both Department Head MRF and Recruitment Tracker.
 * Returns the HOD MRF sheet row index.
 */
export async function appendMRFToSheet(mrf) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping sync');
    return null;
  }
  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheetTabs(sheets, spreadsheetId);

    // 1. Append to Department Head MRF
    const hodRow = mrfToHODRow(mrf);
    const hodResult = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "'Department Head MRF'!A:A",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [hodRow] },
    });
    const hodRange = hodResult.data.updates?.updatedRange || '';
    const hodMatch = hodRange.match(/!A(\d+)/);
    const hodRowIndex = hodMatch ? parseInt(hodMatch[1]) : null;

    mrf.mrfSheetRowIndex = hodRowIndex;
    mrf.sheetRowIndex = hodRowIndex; // Legacy fallback

    // 2. Append to Recruitment Tracker
    const trackerRow = mrfToTrackerRow(mrf);
    const trackerResult = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "'Recruitment Tracker'!A:A",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [trackerRow] },
    });
    const trackerRange = trackerResult.data.updates?.updatedRange || '';
    const trackerMatch = trackerRange.match(/!A(\d+)/);
    const trackerRowIndex = trackerMatch ? parseInt(trackerMatch[1]) : null;

    mrf.trackerSheetRowIndex = trackerRowIndex;

    await mrf.save().catch(e => console.error('Failed to save sheet row indices:', e.message));

    console.log(`[Sheets] Appended HOD row ${hodRowIndex} and Tracker row ${trackerRowIndex} for MRF "${mrf.designation}"`);
    return hodRowIndex;
  } catch (err) {
    console.error('[Sheets] appendMRFToSheet failed:', err.message);
    return null;
  }
}

/**
 * Update row values in both Department Head MRF and Recruitment Tracker.
 */
export async function updateMRFInSheet(mrf, rowIndex) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping update');
    return;
  }
  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureSheetTabs(sheets, spreadsheetId);

    // 1. Update Department Head MRF sheet
    let targetHODIndex = mrf.mrfSheetRowIndex || rowIndex;
    if (!targetHODIndex) {
      console.log(`[Sheets] HOD rowIndex missing for MRF "${mrf.designation}". Searching by MRF ID...`);
      const rows = await fetchAllFromSheet('Department Head MRF');
      const match = rows.find(r => r['MRF ID'] === String(mrf._id));
      if (match) {
        targetHODIndex = match._sheetRow;
        mrf.mrfSheetRowIndex = targetHODIndex;
        mrf.sheetRowIndex = targetHODIndex;
      }
    }

    const hodRow = mrfToHODRow(mrf);
    if (targetHODIndex) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'Department Head MRF'!A${targetHODIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [hodRow] },
      });
      console.log(`[Sheets] Updated HOD row ${targetHODIndex} for MRF "${mrf.designation}"`);
    } else {
      console.log(`[Sheets] MRF not found in HOD sheet. Appending as new row...`);
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Department Head MRF'!A:A",
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [hodRow] },
      });
      const updatedRange = result.data.updates?.updatedRange || '';
      const match = updatedRange.match(/!A(\d+)/);
      if (match) {
        mrf.mrfSheetRowIndex = parseInt(match[1]);
        mrf.sheetRowIndex = parseInt(match[1]);
      }
    }

    // 2. Update Recruitment Tracker sheet
    let targetTrackerIndex = mrf.trackerSheetRowIndex;
    if (!targetTrackerIndex) {
      console.log(`[Sheets] Tracker rowIndex missing for MRF "${mrf.designation}". Searching by MRF ID...`);
      const rows = await fetchAllFromSheet('Recruitment Tracker');
      const match = rows.find(r => r['MRF ID'] === String(mrf._id));
      if (match) {
        targetTrackerIndex = match._sheetRow;
        mrf.trackerSheetRowIndex = targetTrackerIndex;
      }
    }

    const trackerRow = mrfToTrackerRow(mrf);
    if (targetTrackerIndex) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'Recruitment Tracker'!A${targetTrackerIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [trackerRow] },
      });
      console.log(`[Sheets] Updated Tracker row ${targetTrackerIndex} for MRF "${mrf.designation}"`);
    } else {
      console.log(`[Sheets] MRF not found in Tracker sheet. Appending as new row...`);
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Recruitment Tracker'!A:A",
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [trackerRow] },
      });
      const updatedRange = result.data.updates?.updatedRange || '';
      const match = updatedRange.match(/!A(\d+)/);
      if (match) {
        mrf.trackerSheetRowIndex = parseInt(match[1]);
      }
    }

    await mrf.save().catch(e => console.error('Failed to save sheet row indices:', e.message));
  } catch (err) {
    console.error('[Sheets] updateMRFInSheet failed:', err.message);
  }
}

/**
 * Fetch rows from Google Sheet. If singleSheetName is supplied, returns simple array.
 * Otherwise, returns { hodMrf: [...], recruitmentTracker: [...] }.
 */
export async function fetchAllFromSheet(singleSheetName = null) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set');
    return singleSheetName ? [] : { hodMrf: [], recruitmentTracker: [] };
  }
  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    
    if (singleSheetName) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${singleSheetName}'!A1:AZ`,
      });
      const rows = res.data.values || [];
      if (rows.length < 2) return [];
      const headers = rows[0];
      return rows.slice(1).map((row, i) => {
        const obj = { _sheetRow: i + 2 };
        headers.forEach((h, idx) => { obj[h] = row[idx] || ''; });
        return obj;
      });
    }

    await ensureSheetTabs(sheets, spreadsheetId);
    
    const [hodRes, trackerRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: "'Department Head MRF'!A1:AZ" }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: "'Recruitment Tracker'!A1:AZ" })
    ]);
    
    const hodRows = hodRes.data.values || [];
    const trackerRows = trackerRes.data.values || [];
    
    const mapRows = (rows) => {
      if (rows.length < 2) return [];
      const headers = rows[0];
      return rows.slice(1).map((row, i) => {
        const obj = { _sheetRow: i + 2 };
        headers.forEach((h, idx) => { obj[h] = row[idx] || ''; });
        return obj;
      });
    };
    
    return {
      hodMrf: mapRows(hodRows),
      recruitmentTracker: mapRows(trackerRows)
    };
  } catch (err) {
    console.error('[Sheets] fetchAllFromSheet failed:', err.message);
    return singleSheetName ? [] : { hodMrf: [], recruitmentTracker: [] };
  }
}
