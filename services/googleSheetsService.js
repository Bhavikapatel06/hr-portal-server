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

// ── Column definitions matching Google Sheet ─────────────────────────────────
const SHEET_HEADERS = [
  'Vacancy Location',                 // 1
  'Designation',                      // 2
  'Department',                       // 3
  'Number of Vacancies',              // 4
  'Position Status',                  // 5
  'Requirement Status',               // 6
  'Vacancy Reason',                   // 7
  'Process Owner',                    // 8
  'pre employee medical status',      // 9
  'Offer Date',                       // 10
  'Tentative DOJ',                    // 11
  'TAT (Days)',                       // 12
  'Offered Candidate Name',           // 13
  'Actual DOJ',                       // 14
  'Source of Hiring',                 // 15
  'Internal Reference Name',          // 16
  'Qualification',                    // 17
  'Last Organization',                // 18
  'Last Location ',                   // 19 (Note trailing space in original header)
  'Last Designation',                 // 20
  'Total Experience (Years)',         // 21
  'Last CTC (LPA)',                   // 22
  'Offered CTC (LPA)',                // 23
  'COC (LPA)',                        // 24
  'CTC Difference (%)',               // 25
  'Recruitment Remarks',              // 26
  'Exit Employee Name',               // 27
  'Exit Employee Designation',        // 28
  'Exit Date',                        // 29
  'Additional Remarks',               // 30
  // Extra metadata appended after the canonical columns
  'MRF Status',
  'MRF ID',
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

// ── Map an MRF document → row array ──────────────────────────────
function mrfToRow(mrf) {
  const fmt = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '';
  return [
    mrf.location             || '',  // 1 Vacancy Location
    mrf.designation          || '',  // 2 Designation
    mrf.department           || '',  // 3 Department
    mrf.noOfPositions        ?? '',  // 4 Number of Vacancies
    mrf.positionStatus       || '',  // 5 Position Status
    mrf.requirementStatus    || '',  // 6 Requirement Status
    mrf.reasonForRequest     || '',  // 7 Vacancy Reason
    mrf.processOwnerName     || '',  // 8 Process Owner
    mrf.preEmploymentMedicalStatus || '', // 9 pre employee medical status
    fmt(mrf.offerDate),              // 10 Offer Date
    fmt(mrf.tentativeDOJ),           // 11 Tentative DOJ
    mrf.tat                  ?? '',  // 12 TAT (Days)
    mrf.offeredCandidateName || '',  // 13 Offered Candidate Name
    fmt(mrf.actualDOJ),              // 14 Actual DOJ
    mrf.sourceOfHiring       || '',  // 15 Source of Hiring
    mrf.internalRefName      || '',  // 16 Internal Reference Name
    mrf.minimumQualification || '',  // 17 Qualification
    mrf.lastOrganization     || '',  // 18 Last Organization
    mrf.candidateLocation    || '',  // 19 Last Location 
    mrf.lastDesignation      || '',  // 20 Last Designation
    mrf.totalPreviousExp     || '',  // 21 Total Experience (Years)
    mrf.lastCTC              || '',  // 22 Last CTC (LPA)
    mrf.offeredCTC           || '',  // 23 Offered CTC (LPA)
    mrf.costOfCompany        || '',  // 24 COC (LPA)
    mrf.ctcDifferencePercent ?? '',  // 25 CTC Difference (%)
    mrf.recruitmentRemarks   || '',  // 26 Recruitment Remarks
    mrf.employeeName         || '',  // 27 Exit Employee Name
    mrf.employeeDesignation  || '',  // 28 Exit Employee Designation
    fmt(mrf.positionStartDate),      // 29 Exit Date (Position Start Date)
    mrf.additionalRemarks    || '',  // 30 Additional Remarks
    mrf.mrfStatus            || '',  // extra: MRF Status
    String(mrf._id || ''),           // extra: MRF ID
  ];
}

// ── Ensure header row exists ─────────────────────────────────────────────────
async function ensureHeaders(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!1:1',
  });
  const existing = (res.data.values || [])[0] || [];
  if (existing.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Append a new MRF row to the Google Sheet.
 * Returns the 1-based row index where it was written.
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
    await ensureHeaders(sheets, spreadsheetId);

    const row = mrfToRow(mrf);
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:A',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    // updatedRange looks like "Sheet1!A5:AL5" — extract row number
    const updatedRange = result.data.updates?.updatedRange || '';
    const match = updatedRange.match(/!A(\d+)/);
    const rowIndex = match ? parseInt(match[1]) : null;
    console.log(`[Sheets] Appended MRF "${mrf.designation}" to row ${rowIndex}`);
    return rowIndex;
  } catch (err) {
    console.error('[Sheets] appendMRFToSheet failed:', err.message);
    return null;
  }
}

export async function updateMRFInSheet(mrf, rowIndex) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping update');
    return;
  }
  try {
    let targetRowIndex = rowIndex;

    // If rowIndex is not provided, try to find it by matching MRF ID in the sheet
    if (!targetRowIndex) {
      console.log(`[Sheets] rowIndex missing for MRF "${mrf.designation}". Searching by MRF ID...`);
      const rows = await fetchAllFromSheet();
      const match = rows.find(r => r['MRF ID'] === String(mrf._id));
      if (match) {
        targetRowIndex = match._sheetRow;
        console.log(`[Sheets] Found matching MRF ID in sheet at row ${targetRowIndex}`);
        // Save back to DB
        mrf.sheetRowIndex = targetRowIndex;
        await mrf.save().catch(e => console.error('Failed to save sheetRowIndex:', e.message));
      } else {
        // Not found in sheet, let's append it!
        console.log(`[Sheets] MRF not found in sheet. Appending as new row...`);
        const newRowIndex = await appendMRFToSheet(mrf);
        return newRowIndex;
      }
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const row = mrfToRow(mrf);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!A${targetRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    console.log(`[Sheets] Updated row ${targetRowIndex} for MRF "${mrf.designation}"`);
  } catch (err) {
    console.error('[Sheets] updateMRFInSheet failed:', err.message);
  }
}


/**
 * Fetch all rows from Google Sheet (skipping header row).
 * Returns array of objects keyed by SHEET_HEADERS.
 */
export async function fetchAllFromSheet() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set');
    return [];
  }
  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A1:AZ',
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0];
    return rows.slice(1).map((row, i) => {
      const obj = { _sheetRow: i + 2 }; // 1-based, +1 for header
      headers.forEach((h, idx) => { obj[h] = row[idx] || ''; });
      return obj;
    });
  } catch (err) {
    console.error('[Sheets] fetchAllFromSheet failed:', err.message);
    return [];
  }
}
