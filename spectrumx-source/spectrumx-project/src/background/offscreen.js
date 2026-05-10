/**
 * SpectrumX Offscreen Document
 *
 * Service workers in MV3 don't have access to DOMParser.
 * This offscreen document runs in a normal page context with full DOM access.
 * The background worker delegates HTML parsing here.
 *
 * Selectors are tuned to UM Spectrum (https://spectrum.um.edu.my/)
 * which runs Moodle 4.x with the Moove theme.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'PARSE_HTML') {
    handleParseHtml(message.payload).then(sendResponse);
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
      default:
        extracted = { courses: [], events: [] };
    }

    return { success: true, data: extracted, url };
  } catch (err) {
    return { success: false, error: err.message, url };
  }
}

// ============================================================
// EXTRACT: HOME PAGE (https://spectrum.um.edu.my/)
//
// The Home page contains ALL enrolled courses as cards:
// <div class="card dashboard-card" data-region="course-content" data-course-id="2447">
//   <a href="https://spectrum.um.edu.my/course/view.php?id=2447">
//     <span class="sr-only">GIG1005 SOCIAL ENGAGEMENT</span>
//     <div class="course-category">University</div>
//   </a>
//   <a class="aalink coursename">GIG1005 SOCIAL ENGAGEMENT</a>
//   <div class="course-summary">Session 2025/2026 Semester 2</div>
// </div>
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

    // Extract course code (e.g., "WIA1006/WID3006" or "GIG1005")
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
//   URL: https://spectrum.um.edu.my/calendar/view.php?view=month
//
// Calendar structure on UM Spectrum:
// <td class="day" data-day-timestamp="1777996800" data-region="day">
//   <div data-region="day-content">
//     <ul>
//       <li data-region="event-item"
//           data-event-component="mod_quiz"
//           data-event-eventtype="open|close|due">
//         <a data-action="view-event"
//            data-event-id="1159727"
//            href="https://spectrum.um.edu.my/mod/quiz/view.php?id=1093664"
//            title="20252026-2 Mid Term Quiz opens">
//           <span class="eventname">20252026-2 Mid Term Quiz opens</span>
//         </a>
//       </li>
//     </ul>
//   </div>
// </td>
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

      // Skip pure attendance markers — they're not deadlines
      if (eventComponent === 'mod_attendance' && eventType === 'attendance') return;

      // Extract course code from title or URL
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
// EXTRACT: COURSE PAGE (https://spectrum.um.edu.my/course/view.php?id=XXX)
//
// Course pages contain activity items:
// <li class="activity activity-wrapper assign modtype_assign" data-id="1080255">
//   <div class="activity-item" data-activityname="Individual Assignment Due Date 5th April 2026">
//     <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1080255">
//       <span class="instancename">Individual Assignment Due Date 5th April 2026</span>
//     </a>
//     <div class="activity-altcontent activity-description">
//       <!-- Description text often contains date keywords -->
//     </div>
//   </div>
// </li>
//
// Activity types we care about:
//   modtype_assign       → assignment
//   modtype_quiz         → quiz
//   modtype_forum        → forum (often has announcements)
//   modtype_workshop     → workshop
//   modtype_lesson       → lesson
//   modtype_choice       → choice
//   modtype_attendance   → IGNORED (just attendance markers)
// ============================================================
function extractCoursePage(doc, courseCode) {
  const events = [];
  const code = courseCode || extractCourseCodeFromTitle(doc.title) || 'Unknown';

  // Find activities that could be deadline-bearing
  const activities = doc.querySelectorAll(
    'li.modtype_assign, li.modtype_quiz, li.modtype_workshop, li.modtype_lesson, li.modtype_choice'
  );

  activities.forEach(activity => {
    const activityCard = activity.querySelector('[data-activityname]');
    if (!activityCard) return;

    const activityName = activityCard.getAttribute('data-activityname')?.trim() || '';
    if (!activityName) return;

    const link = activity.querySelector('.instancename')?.closest('a') ||
                 activity.querySelector('a.aalink');
    const sourceUrl = link?.href || '';

    // Extract description for date hints
    const descEl = activity.querySelector('.activity-description, .activity-altcontent');
    const description = descEl?.textContent?.trim() || '';

    // Determine type from class
    let type = 'other';
    if (activity.classList.contains('modtype_assign')) type = 'assignment';
    else if (activity.classList.contains('modtype_quiz')) type = 'quiz';
    else if (activity.classList.contains('modtype_workshop')) type = 'project';
    else if (activity.classList.contains('modtype_lesson')) type = 'tutorial';

    // Try to extract a date from the activity name OR description
    // UM lecturers commonly embed dates in activity names like:
    //   "Individual Assignment Due Date 5th April 2026"
    //   "Group Project: Submission Deadline12 June 2026"
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

  return { events };
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
  // Some Moodle URLs include course context, but mostly we extract via title
  return null;
}

function inferTypeFromComponent(component, title) {
  // Map Moodle module types to SpectrumX event types
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

  // Fallback: infer from title keywords
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
 * Parse a date out of free-text. Handles:
 *   "5th April 2026"
 *   "5 April 2026"
 *   "April 5 2026"
 *   "12 June 2026"
 *   "Deadline12 June 2026"  (no space — common typo)
 *   "5/4/2026" (DD/MM/YYYY — Malaysian format)
 *   "2026-04-05" (ISO)
 */
function parseDateFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // Pattern 1: "5th April 2026" or "5 April 2026"
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

  // Pattern 2: "Deadline12 June 2026" — date with no space before
  const stuckPattern = new RegExp(
    `(?:deadline|due\\s*date|by|before|on)(\\d{1,2})\\s*(${monthName})\\s*(\\d{4})`,
    'i'
  );
  match = text.match(stuckPattern);
  if (match) {
    const d = new Date(`${match[2]} ${match[1]}, ${match[3]} 23:59`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Pattern 3: "April 5 2026" or "April 5, 2026"
  const monthDayYear = new RegExp(
    `(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})`,
    'i'
  );
  match = text.match(monthDayYear);
  if (match) {
    const d = new Date(`${match[1]} ${match[2]}, ${match[3]} 23:59`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Pattern 4: DD/MM/YYYY (Malaysian format) or DD-MM-YYYY
  const ddmmyyyy = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (ddmmyyyy) {
    const d = new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}T23:59:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Pattern 5: ISO format YYYY-MM-DD
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T23:59:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}