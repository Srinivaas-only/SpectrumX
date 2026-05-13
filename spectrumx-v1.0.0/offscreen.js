/**
 * SpectrumX Offscreen Document
 *
 * Service workers in MV3 don't have access to DOMParser.
 * This offscreen document runs in a normal page context with full DOM access.
 * The background worker delegates HTML parsing here.
 *
 * Also handles PDF text extraction via PDF.js.
 *
 * Selectors are tuned to UM Spectrum (https://spectrum.um.edu.my/)
 * which runs Moodle 4.x with the Moove theme.
 */

// PDF.js — for extracting text from PDF resources
import * as pdfjsLib from '../lib/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  // Attendance-specific parsing (must be before generic PARSE_HTML)
  if (message.type === 'PARSE_HTML' && message.payload.extractType === 'attendance') {
    handleParseAttendance(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'PARSE_HTML') {
    handleParseHtml(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'EXTRACT_PDF_TEXT') {
    handleExtractPdfText(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === 'MARK_ATTENDANCE') {
    handleMarkAttendance(message.payload).then(sendResponse);
    return true;
  }
});

/**
 * Fetch a URL and parse the HTML, returning extracted data.
 */
async function handleParseHtml({ url, extractType, courseCode }) {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, url };
    }

    const html = await response.text();

    // Detect login redirect
    if (html.includes('loginform') || html.includes('login/index.php') ||
        html.includes('Log in to the site')) {
      return { success: false, error: 'Not logged in — please log into Spectrum first', url };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let extracted;
    switch (extractType) {
      case 'home':
        extracted = extractHome(doc);
        break;
      case 'calendar-month':
        extracted = extractCalendarMonth(doc);
        break;
      case 'course':
        extracted = extractCoursePage(doc, courseCode);
        break;
      case 'assignment':
        extracted = extractAssignmentPage(doc, courseCode);
        break;
      case 'forum':
        extracted = extractForumPage(doc, courseCode);
        break;
      default:
        extracted = { courses: [], events: [] };
    }

    return { success: true, data: extracted, url };
  } catch (err) {
    return { success: false, error: err.message, url };
  }
}

/**
 * Fetch a PDF, extract all text using PDF.js.
 * Returns { success, text, pageCount, url }
 */
async function handleExtractPdfText({ url }) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, url };
    }

    const buffer = await response.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;

    let fullText = '';
    const pageCount = pdf.numPages;

    // Extract text from each page (limit to first 20 pages to avoid huge PDFs)
    const maxPages = Math.min(pageCount, 20);
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      fullText += pageText + '\n\n';
    }

    return {
      success: true,
      text: fullText.trim(),
      pageCount: pageCount,
      truncated: pageCount > maxPages,
      url: url
    };
  } catch (err) {
    return { success: false, error: err.message, url };
  }
}

// ============================================================
// EXTRACT: HOME PAGE
// ============================================================
function extractHome(doc) {
  const courses = [];
  const courseCards = doc.querySelectorAll('.dashboard-card[data-course-id]');

  courseCards.forEach(card => {
    const moodleId = card.getAttribute('data-course-id');
    const nameEl = card.querySelector('.coursename');
    const fullName = nameEl?.textContent?.trim() || '';
    const url = nameEl?.href || `https://spectrum.um.edu.my/course/view.php?id=${moodleId}`;
    const categoryEl = card.querySelector('.course-category');
    const category = categoryEl?.textContent?.trim() || '';

    const codeMatch = fullName.match(/^([A-Z]{2,4}\d{3,4}(?:\/[A-Z]{2,4}\d{3,4})?)/);
    const courseCode = codeMatch ? codeMatch[1] : `Course-${moodleId}`;
    const courseName = codeMatch ? fullName.replace(codeMatch[0], '').trim() : fullName;

    courses.push({
      id: courseCode,
      name: courseName,
      moodleId: moodleId,
      url: url,
      category: category
    });
  });

  return { courses, events: [] };
}

