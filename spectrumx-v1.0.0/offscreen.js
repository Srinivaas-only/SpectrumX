/**
 * SpectrumX Offscreen Document
 * 
 * Service workers in MV3 don't have access to DOMParser.
 * This offscreen document runs in a normal page context, so it has
 * full DOM access. The background worker delegates HTML parsing here.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'PARSE_HTML') {
    handleParseHtml(message.payload).then(sendResponse);
    return true; // Keep channel open for async response
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

    // Check for login redirect
    if (html.includes('loginform') || html.includes('Log in to the site') || html.includes('login/index.php')) {
      return { success: false, error: 'Not logged in — please log into Spectrum first', url };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let extracted;
    switch (extractType) {
      case 'dashboard':
        extracted = extractDashboard(doc);
        break;
      case 'calendar-upcoming':
        extracted = extractCalendarUpcoming(doc);
        break;
      case 'calendar-month':
        extracted = extractCalendarMonth(doc);
        break;
      case 'course':
        extracted = extractCoursePage(doc, courseCode);
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

// ============================================================
// EXTRACTORS
// ============================================================

function extractDashboard(doc) {
  const courses = [];
  const events = [];

  // Find enrolled courses from course cards
  const courseCards = doc.querySelectorAll(
    '[data-region="course-content"] [data-course-id], .coursebox, .course-listitem, .dashboard-card'
  );

  courseCards.forEach(card => {
    const courseId = card.getAttribute('data-course-id');
    const nameEl = card.querySelector('.coursename a, .course-name a, .multiline a, h4 a, h3 a');
    const name = nameEl?.textContent?.trim() || '';
    const url = nameEl?.href || '';
    const codeMatch = name.match(/([A-Z]{2,4}\d{3,4})/);

    if (courseId || url.includes('course/view.php')) {
      courses.push({
        id: codeMatch ? codeMatch[1] : (courseId || 'Unknown'),
        name: name.replace(/^[A-Z]{2,4}\d{3,4}\s*[-:]\s*/, '').trim(),
        moodleId: courseId,
        url: url || `https://spectrum.um.edu.my/course/view.php?id=${courseId}`
      });
    }
  });

  // Also check nav drawer
  const navLinks = doc.querySelectorAll(
    '.nav-drawer a[href*="course/view.php"], #nav-drawer a[href*="course/view.php"], [data-key="mycourses"] a[href*="course/view.php"]'
  );

  navLinks.forEach(link => {
    const name = link.textContent.trim();
    const url = link.href;
    const idMatch = url.match(/id=(\d+)/);
    const codeMatch = name.match(/([A-Z]{2,4}\d{3,4})/);

    if (idMatch && !courses.find(c => c.moodleId === idMatch[1])) {
      courses.push({
        id: codeMatch ? codeMatch[1] : `Course-${idMatch[1]}`,
        name: name.replace(/^[A-Z]{2,4}\d{3,4}\s*[-:]\s*/, '').trim(),
        moodleId: idMatch[1],
        url: url
      });
    }
  });

  // Extract timeline events
  const timelineItems = doc.querySelectorAll(
    '[data-region="timeline"] [data-region="event-list-item"], [data-region="event-list-content"] li, .block_timeline .event-list-item'
  );

  timelineItems.forEach(item => {
    const titleEl = item.querySelector('a, .event-name-container a, .event-name a');
    const dateEl = item.querySelector('[data-region="event-item-date"], time, .date, .text-muted');
    const courseEl = item.querySelector('.event-name-container small, .event-course, .text-muted:last-child');

    if (titleEl) {
      events.push({
        title: titleEl.textContent.trim(),
        courseId: extractCourseCode(courseEl?.textContent || ''),
        type: inferType(titleEl.textContent),
        date: extractDate(dateEl || item),
        sourceUrl: titleEl.href || 'https://spectrum.um.edu.my/my/',
        sourceText: 'Spectrum > Dashboard > Timeline',
        description: ''
      });
    }
  });

  return { courses, events };
}

