// Qualification hierarchy (higher index = higher level)
const QUAL_LEVELS = [
  '10th / SSC',
  '12th / HSC',
  'Diploma',
  'Graduate (Any)',
  'B.E. / B.Tech',
  'MBA / PGDM',
  'Post Graduate',
  'Doctorate / PhD',
];

/**
 * Tokenize a string into lowercase keywords (min 2 chars).
 */
function tokenize(str = '') {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s.+#-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

/**
 * Skills score: overlap between candidate skills and required skills.
 */
function scoreSkills(candidateDetails, requirements) {
  const reqSkills = tokenize(requirements.otherKeySkills || '');
  if (!reqSkills.length) return 60; // no requirements = neutral

  const candidateText = [
    candidateDetails.skills,
    candidateDetails.currentTitle,
    candidateDetails.notes,
    candidateDetails.fullName,
  ].join(' ');
  const candidateSkills = tokenize(candidateText);

  if (!candidateSkills.length) return 0;

  const matches = reqSkills.filter(rk =>
    candidateSkills.some(ck => ck === rk || ck.includes(rk))
  );
  return Math.round((matches.length / reqSkills.length) * 100);
}

/**
 * Experience score: how well candidate years match required range.
 */
function scoreExperience(candidateDetails, requirements) {
  const reqStr = (requirements.experience || '').toLowerCase();
  const candStr = (candidateDetails.totalExp || '').toLowerCase();

  if (!reqStr) return 60; // no requirement = neutral
  if (!candStr) return 20; // candidate didn't fill — assume low

  // Extract candidate years
  const candMatch = candStr.match(/(\d+\.?\d*)/);
  if (!candMatch) return 20;
  const candYears = parseFloat(candMatch[1]);

  // Parse requirement: range "3-5", "3–5", or "5+"
  const rangeMatch = reqStr.match(/(\d+\.?\d*)\s*[-–to]+\s*(\d+\.?\d*)/);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    if (candYears >= min && candYears <= max) return 100;
    if (candYears > max) return Math.max(60, 100 - (candYears - max) * 10); // overqualified, still ok
    if (candYears < min) return Math.max(0, 100 - (min - candYears) * 20);
  }

  const plusMatch = reqStr.match(/(\d+\.?\d*)\s*\+/);
  if (plusMatch) {
    const min = parseFloat(plusMatch[1]);
    if (candYears >= min) return 100;
    return Math.max(0, 100 - (min - candYears) * 20);
  }

  const singleMatch = reqStr.match(/(\d+\.?\d*)/);
  if (singleMatch) {
    const req = parseFloat(singleMatch[1]);
    const diff = Math.abs(candYears - req);
    return Math.max(0, 100 - diff * 15);
  }

  return 50;
}

/**
 * Qualification score: candidate qualification vs minimum required.
 */
function scoreQualification(candidateDetails, requirements) {
  const reqQual = (requirements.minimumQualification || '').trim();
  const candQual = (candidateDetails.highestQual || '').trim();

  if (!reqQual) return 70; // no requirement = neutral
  if (!candQual) return 15; // candidate didn't fill

  const reqIdx = QUAL_LEVELS.findIndex(q =>
    q.toLowerCase().includes(reqQual.toLowerCase()) ||
    reqQual.toLowerCase().includes(q.toLowerCase())
  );
  const candIdx = QUAL_LEVELS.findIndex(q =>
    q.toLowerCase().includes(candQual.toLowerCase()) ||
    candQual.toLowerCase().includes(q.toLowerCase())
  );

  if (reqIdx === -1) return 50; // unknown req
  if (candIdx === -1) return 30; // unknown candidate qual

  if (candIdx >= reqIdx) return 100; // meets or exceeds
  const gap = reqIdx - candIdx;
  return Math.max(0, 100 - gap * 25);
}

/**
 * Job title score: fuzzy overlap between candidate title and required designation.
 */
function scoreJobTitle(candidateDetails, requirements) {
  const reqTitle = tokenize(requirements.designation || '');
  const candTitle = tokenize(candidateDetails.currentTitle || '');

  if (!reqTitle.length) return 60; // no requirement = neutral
  if (!candTitle.length) return 10;

  const matches = reqTitle.filter(rt =>
    candTitle.some(ct => ct === rt || ct.includes(rt))
  );
  return Math.round((matches.length / reqTitle.length) * 100);
}

/**
 * Classify total score into a match level.
 */
function getMatchLevel(score) {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Good';
  if (score >= 35) return 'Partial';
  return 'Low';
}

/**
 * Main scoring function.
 */
export function scoreCandidate(candidateDetails, requirements) {
  if (!requirements || !Object.keys(requirements).some(k => requirements[k])) {
    return { score: 0, matchLevel: 'Low', breakdown: { skills: 0, experience: 0, qualification: 0, jobTitle: 0 } };
  }

  const skills = scoreSkills(candidateDetails, requirements);
  const experience = scoreExperience(candidateDetails, requirements);
  const education = scoreQualification(candidateDetails, requirements);
  
  // New metrics, if not calculated, default to 50 or based on requirement
  // Since we don't have deep logic for these yet, we'll assign a moderate score or 0 based on available data
  const projectSimilarity = 50; 
  const certification = 50;
  
  // Location match: if they match, 100, else 0
  const reqLoc = (requirements.location || '').toLowerCase();
  const candLoc = (candidateDetails.currentLocation || '').toLowerCase();
  let location = 50;
  if (reqLoc && candLoc) {
    location = candLoc.includes(reqLoc) || reqLoc.includes(candLoc) ? 100 : 0;
  }

  // Use custom weights if provided, else defaults
  const weights = requirements.matchWeights || {
    skills: 45,
    experience: 25,
    projectSimilarity: 0,
    education: 15,
    certification: 0,
    location: 15
  };

  let score = Math.round(
    skills * (weights.skills / 100) +
    experience * (weights.experience / 100) +
    education * (weights.education / 100) +
    projectSimilarity * (weights.projectSimilarity / 100) +
    certification * (weights.certification / 100) +
    location * (weights.location / 100)
  );

  // Critical Penalty: If required skills are specified but candidate matches 0 of them
  if (requirements.otherKeySkills && skills === 0 && weights.skills > 0) {
    score = Math.round(score * 0.4); // Cut score by 60%
  }

  return {
    score,
    matchLevel: getMatchLevel(score),
    breakdown: { skills, experience, education, projectSimilarity, certification, location },
  };
}

/**
 * Score all candidates against requirements and return sorted results.
 */
export function rankCandidates(candidates, requirements) {
  return candidates
    .map(c => {
      const { score, matchLevel, breakdown } = scoreCandidate(c.details || {}, requirements || {});
      return { ...c, matchScore: score, matchLevel, matchBreakdown: breakdown };
    })
    .sort((a, b) => b.matchScore - a.matchScore);
}

export const MATCH_COLORS = {
  Strong:  { text: 'text-emerald-400', bg: 'bg-emerald-400/15', border: 'border-emerald-400/30', ring: '#34d399' },
  Good:    { text: 'text-accent',      bg: 'bg-accent/15',      border: 'border-accent/30',      ring: '#4F8EF7' },
  Partial: { text: 'text-gold',        bg: 'bg-gold/15',        border: 'border-gold/30',        ring: '#F5A623' },
  Low:     { text: 'text-slate-400',   bg: 'bg-slate-400/15',   border: 'border-slate-400/25',   ring: '#94a3b8' },
};