// ============================================================
// EXTRACT: CALENDAR MONTH VIEW
// ============================================================
function extractCalendarMonth(doc) {
  const events = [];
  const dayCells = doc.querySelectorAll('td.day[data-region="day"][data-day-timestamp]');

  dayCells.forEach(cell => {
    const timestamp = parseInt(cell.getAttribute('data-day-timestamp'));
    if (!timestamp || isNaN(timestamp)) return;

    const dayDate = new Date(timestamp * 1000);
    if (isNaN(dayDate.getTime())) return;

    const eventItems = cell.querySelectorAll('li[data-region="event-item"]');

    eventItems.forEach(item => {
      const link = item.querySelector('a[data-action="view-event"]');
      if (!link) return;

      const title = link.getAttribute('title')?.trim() ||
                    item.querySelector('.eventname')?.textContent?.trim() || '';
      const sourceUrl = link.getAttribute('href') || '';
      const eventComponent = item.getAttribute('data-event-component') || '';
      const eventType = item.getAttribute('data-event-eventtype') || '';

      if (eventComponent === 'mod_attendance' && eventType === 'attendance') return;

      const courseId = extractCourseCodeFromTitle(title) ||
                       extractCourseCodeFromUrl(sourceUrl) || 'Unknown';

      events.push({
        title: title,
        courseId: courseId,
        type: inferTypeFromComponent(eventComponent, title),
        date: dayDate.toISOString(),
        sourceUrl: sourceUrl,
        sourceText: `Spectrum > Calendar > ${title}`,
        description: `${eventType ? `Event type: ${eventType}` : ''}`,
        eventComponent: eventComponent,
        eventType: eventType
      });
    });
  });

  return { events };
}

// ============================================================
// EXTRACT: COURSE PAGE
// ============================================================
function extractCoursePage(doc, courseCode) {
  const events = [];
  const assignmentUrls = [];
  const forumUrls = [];
  const pdfUrls = [];
  const code = courseCode || extractCourseCodeFromTitle(doc.title) || 'Unknown';

  const activities = doc.querySelectorAll(
    'li.modtype_assign, li.modtype_quiz, li.modtype_workshop, li.modtype_lesson, li.modtype_choice, li.modtype_forum, li.modtype_resource'
  );

  activities.forEach(activity => {
    const activityCard = activity.querySelector('[data-activityname]');
    if (!activityCard) return;

    const activityName = activityCard.getAttribute('data-activityname')?.trim() || '';
    if (!activityName) return;

    const link = activity.querySelector('.instancename')?.closest('a') ||
                 activity.querySelector('a.aalink');
    const sourceUrl = link?.href || '';

    // Collect URLs for deeper scanning
    if (activity.classList.contains('modtype_assign') && sourceUrl) {
      assignmentUrls.push(sourceUrl);
    }
    if (activity.classList.contains('modtype_forum') && sourceUrl &&
        /announcement/i.test(activityName)) {
      forumUrls.push(sourceUrl);
    }

    // Collect PDF resource URLs (lecture slides, assignment briefs, etc.)
    if (activity.classList.contains('modtype_resource') && sourceUrl) {
      pdfUrls.push({ url: sourceUrl, title: activityName });
    }

    // Skip pure forum activities for direct event extraction
    if (activity.classList.contains('modtype_forum')) return;

    // Skip resource activities — they don't have dates, PDFs are handled by Smart Scan
    if (activity.classList.contains('modtype_resource')) return;

    const descEl = activity.querySelector('.activity-description, .activity-altcontent');
    const description = descEl?.textContent?.trim() || '';

    let type = 'other';
    if (activity.classList.contains('modtype_assign')) type = 'assignment';
    else if (activity.classList.contains('modtype_quiz')) type = 'quiz';
    else if (activity.classList.contains('modtype_workshop')) type = 'project';
    else if (activity.classList.contains('modtype_lesson')) type = 'tutorial';

    const date = parseDateFromText(activityName) || parseDateFromText(description);

    if (date) {
      events.push({
        title: activityName,
        courseId: code,
        type: type,
        date: date,
        sourceUrl: sourceUrl,
        sourceText: `Spectrum > ${code} > ${activityName}`,
        description: description.substring(0, 200)
      });
    }
  });

  return { events, assignmentUrls, forumUrls, pdfUrls };
}

// ============================================================
// HELPERS
// ============================================================

function extractCourseCodeFromTitle(text) {
  if (!text) return null;
  const match = text.match(/([A-Z]{2,4}\d{3,4})/);
  return match ? match[1] : null;
}

function extractCourseCodeFromUrl(url) {
  return null;
}

// ============================================================
// EXTRACT: SINGLE ASSIGNMENT PAGE
// ============================================================
function extractAssignmentPage(doc, courseCode) {
  const events = [];
  const code = courseCode || 'Unknown';

  const titleEl = doc.querySelector('#page-header h1, .page-header-headings h1, h1');
  const title = titleEl?.textContent?.trim() || 'Assignment';

  const dateBlocks = doc.querySelectorAll(
    '[data-region="activity-dates"] [data-region="activity-date-item"], ' +
    '.activity-date, ' +
    '.submissionstatustable td, ' +
    '.box.generalbox td'
  );

  let foundDate = null;
  dateBlocks.forEach(block => {
    const text = block.textContent.trim();
    const dueMatch = text.match(/(?:Due|Closes|Deadline)[:\s]+(.+?)(?:\n|$)/i);
    if (dueMatch && !foundDate) {
      const parsed = parseDateFromText(dueMatch[1]);
      if (parsed) foundDate = parsed;
    }
  });

  const mainContent = doc.querySelector('#region-main, [role="main"]')?.textContent || '';
  if (!foundDate) {
    foundDate = parseDateFromText(mainContent);
  }

  if (foundDate) {
    events.push({
      title: title,
      courseId: code,
      type: 'assignment',
      date: foundDate,
      sourceUrl: '',
      sourceText: `Spectrum > ${code} > ${title}`,
      description: mainContent.substring(0, 300)
    });
  }

  return { events };
}