function extractCalendarUpcoming(doc) {
  const events = [];
  const eventItems = doc.querySelectorAll(
    '.event, [data-event-id], .calendar_event_course, .calendar_event_user'
  );

  eventItems.forEach(item => {
    const titleEl = item.querySelector('a[data-action="view-event"], .referer a, .eventname a, h3 a');
    const dateEl = item.querySelector('.col-11, .date, time, [data-timestamp]');
    const courseEl = item.querySelector('.course, .text-muted, small');

    if (titleEl) {
      events.push({
        title: titleEl.textContent.trim(),
        courseId: extractCourseCode(courseEl?.textContent || item.textContent),
        type: inferType(titleEl.textContent),
        date: extractDate(dateEl || item),
        sourceUrl: titleEl.href || 'https://spectrum.um.edu.my/calendar/view.php?view=upcoming',
        sourceText: 'Spectrum > Calendar > Upcoming',
        description: ''
      });
    }
  });

  return { events };
}

function extractCalendarMonth(doc) {
  const events = [];
  const dayLinks = doc.querySelectorAll(
    '.calendar_event_course, .calendar_event_category, [data-event-title], a[data-action="view-event"]'
  );

  dayLinks.forEach(link => {
    const title = link.getAttribute('data-event-title') || link.textContent.trim();
    const href = link.href || '';

    if (title && title.length > 2) {
      events.push({
        title: title,
        courseId: extractCourseCode(link.closest('td, div')?.textContent || ''),
        type: inferType(title),
        date: extractDate(link),
        sourceUrl: href || 'https://spectrum.um.edu.my/calendar/view.php?view=month',
        sourceText: 'Spectrum > Calendar',
        description: ''
      });
    }
  });

  return { events };
}

function extractCoursePage(doc, courseCode) {
  const events = [];
  const forumUrls = [];
  const code = courseCode || extractCourseCode(doc.title);

  // Strategy 1: Find activities with date info
  const activities = doc.querySelectorAll(
    '.activity, .activity-item, [data-activityname], li.modtype_assign, li.modtype_quiz, li.modtype_forum'
  );

  activities.forEach(activity => {
    const nameEl = activity.querySelector('.activityname a, .activity-name a, .aalink, .instancename');
    const dateEl = activity.querySelector('.activity-dates, [data-region="activity-dates"], .text-muted, .description .text-info');

    if (nameEl) {
      const activityName = nameEl.textContent.trim();
      const activityUrl = nameEl.href || '';
      const dateText = dateEl?.textContent || '';

      const dateMatch = dateText.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i);
      const dueMatch = dateText.match(/(?:Due|Closes|Close|Deadline|Opens):\s*(.+?)(?:\n|$|,\s*(?:Due|Closes|Opens))/i);

      if (dateMatch || dueMatch) {
        events.push({
          title: activityName,
          courseId: code,
          type: inferType(activityName + ' ' + (activity.className || '')),
          date: dueMatch ? parseDateString(dueMatch[1].trim()) : parseDateString(dateMatch[1]),
          sourceUrl: activityUrl,
          sourceText: `Spectrum > ${code} > ${activityName}`,
          description: dateText.trim()
        });
      }

      // Track forum URLs for announcement scanning
      if ((activity.classList.contains('modtype_forum') || activity.className.includes('forum')) && forumUrls.length < 2) {
        if (activityUrl) forumUrls.push(activityUrl);
      }
    }
  });

  // Strategy 2: Date blocks
  const dateBlocks = doc.querySelectorAll(
    '[data-region="activity-dates"] [data-region="activity-date-item"], .activity-date-item'
  );

  dateBlocks.forEach(block => {
    const text = block.textContent.trim();
    const match = text.match(/(?:Due|Closes|Opens|Deadline):\s*(.+)/i);
    if (match) {
      const pageTitle = doc.querySelector('#page-header h1, .page-header-headings h1');
      events.push({
        title: pageTitle?.textContent?.trim() || 'Activity',
        courseId: code,
        type: inferType(text),
        date: parseDateString(match[1].trim()),
        sourceUrl: '',
        sourceText: `Spectrum > ${code}`,
        description: text
      });
    }
  });

  return { events, forumUrls };
}

