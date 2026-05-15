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
import * as pdfjsLib from './lib/pdf.mjs';
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
      case 'files':
        extracted = extractCourseFiles(doc, courseCode);
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

  // Strategy 1: Dashboard-style course cards (most common — works on Home + Dashboard)
  const dashboardCards = doc.querySelectorAll('.dashboard-card[data-course-id]');
  dashboardCards.forEach(card => {
    addCourseFromCard(card, courses);
  });

  // Strategy 2: My Courses page uses different structure (.course-listitem or .coursebox)
  if (courses.length === 0) {
    const courseItems = doc.querySelectorAll('.course-listitem, .coursebox, [data-region="course-content"]');
    courseItems.forEach(card => {
      addCourseFromCard(card, courses);
    });
  }

  // Strategy 3: Any link to course/view.php — last resort
  if (courses.length === 0) {
    const courseLinks = doc.querySelectorAll('a[href*="course/view.php"]');
    const seen = new Set();
    courseLinks.forEach(link => {
      const url = link.href;
      const idMatch = url.match(/[?&]id=(\d+)/);
      if (!idMatch) return;
      const moodleId = idMatch[1];
      if (seen.has(moodleId)) return;
      seen.add(moodleId);

      const text = link.textContent.trim();
      const code = extractCourseCodeFromTitle(text) || `Course-${moodleId}`;
      // Skip system courses (admin/help/etc with very generic IDs like 1)
      if (moodleId === '1' || moodleId === '2') return;
      // Skip if there's no course-code-like text (avoids picking up nav links)
      if (!extractCourseCodeFromTitle(text) && text.length < 5) return;

      courses.push({
        id: code,
        name: text.replace(code, '').trim(),
        moodleId: moodleId,
        url: url,
        category: ''
      });
    });
  }

  return { courses, events: [] };
}

/**
 * Helper used by extractHome strategies 1 and 2.
 */
// System / admin course IDs to skip (not real student courses)
const SYSTEM_COURSE_IDS = new Set([
  '1',       // Site home / Site news
  '2',       // Dashboard / Sandbox
  '26925',   // LEAP programme (non-academic)
  '32611',   // UM General
  '32612'    // UM Student Services
]);