// ============================================================
// EXTRACT: ANNOUNCEMENTS FORUM
// ============================================================
function extractForumPage(doc, courseCode) {
  const events = [];
  const code = courseCode || 'Unknown';

  const discussions = doc.querySelectorAll(
    '.discussion-list tr, table.discussionsubject tr, [data-region="discussion-list"] [data-region="post"]'
  );

  discussions.forEach(disc => {
    const subjectLink = disc.querySelector('a[href*="discuss.php"], .topic a, .discussionname a');
    if (!subjectLink) return;

    const subject = subjectLink.textContent.trim();
    const sourceUrl = subjectLink.href || '';

    const date = parseDateFromText(subject);
    if (!date) return;

    const lowerSubject = subject.toLowerCase();
    if (!/quiz|test|exam|assign|deadline|due|submit|lab|project|presentation|viva/.test(lowerSubject)) return;

    events.push({
      title: subject,
      courseId: code,
      type: inferTypeFromComponent('', subject),
      date: date,
      sourceUrl: sourceUrl,
      sourceText: `Spectrum > ${code} > Announcements`,
      description: ''
    });
  });

  return { events };
}

function inferTypeFromComponent(component, title) {
  const componentMap = {
    'mod_quiz': 'quiz',
    'mod_assign': 'assignment',
    'mod_workshop': 'project',
    'mod_lesson': 'tutorial',
    'mod_choice': 'other',
    'mod_forum': 'other',
    'mod_attendance': 'tutorial',
    'mod_feedback': 'other'
  };
  if (componentMap[component]) return componentMap[component];

  const lower = (title || '').toLowerCase();
  if (/\bfinal\s*exam\b|\bmid[\s-]*sem|\bexam\b/.test(lower)) return 'exam';
  if (/\bquiz\b|\btest\b/.test(lower)) return 'quiz';
  if (/\blab\b/.test(lower)) return 'lab';
  if (/\bviva\b/.test(lower)) return 'viva';
  if (/\bpresent/.test(lower)) return 'presentation';
  if (/\bproject\b/.test(lower)) return 'project';
  if (/\bassign|\bsubmission|\bsubmit|\bdue\b|\bdeadline/.test(lower)) return 'assignment';
  return 'other';
}

/**
 * Parse an attendance view page to find open sessions.
 */