function extractForumPage(doc, courseCode) {
  const events = [];
  const code = courseCode || 'Unknown';

  const posts = doc.querySelectorAll(
    '.forumpost, .forum-post-container, [data-region="post"]'
  );

  posts.forEach(post => {
    const subjectEl = post.querySelector('.subject a, .discussion-name a, .post-header a');
    const contentEl = post.querySelector('.posting, .post-content-container, .post-content');
    const content = contentEl?.textContent || '';
    const subject = subjectEl?.textContent?.trim() || '';

    const datePatterns = [
      /(?:quiz|test|exam|viva|presentation|submission|deadline|due|assignment|lab)\s*(?:\d+\s*)?(?:[-:—]\s*)?(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4})/gi,
      /(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4})\s*[-:—]?\s*(?:quiz|test|exam|viva|presentation|submission|deadline|due|assignment|lab)/gi,
      /(?:due|deadline|submit|submission)\s*(?:date|by|before|on)?\s*[:—]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/gi,
    ];

    datePatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const surroundingStart = Math.max(0, match.index - 80);
        const surroundingEnd = Math.min(content.length, match.index + match[0].length + 80);
        const surrounding = content.substring(surroundingStart, surroundingEnd).trim();

        events.push({
          title: subject || extractTitleFromContext(surrounding),
          courseId: code,
          type: inferType(surrounding),
          date: parseDateString(match[1]),
          sourceUrl: subjectEl?.href || '',
          sourceText: `Spectrum > ${code} > Announcements`,
          description: surrounding.substring(0, 200)
        });
      }
    });
  });

  return { events };
}

// ============================================================
// HELPERS
// ============================================================

function extractCourseCode(text) {
  if (!text) return 'Unknown';
  const match = text.match(/([A-Z]{2,4}\d{3,4})/);
  return match ? match[1] : 'Unknown';
}

function extractDate(element) {
  if (!element) return null;

  const ts = element.getAttribute?.('data-timestamp') ||
    element.querySelector?.('[data-timestamp]')?.getAttribute('data-timestamp');
  if (ts) return new Date(parseInt(ts) * 1000).toISOString();

  const timeEl = element.tagName === 'TIME' ? element : element.querySelector?.('time');
  if (timeEl?.dateTime) return new Date(timeEl.dateTime).toISOString();
  if (timeEl?.getAttribute?.('datetime')) return new Date(timeEl.getAttribute('datetime')).toISOString();

  return parseDateString(element.textContent?.trim() || '');
}

function parseDateString(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\d{1,2})(st|nd|rd|th)/gi, '$1')
    .trim();

  const date = new Date(cleaned);
  if (!isNaN(date.getTime())) return date.toISOString();

  // Try DD/MM/YYYY format
  const ddmmyyyy = cleaned.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (ddmmyyyy) {
    const year = ddmmyyyy[3].length === 2 ? '20' + ddmmyyyy[3] : ddmmyyyy[3];
    const d = new Date(`${year}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

function inferType(text) {
  const lower = (text || '').toLowerCase();
  if (/\bfinal\s*exam\b|\bmid[\s-]*sem|\bexam\b/.test(lower)) return 'exam';
  if (/\bquiz\b|\btest\b/.test(lower)) return 'quiz';
  if (/\blab\b/.test(lower)) return 'lab';
  if (/\bviva\b/.test(lower)) return 'viva';
  if (/\bpresent/.test(lower)) return 'presentation';
  if (/\bproject\b/.test(lower)) return 'project';
  if (/\bassign|\bsubmission|\bsubmit|\breport\b|\bhomework/.test(lower)) return 'assignment';
  if (/\btutorial\b/.test(lower)) return 'tutorial';
  if (/modtype_quiz/.test(lower)) return 'quiz';
  if (/modtype_assign/.test(lower)) return 'assignment';
  return 'other';
}

function extractTitleFromContext(text) {
  const match = text.match(/(quiz|test|exam|viva|presentation|lab|assignment|project)\s*\d*/i);
  return match ? match[0].trim() : text.substring(0, 60).trim();
}