function addCourseFromCard(card, courses) {
  const moodleId = card.getAttribute('data-course-id') ||
                   card.querySelector('[data-course-id]')?.getAttribute('data-course-id');
  if (!moodleId) return;

  // Skip system/admin courses
  if (SYSTEM_COURSE_IDS.has(moodleId)) return;

  // Skip duplicates
  if (courses.some(c => c.moodleId === moodleId)) return;

  const nameEl = card.querySelector('.coursename, .multiline, .course-title');
  const fullName = nameEl?.textContent?.trim() || '';
  if (!fullName) return;

  const urlEl = card.querySelector('a[href*="course/view.php"]');
  const url = urlEl?.href || `https://spectrum.um.edu.my/course/view.php?id=${moodleId}`;
  const categoryEl = card.querySelector('.course-category, .categoryname');
  const category = categoryEl?.textContent?.trim() || '';

  const courseCode = extractCourseCodeFromTitle(fullName) || `Course-${moodleId}`;
  const courseName = courseCode !== `Course-${moodleId}`
    ? fullName.replace(courseCode, '').trim()
    : fullName;

  courses.push({
    id: courseCode,
    name: courseName,
    moodleId: moodleId,
    url: url,
    category: category
  });
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

      // Try multiple strategies to find the course code
      let courseId = extractCourseCodeFromTitle(title);

      // Strategy 2: Look at the event's category/course context in the calendar event item itself
      if (!courseId) {
        const eventLink = link.closest('li[data-region="event-item"]');
        const categoryText = eventLink?.querySelector('.event-category, .calendar-event-coursename')?.textContent;
        if (categoryText) courseId = extractCourseCodeFromTitle(categoryText);
      }

      // Strategy 3: Extract from source URL (course/view.php?id=X)
      if (!courseId) courseId = extractMoodleIdFromUrl(sourceUrl);

      // Strategy 4: Last resort — use eventComponent to make a sensible label
      if (!courseId) {
        if (eventComponent === 'mod_quiz') courseId = 'Quiz';
        else if (eventComponent === 'mod_assign') courseId = 'Assignment';
        else courseId = 'Event';
      }

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

  // Try multiple sources for course code
  let code = courseCode;
  if (!code) code = extractCourseCodeFromTitle(doc.title);
  if (!code) {
    // Try the breadcrumbs
    const breadcrumb = doc.querySelector('.breadcrumb, [aria-label="Navigation bar"]');
    if (breadcrumb) code = extractCourseCodeFromTitle(breadcrumb.textContent);
  }
  if (!code) {
    // Try the page header
    const pageHeader = doc.querySelector('#page-header h1, .page-header-headings h1');
    if (pageHeader) code = extractCourseCodeFromTitle(pageHeader.textContent);
  }
  if (!code) code = 'Course';

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
// EXTRACT: ALL FILES FROM A COURSE PAGE
// ============================================================
function extractCourseFiles(doc, courseCode) {
  const files = [];
  const code = courseCode || extractCourseCodeFromTitle(doc.title) || 'Unknown';

  // Get all sections for grouping
  const sections = doc.querySelectorAll(
    'li.section.course-section[data-sectionid], li.section.main[data-sectionid]'
  );

  sections.forEach(section => {
    const sectionName = section.getAttribute('data-sectionname') || 'General';

    // Resources (files uploaded by lecturers)
    const resources = section.querySelectorAll('li.modtype_resource, li.modtype_folder');
    resources.forEach(activity => {
      const card = activity.querySelector('[data-activityname]');
      const name = card?.getAttribute('data-activityname')?.trim() || '';
      if (!name) return;

      const link = activity.querySelector('a.aalink, a.stretched-link');
      const url = link?.href || '';

      // Detect file type from icon
      const icon = activity.querySelector('.activityicon, [data-region="activity-icon"]');
      const iconSrc = icon?.getAttribute('src') || '';
      const fileType = detectFileType(iconSrc, name);

      // Get description if any
      const descEl = activity.querySelector('.activity-description, .activity-altcontent');
      const description = descEl?.textContent?.replace(/\s+/g, ' ')?.trim()?.substring(0, 200) || '';

      // Is it a folder? (contains multiple files)
      const isFolder = activity.classList.contains('modtype_folder');

      files.push({
        name: name,
        url: url,
        courseId: code,
        section: sectionName,
        fileType: fileType,
        iconSrc: iconSrc,
        description: description,
        isFolder: isFolder,
        activityType: 'resource'
      });
    });

    // URL activities (external links — Zoom, YouTube, etc.)
    const urls = section.querySelectorAll('li.modtype_url');
    urls.forEach(activity => {
      const card = activity.querySelector('[data-activityname]');
      const name = card?.getAttribute('data-activityname')?.trim() || '';
      if (!name) return;

      const link = activity.querySelector('a.aalink, a.stretched-link');
      const url = link?.href || '';

      // Check if it's a video link
      const isVideo = /zoom|panopto|youtube|youtu\.be|video|mp4|recording|lecture.*vid/i.test(name + ' ' + url);
      const fileType = isVideo ? 'video' : 'link';

      files.push({
        name: name,
        url: url,
        courseId: code,
        section: sectionName,
        fileType: fileType,
        iconSrc: '',
        description: '',
        isFolder: false,
        activityType: 'url'
      });
    });
  });

  return { files };
}

/**
 * Detect file type from Moodle's icon URL pattern.
 * Fallback: check the file name for extensions.
 */
function detectFileType(iconSrc, fileName) {
  // Icon-based detection (most reliable)
  if (iconSrc) {
    const iconLower = iconSrc.toLowerCase();
    if (iconLower.includes('f/pdf')) return 'pdf';
    if (iconLower.includes('f/powerpoint')) return 'pptx';
    if (iconLower.includes('f/document')) return 'docx';
    if (iconLower.includes('f/spreadsheet')) return 'xlsx';
    if (iconLower.includes('f/video')) return 'video';
    if (iconLower.includes('f/audio')) return 'audio';
    if (iconLower.includes('f/archive')) return 'zip';
    if (iconLower.includes('f/image')) return 'image';
    if (iconLower.includes('f/text')) return 'text';
    if (iconLower.includes('f/sourcecode')) return 'code';
    if (iconLower.includes('f/markup')) return 'html';
    if (iconLower.includes('folder')) return 'folder';
  }

  // Name-based fallback
  const nameLower = (fileName || '').toLowerCase();
  if (/\.pdf$/i.test(nameLower)) return 'pdf';
  if (/\.pptx?$/i.test(nameLower)) return 'pptx';
  if (/\.docx?$/i.test(nameLower)) return 'docx';
  if (/\.xlsx?$/i.test(nameLower)) return 'xlsx';
  if (/\.mp4|\.mkv|\.avi|\.mov$/i.test(nameLower)) return 'video';
  if (/\.mp3|\.wav|\.ogg$/i.test(nameLower)) return 'audio';
  if (/\.zip|\.rar|\.7z|\.tar$/i.test(nameLower)) return 'zip';
  if (/\.png|\.jpg|\.jpeg|\.gif|\.svg$/i.test(nameLower)) return 'image';
  if (/slide|presentation|lecture.*note/i.test(nameLower)) return 'pptx';
  if (/lab.*manual|tutorial.*sheet|worksheet/i.test(nameLower)) return 'pdf';

  return 'file'; // generic
}

// ============================================================
// HELPERS
// ============================================================

function extractCourseCodeFromTitle(text) {
  if (!text) return null;
  // Try patterns from most specific to least:
  // Pattern 1: WIA1006/WID3006 (combined codes)
  let match = text.match(/([A-Z]{2,4}\d{3,4}\/[A-Z]{2,4}\d{3,4})/);
  if (match) return match[1];
  // Pattern 2: Standard WIA1002 / GIG1005 / WIE2003
  match = text.match(/\b([A-Z]{2,4}\d{3,4})\b/);
  if (match) return match[1];
  // Pattern 3: codes that show as "WIA 1002" with a space
  match = text.match(/\b([A-Z]{2,4})\s+(\d{3,4})\b/);
  if (match) return match[1] + match[2];
  return null;
}

/**
 * Extract Moodle course ID from a URL.
 * Used as last-resort fallback when title parsing fails.
 */
function extractMoodleIdFromUrl(url) {
  if (!url) return null;
  const courseViewMatch = url.match(/\/course\/view\.php\?[^"']*[?&]id=(\d+)/);
  if (courseViewMatch) return `Course-${courseViewMatch[1]}`;
  return null;
}

function extractCourseCodeFromUrl(url) {
  return extractMoodleIdFromUrl(url);
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

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    if (html.includes('loginform') || html.includes('login/index.php')) {
      return { success: false, error: 'Not logged in' };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Extract sesskey from page
    const sessKeyMatch = html.match(/sesskey=([a-zA-Z0-9]+)/);
    const pageSessKey = sessKeyMatch ? sessKeyMatch[1] : '';

    const sessions = [];

    // ===== DIAGNOSTIC LOGGING =====
    const diagnostics = {
      url,
      hasSessKey: !!pageSessKey,
      submitLinks: doc.querySelectorAll('a[href*="attendance.php"]').length,
      tables: doc.querySelectorAll('table').length,
      rows: doc.querySelectorAll('table tr').length,
      formActions: Array.from(doc.querySelectorAll('form')).map(f => f.action).slice(0, 3),
      sampleHrefs: Array.from(doc.querySelectorAll('a')).slice(0, 20).map(a => a.href).filter(h => h.includes('attendance'))
    };
    console.log('[SpectrumX Attendance] Page diagnostics:', diagnostics);

    // ===== STRATEGY 1: Find "Submit attendance" / "Mark" links =====
    const submitLinks = doc.querySelectorAll(
      'a[href*="attendance.php?sessid"], ' +
      'a[href*="attendance/attendance.php"], ' +
      'a[href*="/attendance.php"]'
    );

    submitLinks.forEach(link => {
      const href = link.getAttribute('href') || '';
      const sessIdMatch = href.match(/sessid=(\d+)/);
      if (!sessIdMatch) return;

      const sessKeyFromLink = href.match(/sesskey=([a-zA-Z0-9]+)/);

      const row = link.closest('tr') || link.parentElement;
      const cells = row?.querySelectorAll('td') || [];

      let sessionTime = '';
      let sessionName = '';
      if (cells.length >= 2) {
        sessionTime = cells[0]?.textContent?.trim() || '';
        sessionName = cells[1]?.textContent?.trim() || '';
      } else {
        sessionTime = link.textContent?.trim() || 'Open session';
      }

      sessions.push({
        sessId: sessIdMatch[1],
        sessKey: sessKeyFromLink ? sessKeyFromLink[1] : pageSessKey,
        submitUrl: new URL(href, url).href,
        sessionTime,
        sessionName,
        canMark: true,
        alreadyMarked: false,
        hasPassword: false
      });
    });

    // ===== STRATEGY 2: If no submit links, look for "Submit attendance" text inside <a> =====
    if (sessions.length === 0) {
      const allLinks = doc.querySelectorAll('a');
      allLinks.forEach(link => {
        const text = (link.textContent || '').toLowerCase().trim();
        if (!/submit attendance|mark attendance|self.?mark/i.test(text)) return;

        const href = link.getAttribute('href') || '';
        if (!href || href === '#') return;

        const sessIdMatch = href.match(/sessid=(\d+)/);
        const fullUrl = new URL(href, url).href;

        const row = link.closest('tr') || link.parentElement;
        const cells = row?.querySelectorAll('td') || [];
        let sessionTime = cells[0]?.textContent?.trim() || '';
        let sessionName = cells[1]?.textContent?.trim() || link.textContent?.trim() || '';

        sessions.push({
          sessId: sessIdMatch ? sessIdMatch[1] : 'unknown',
          sessKey: pageSessKey,
          submitUrl: fullUrl,
          sessionTime,
          sessionName,
          canMark: true,
          alreadyMarked: false,
          hasPassword: false
        });
      });
    }

    // ===== STRATEGY 3: Find already-marked sessions =====
    const allRows = doc.querySelectorAll('table tr');
    allRows.forEach(row => {
      // Skip if this row already has a submit link (captured above)
      if (row.querySelector('a[href*="sessid"]')) return;

      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;

      // Check cells for exact status words
      let foundStatus = null;
      for (const cell of cells) {
        const text = cell.textContent.trim();
        const match = text.match(/^(Present|Late|Absent|Excused)\b/i);
        if (match) {
          foundStatus = match[1];
          break;
        }
      }
      if (!foundStatus) return;

      sessions.push({
        sessId: null,
        sessKey: null,
        submitUrl: null,
        sessionTime: cells[0]?.textContent?.trim() || '',
        sessionName: cells[1]?.textContent?.trim() || '',
        canMark: false,
        alreadyMarked: true,
        hasPassword: false,
        status: foundStatus
      });
    });

    console.log('[SpectrumX Attendance] Found sessions:', {
      open: sessions.filter(s => s.canMark).length,
      marked: sessions.filter(s => s.alreadyMarked).length,
      total: sessions.length
    });

    return { success: true, data: { sessions } };
  } catch (err) {
    console.error('[SpectrumX Attendance] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Mark attendance as Present by fetching form, finding status value, POSTing.
 */
async function handleMarkAttendance({ submitUrl, sessId, sessKey }) {
  try {
    console.log('[SpectrumX Mark] Starting:', { submitUrl, sessId });

    // Step 1: Fetch the form page
    const formResponse = await fetch(submitUrl, {
      credentials: 'include',
      headers: { 'Accept': 'text/html' }
    });

    if (!formResponse.ok) {
      return { success: false, error: `HTTP ${formResponse.status}` };
    }

    const formHtml = await formResponse.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(formHtml, 'text/html');

    // Step 2: Check for password field
    const passwordField = doc.querySelector(
      'input[name="studentpassword"], input[type="password"]'
    );
    if (passwordField) {
      return {
        success: false,
        error: 'This session requires a password. Mark manually on Spectrum.'
      };
    }

    // Step 3: Find the "Present" status radio value
    let presentValue = null;

    // Strategy A: Radio with name="status" + label saying "Present"
    const radios = doc.querySelectorAll('input[type="radio"][name="status"]');
    radios.forEach(radio => {
      const id = radio.id;
      const label = id ? doc.querySelector(`label[for="${id}"]`) : null;
      const labelText = (label?.textContent || '').toLowerCase().trim();
      const siblingText = (radio.parentElement?.textContent || '').toLowerCase().trim();
      const combined = labelText + ' ' + siblingText;

      // Match "present" but not "not present"
      if (/\bpresent\b/i.test(combined) && !/not\s*present/i.test(combined)) {
        if (!presentValue) presentValue = radio.value;
      }
    });

    // Strategy B: If no match by label, take the FIRST radio (most lecturers
    // configure "Present" as the first status)
    if (!presentValue && radios.length > 0) {
      presentValue = radios[0].value;
      console.log('[SpectrumX Mark] Using first radio as Present:', presentValue);
    }

    if (!presentValue) {
      return { success: false, error: 'Could not find "Present" status on the form. Mark manually.' };
    }

    // Step 4: Get sesskey from form
    const formSessKey = doc.querySelector('input[name="sesskey"]')?.value ||
                        sessKey ||
                        formHtml.match(/sesskey=([a-zA-Z0-9]+)/)?.[1] || '';

    if (!formSessKey) {
      return { success: false, error: 'Missing sesskey — cannot submit safely' };
    }

    // Step 5: Build form data with ALL hidden inputs
    const formData = new URLSearchParams();
    formData.append('sessid', sessId);
    formData.append('sesskey', formSessKey);
    formData.append('status', presentValue);

    // Include all hidden inputs from the form
    const form = doc.querySelector('form[method="post"], form#mform1, form.mform') ||
                 doc.querySelector('form');
    if (form) {
      form.querySelectorAll('input[type="hidden"]').forEach(input => {
        const name = input.getAttribute('name');
        const value = input.getAttribute('value') || '';
        if (name && !['sessid', 'sesskey', 'status'].includes(name)) {
          formData.append(name, value);
        }
      });

      // Add the "submit" button name=value (sometimes required)
      const submitBtn = form.querySelector('input[type="submit"][name], button[type="submit"][name]');
      if (submitBtn) {
        const sName = submitBtn.getAttribute('name');
        const sValue = submitBtn.getAttribute('value') || '1';
        if (sName) formData.append(sName, sValue);
      }
    }

    // Step 6: Find form action URL
    const actionUrl = form?.getAttribute('action') || submitUrl;
    const fullActionUrl = new URL(actionUrl, submitUrl).href;

    console.log('[SpectrumX Mark] Submitting to:', fullActionUrl, 'status:', presentValue);

    // Step 7: POST the form
    const postResponse = await fetch(fullActionUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    if (!postResponse.ok && !postResponse.redirected) {
      return { success: false, error: `Server returned HTTP ${postResponse.status}` };
    }

    const resultHtml = await postResponse.text();

    // Check for explicit error messages
    if (/wrong\s*password|incorrect\s*password/i.test(resultHtml)) {
      return { success: false, error: 'Password required (or wrong password)' };
    }
    if (/not.*allowed|access.*denied/i.test(resultHtml)) {
      return { success: false, error: 'Server rejected — you may not be allowed to mark this session' };
    }

    // Look for success indicators
    const successIndicators = /attendance.*saved|attendance.*recorded|status.*saved|self[-\s]?marked/i;
    const hasSuccessIndicator = successIndicators.test(resultHtml);

    // If we got redirected back to view page (typical Moodle success behavior), assume success
    if (postResponse.redirected || hasSuccessIndicator) {
      return { success: true };
    }

    // Fallback: if we got 200 OK and no error keywords, assume success
    return { success: true };
  } catch (err) {
    console.error('[SpectrumX Mark] Error:', err);
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