async function handleParseAttendance({ url }) {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    });
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };

    const html = await response.text();
    if (html.includes('loginform') || html.includes('login/index.php')) {
      return { success: false, error: 'Not logged in' };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const sessKeyMatch = html.match(/sesskey=([a-zA-Z0-9]+)/);
    const pageSessKey = sessKeyMatch ? sessKeyMatch[1] : '';
    const sessions = [];

    // Strategy 1: Find "Submit attendance" links
    const submitLinks = doc.querySelectorAll(
      'a[href*="attendance.php?sessid="], a[href*="attendance/attendance.php"]'
    );
    submitLinks.forEach(link => {
      const href = link.getAttribute('href') || '';
      const sessIdMatch = href.match(/sessid=(\d+)/);
      const sessKeyFromLink = href.match(/sesskey=([a-zA-Z0-9]+)/);
      if (!sessIdMatch) return;

      const row = link.closest('tr') || link.closest('.session-row') || link.parentElement;
      const cells = row?.querySelectorAll('td') || [];
      let sessionTime = '', sessionName = '';
      if (cells.length >= 2) {
        sessionTime = cells[0]?.textContent?.trim() || '';
        sessionName = cells[1]?.textContent?.trim() || '';
      } else {
        sessionTime = row?.textContent?.trim()?.substring(0, 80) || '';
      }

      sessions.push({
        sessId: sessIdMatch[1],
        sessKey: sessKeyFromLink ? sessKeyFromLink[1] : pageSessKey,
        submitUrl: new URL(href, url).href,
        sessionTime, sessionName,
        canMark: true,
        alreadyMarked: false,
        hasPassword: false
      });
    });

    // Strategy 2: Find already-marked sessions
    const allRows = doc.querySelectorAll('table tr, .attendance-table tr');
    allRows.forEach(row => {
      if (row.querySelector('a[href*="attendance.php?sessid="]')) return;
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) return;

      let status = '';
      for (const cell of cells) {
        const t = cell.textContent.trim();
        if (/^(Present|Late|Absent|Excused)$/i.test(t)) { status = t; break; }
      }
      if (!status) return;

      sessions.push({
        sessId: null, sessKey: null, submitUrl: null,
        sessionTime: cells[0]?.textContent?.trim() || '',
        sessionName: cells[1]?.textContent?.trim() || '',
        canMark: false, alreadyMarked: true,
        hasPassword: false, status
      });
    });

    return { success: true, data: { sessions } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Mark attendance as Present by fetching form, finding status value, POSTing.
 */
async function handleMarkAttendance({ submitUrl, sessId, sessKey }) {
  try {
    // Step 1: Fetch the attendance form page
    const formResponse = await fetch(submitUrl, {
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    });
    if (!formResponse.ok) return { success: false, error: `HTTP ${formResponse.status}` };

    const formHtml = await formResponse.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(formHtml, 'text/html');

    // Step 2: Check for password field
    const passwordField = doc.querySelector(
      'input[name="studentpassword"], input[type="password"][name*="password"]'
    );
    if (passwordField) {
      return { success: false, error: 'Password required — please mark manually on Spectrum.' };
    }

    // Step 3: Find the "Present" status value
    let presentValue = null;
    const statusRadios = doc.querySelectorAll('input[type="radio"][name="status"]');
    statusRadios.forEach(radio => {
      const label = doc.querySelector(`label[for="${radio.id}"]`);
      const labelText = label?.textContent?.trim()?.toLowerCase() || '';
      const parentText = radio.parentElement?.textContent?.trim()?.toLowerCase() || '';
      if ((labelText.includes('present') || parentText.includes('present')) &&
          !labelText.includes('not present') && !parentText.includes('not present')) {
        presentValue = radio.value;
      }
    });
    if (!presentValue) return { success: false, error: 'Could not find "Present" status option' };

    // Step 4: Get sesskey from form
    const formSessKey = doc.querySelector('input[name="sesskey"]')?.value ||
                        sessKey || formHtml.match(/sesskey=([a-zA-Z0-9]+)/)?.[1] || '';
    if (!formSessKey) return { success: false, error: 'Missing sesskey — cannot submit safely' };

    // Step 5: Build form data
    const formData = new URLSearchParams();
    formData.append('sessid', sessId);
    formData.append('sesskey', formSessKey);
    formData.append('status', presentValue);

    // Include hidden inputs
    doc.querySelectorAll('form input[type="hidden"]').forEach(input => {
      const name = input.getAttribute('name');
      const value = input.getAttribute('value') || '';
      if (name && name !== 'sessid' && name !== 'sesskey' && name !== 'status') {
        formData.append(name, value);
      }
    });

    // Step 6: Submit
    const form = doc.querySelector('form[method="post"], form[action*="attendance"]');
    const actionUrl = form?.getAttribute('action') || submitUrl;
    const fullActionUrl = new URL(actionUrl, submitUrl).href;

    const postResponse = await fetch(fullActionUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    if (postResponse.ok || postResponse.redirected) {
      const resultHtml = await postResponse.text();
      if (resultHtml.includes('error') && resultHtml.includes('password')) {
        return { success: false, error: 'Server rejected — password may be required' };
      }
      return { success: true };
    }
    return { success: false, error: `Server returned HTTP ${postResponse.status}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Parse a date out of free-text.
 */
function parseDateFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const monthName = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const dayMonthYear = new RegExp(
    `(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthName})\\s*(\\d{4})`,
    'i'
  );
  let match = text.match(dayMonthYear);
  if (match) {
    const d = new Date(`${match[2]} ${match[1]}, ${match[3]} 23:59`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const stuckPattern = new RegExp(
    `(?:deadline|due\\s*date|by|before|on)(\\d{1,2})\\s*(${monthName})\\s*(\\d{4})`,
    'i'
  );
  match = text.match(stuckPattern);
  if (match) {
    const d = new Date(`${match[2]} ${match[1]}, ${match[3]} 23:59`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const monthDayYear = new RegExp(
    `(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})`,
    'i'
  );
  match = text.match(monthDayYear);
  if (match) {
    const d = new Date(`${match[1]} ${match[2]}, ${match[3]} 23:59`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const ddmmyyyy = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (ddmmyyyy) {
    const d = new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}T23:59:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T23:59:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}