import PDFDocument from 'pdfkit';

/**
 * Generates a beautiful manpower request form PDF matching the grid format in the photo.
 */
export function generateMrfPDF(mrf, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  doc.pipe(stream);

  const pageWidth = 535; // A4 width (595) minus margins (60)
  const startX = 30;
  let currentY = 30;

  // Helper to draw a text centered in a box
  const drawHeaderBox = (text, height = 24, isTitle = false) => {
    // Fill background with light gray for section headers
    if (!isTitle) {
      doc.rect(startX, currentY, pageWidth, height).fill('#f1f5f9');
      doc.rect(startX, currentY, pageWidth, height).stroke('#94a3b8');
      doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(10);
    } else {
      doc.rect(startX, currentY, pageWidth, height).stroke('#64748b');
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13);
    }
    
    doc.text(text, startX, currentY + (height - doc.currentLineHeight()) / 2, {
      width: pageWidth,
      align: 'center'
    });
    currentY += height;
  };

  // Helper to draw a row with multiple cells
  const drawRow = (cells, height = 35) => {
    let x = startX;
    cells.forEach(cell => {
      const cellWidth = pageWidth * cell.weight;
      
      // Draw border
      doc.rect(x, currentY, cellWidth, height).stroke('#cbd5e1');
      
      // Label
      doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.5);
      doc.text(cell.label, x + 5, currentY + 4, { width: cellWidth - 10 });
      
      // Value
      doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5);
      doc.text(String(cell.val || '—'), x + 5, currentY + 16, { 
        width: cellWidth - 10, 
        height: height - 20, 
        ellipsis: true 
      });

      x += cellWidth;
    });
    currentY += height;
  };

  // Helper to draw a full-width text area block
  const drawTextBlock = (label, val, height = 55) => {
    doc.rect(startX, currentY, pageWidth, height).stroke('#cbd5e1');
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.5);
    doc.text(label, startX + 5, currentY + 4, { width: pageWidth - 10 });

    doc.fillColor('#0f172a').font('Helvetica').fontSize(8.5);
    doc.text(String(val || '—'), startX + 5, currentY + 16, { 
      width: pageWidth - 10, 
      height: height - 20, 
      ellipsis: true 
    });
    currentY += height;
  };

  // Title Box
  drawHeaderBox('Manpower Request Form', 30, true);
  currentY += 8; // Small spacing

  // Section 1 Header
  drawHeaderBox('1. Position details', 22, false);

  // Section 1 Rows
  drawRow([
    { label: 'Designation', val: mrf.designation, weight: 0.35 },
    { label: 'Department & Sub Function', val: mrf.department, weight: 0.35 },
    { label: 'Reports To', val: mrf.reportsTo, weight: 0.30 }
  ], 38);

  const salaryVal = mrf.proposedSalaryMin
    ? `Rs. ${mrf.proposedSalaryMin} - ${mrf.proposedSalaryMax} LPA`
    : mrf.proposedSalary;
  drawRow([
    { label: 'Location', val: mrf.location, weight: 0.35 },
    { label: 'Experience', val: mrf.experience, weight: 0.25 },
    { label: 'Proposed Salary (CTC - Range)', val: salaryVal, weight: 0.40 }
  ], 38);

  // Urgency Checked Box Row
  const urgency = mrf.levelOfUrgency || mrf.urgency || 'Medium';
  const highCheck = urgency === 'High' ? '[X]' : '[  ]';
  const medCheck  = urgency === 'Medium' ? '[X]' : '[  ]';
  const lowCheck  = urgency === 'Low' ? '[X]' : '[  ]';
  
  doc.rect(startX, currentY, pageWidth, 28).stroke('#cbd5e1');
  doc.fillColor('#475569').font('Helvetica-Bold').fontSize(7.5);
  doc.text('Level of Urgency', startX + 5, currentY + 10);
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5);
  doc.text(`${highCheck} High           ${medCheck} Medium           ${lowCheck} Low`, startX + 180, currentY + 10);
  currentY += 28;
  currentY += 8; // Small spacing

  // Section 2 Header
  drawHeaderBox('2. Reasons for request', 22, false);
  
  drawRow([
    { label: 'New / Replacement', val: mrf.reasonForRequest, weight: 0.35 },
    { label: 'No. of position', val: String(mrf.noOfPositions || 1), weight: 0.25 },
    { label: 'Replacement for', val: mrf.replacementFor, weight: 0.40 }
  ], 38);

  drawTextBlock('Justification for this Opening', mrf.justification, 50);
  currentY += 8; // Small spacing

  // Section 3 Header
  drawHeaderBox('3. Job Description', 22, false);
  drawTextBlock('Purpose of the Job', mrf.purposeOfJob, 50);
  drawTextBlock('Roles and Responsibilities (With Proper Job Description)', mrf.rolesResponsibilities, 100);
  currentY += 8; // Small spacing

  // Section 4 Header
  drawHeaderBox('4. Qualification & Other Criteria', 22, false);
  drawRow([
    { label: 'Minimum Qualification', val: mrf.minimumQualification, weight: 0.40 },
    { label: 'Specializations', val: mrf.preferredIndustries, weight: 0.35 },
    { label: 'Age in Range', val: 'Not specified', weight: 0.25 }
  ], 38);

  drawTextBlock('Preferred Industries / Sectors.', mrf.preferredIndustries, 36);
  drawTextBlock('Other Key Skills & explain the kind of relevant experience', mrf.otherKeySkills, 45);
  
  // IT Requirements
  const itReqVal = mrf.itRequirements || 'Standard Laptop/Desktop with required access';
  drawTextBlock('IT Requirements (Laptop/Desktop/ Special software etc)', itReqVal, 36);

  doc.end();
}
