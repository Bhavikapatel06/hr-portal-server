/**
 * csvService.js  –  In-memory CSV generation only (no disk writes).
 * Generates candidate CSV content as a string for streaming downloads.
 */

const STATUS_MAP = {
  new: 'New', shortlisted: 'Shortlisted', scheduled: 'Scheduled',
  selected: 'Selected', rejected: 'Rejected', on_hold: 'On Hold',
};

const HEADERS = [
  'Sr. No', 'Candidate Name', 'Contact No', 'Alternate Number', 'Mail ID',
  'Current Opening', 'Department', 'Job Location', 'Qualification', 'Total Experience',
  'Current Location', 'Current Company', 'Current CTC', 'Expected CTC', 'Notice Period',
  'Reason For Change', 'Candidate Status', 'Remarks',
];

function escapeCell(val) {
  const str = String(val === null || val === undefined ? '' : val).replace(/"/g, '""');
  return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
}

/**
 * Builds a CSV string in-memory for the given opening + candidates.
 * @param {Object} opening  - JobOpening document
 * @param {Array}  candidates - Candidate documents
 * @returns {string} CSV content
 */
export function buildCandidateCSV(opening, candidates) {
  const rows = candidates.map((c, i) => {
    const d = c.details || {};
    return [
      i + 1,
      d.fullName        || '',
      d.phone           || '',
      d.alternatePhone  || '',
      d.email           || '',
      opening?.designation || '',
      opening?.department  || '',
      opening?.location    || '',
      d.highestQual     || '',
      d.totalExp        || '',
      d.currentLocation || '',
      d.currentCompany  || '',
      d.currentCtc      || '',
      d.expectedCtc     || '',
      d.noticePeriod    || '',
      d.reasonForChange || '',
      STATUS_MAP[c.overallStatus] || c.overallStatus || 'New',
      d.notes           || '',
    ].map(escapeCell).join(',');
  });

  return [HEADERS.map(escapeCell).join(','), ...rows].join('\n');
}
