/**
 * SpectrumX — Content Script (v2 — Production Grade)
 *
 * Injected into Spectrum (spectrum.um.edu.my) pages.
 *
 * Key Design Decisions:
 * 1. FIRST detects the user's enrolled courses from navigation/sidebar
 * 2. ONLY scrapes events that belong to those courses
 * 3. Uses Moodle URL patterns (course ID params) for reliable identification
 * 4. Discards events with unparseable dates (no fake "today" dates)
 * 5. Announcement scraping disabled by default (too noisy)
 *
 * Moodle/SPeCTRUM DOM Reference:
 * - Nav sidebar: #nav-drawer, .primary-navigation, [data-key="mycourses"]
 * - Course links: a[href*="/course/view.php?id="]
 * - Timeline: [data-region="timeline"]
 * - Upcoming events: .block_calendar_upcoming
 * - Calendar: .calendar_event_course
 * - Activity dates: [data-region="activity-dates"]
 * - Breadcrumbs: .breadcrumb
 */

(function () {
  'use strict';

  console.log('[SpectrumX] Content script v2 loaded on:', window.location.href);

  // ============================================================
  // Course Registry — the single source of truth for "my courses"
  // ============================================================
  class CourseRegistry {
    constructor() {
      /** @type {Map<string, {id: string, name: string, code: string, url: string}>} */
      this.courses = new Map();
      this.initialized = false;
    }

    /**
     * Scan the page for enrolled courses. Priority sources:
     * 1. Navigation sidebar (only shows YOUR courses)
     * 2. Dashboard course overview cards
     * 3. Breadcrumb on a course page
     */
    detect() {
      this.courses.clear();

      // --- Source 1: Left navigation / drawer (most reliable) ---
      this._scanNavigation();

      // --- Source 2: Dashboard "My Courses" overview ---
      if (this.courses.size === 0) {
        this._scanDashboardOverview();
      }

      // --- Source 3: Course pages via URL + breadcrumb ---
      this._scanCurrentPageUrl();

      this.initialized = true;

      console.log(
        `[SpectrumX] CourseRegistry: detected ${this.courses.size} enrolled courses:`,
        [...this.courses.keys()]
      );

      return this;
    }

    _scanNavigation() {
      // Moodle sidebar with enrolled courses
      const selectors = [
        '#nav-drawer a[href*="course"]',
        '.primary-navigation a[href*="course"]',
        '[data-key="mycourses"] a[href*="course"]',
        '#nav-drawer a[href*="view.php"]',
        '.nav-item a[href*="course/view.php"]',
        // SPeCTRUM may use custom selectors
        '.list-group-item a[href*="course"]',
        '[role="navigation"] a[href*="course"]',
      ];

      const links = document.querySelectorAll(selectors.join(', '));
      links.forEach((link) => {
        this._registerCourseLink(link);
      });
    }

    _scanDashboardOverview() {
      // Dashboard course cards / list
      const selectors = [
        '.course-listitem a[href*="course"]',
        '.coursebox a[href*="course"]',
        '[data-region="course-content"] a',
        '.dashboard-card a[href*="course"]',
        '.mycoursecourses a[href*="course"]',
      ];

      const links = document.querySelectorAll(selectors.join(', '));
      links.forEach((link) => {
        this._registerCourseLink(link);
      });
    }

    _scanCurrentPageUrl() {
      // If we're ON a course page, register it from URL + breadcrumb
      const urlMatch = window.location.href.match(/course\/view\.php\?id=(\d+)/);
      if (urlMatch) {
        const moodleId = urlMatch[1];
        const breadcrumb = document.querySelector(
          '.breadcrumb-item:last-child a, .breadcrumb li:last-child a, .breadcrumb a'
        );
        const name = breadcrumb ? breadcrumb.textContent.trim() : `Course ${moodleId}`;
        const code = this._extractCode(name);

        if (!this.courses.has(moodleId)) {
          this.courses.set(moodleId, {
            id: moodleId,
            name: name,
            code: code,
            url: window.location.href.split('?')[0] + '?id=' + moodleId,
          });
        }
      }
    }

    /**
     * Register a course from a link element
     */
    _registerCourseLink(link) {
      const href = link.href || '';
      const name = link.textContent.trim();
      if (!name || name.length < 2) return;

      // Extract Moodle course ID from URL
      const urlMatch = href.match(/course\/view\.php\?id=(\d+)/);
      const moodleId = urlMatch ? urlMatch[1] : null;

      // Extract course code from name (e.g., "WIA2005 Algorithm Design")
      const code = this._extractCode(name);

      if (moodleId) {
        if (!this.courses.has(moodleId)) {
          this.courses.set(moodleId, {
            id: moodleId,
            name: name,
            code: code,
            url: href,
          });
        } else {
          // Enrich existing entry with better data
          const existing = this.courses.get(moodleId);
          if (!existing.code && code) existing.code = code;
          if (name.length > existing.name.length) existing.name = name;
        }
      } else if (code) {
        // Fallback: use code as key if no Moodle ID
        if (!this.courses.has(code)) {
          this.courses.set(code, {
            id: code,
            name: name,
            code: code,
            url: href,
          });
        }
      }
    }

    /**
     * Extract course code like "WIA2005" from text
     */
    _extractCode(text) {
      const match = text.match(/\b([A-Z]{2,4}\d{4}[A-Z]?)\b/);
      return match ? match[1] : null;
    }

    /**
     * Check if a course ID or code belongs to the user's enrolled courses
     */
    isEnrolled(idOrCode) {
      if (!idOrCode || idOrCode === 'Unknown') return false;
      const upper = idOrCode.toUpperCase();

      for (const [, course] of this.courses) {
        if (
          course.id === idOrCode ||
          course.id === upper ||
          (course.code && course.code.toUpperCase() === upper)
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Resolve a partial match to find the full course
     */
    resolveCourse(idOrCode) {
      if (!idOrCode) return null;
      const upper = idOrCode.toUpperCase();

      // Direct match
      if (this.courses.has(idOrCode)) return this.courses.get(idOrCode);
      if (this.courses.has(upper)) return this.courses.get(upper);

      // Code match
      for (const [, course] of this.courses) {
        if (
          course.code &&
          (course.code.toUpperCase() === upper ||
            course.code.toUpperCase().includes(upper) ||
            upper.includes(course.code.toUpperCase()))
        ) {
          return course;
        }
      }
      return null;
    }

    /**
     * Get all courses as an array
     */
    toArray() {
      return [...this.courses.values()].map((c) => ({
        id: c.code || c.id,
        name: c.name,
        url: c.url,
      }));
    }
  }

  // ============================================================
  // Event Scraper — extracts events ONLY for enrolled courses
  // ============================================================
  class SpectrumScraper {
    constructor(courseRegistry) {
      /** @type {CourseRegistry} */
      this.registry = courseRegistry;
      this.events = [];
    }

    /**
     * Main scrape orchestrator
     */
    async scrapeAll() {
      this.events = [];

      this.scrapeTimelineBlock();
      this.scrapeUpcomingEvents();
      this.scrapeCalendarEvents();
      this.scrapeActivityDates();
      // NOTE: scrapeAnnouncementDates() is DISABLED — too many false positives

      // Deduplicate by title + date
      const seen = new Set();
      this.events = this.events.filter((evt) => {
        const key = `${evt.title}::${evt.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Filter: only keep events from enrolled courses
      if (this.registry.courses.size > 0) {
        const before = this.events.length;
        this.events = this.events.filter((evt) => {
          // If course is known enrolled → keep
          if (this.registry.isEnrolled(evt.courseId)) return true;

          // If courseId is 'Unknown' but we detected courses → drop
          // (we don't want mystery events from unknown sources)
          if (evt.courseId === 'Unknown') return false;

          // If courseId is a Moodle numeric ID we haven't seen → drop
          if (/^\d+$/.test(evt.courseId)) return false;

          // If courseId is a code but not enrolled → drop
          return false;
        });
        console.log(
          `[SpectrumX] Course filter: ${before} → ${this.events.length} events (removed ${before - this.events.length} from non-enrolled courses)`
        );
      }

      // Filter: drop events with invalid dates
      const beforeDate = this.events.length;
      this.events = this.events.filter((evt) => evt.date !== null);
      console.log(
        `[SpectrumX] Date filter: ${beforeDate} → ${this.events.length} events (removed ${beforeDate - this.events.length} with invalid dates)`
      );

      return {
        events: this.events,
        courses: this.registry.toArray(),
      };
    }

    // ----------------------------------------------------------
    // Scraping Methods
    // ----------------------------------------------------------

    /**
     * Timeline block — Moodle's built-in deadline overview
     */
    scrapeTimelineBlock() {
      const items = document.querySelectorAll(
        '[data-region="timeline"] [data-region="event-list-content"] [data-region="event-list-item"], ' +
        '[data-region="timeline"] .timeline-event-list-item'
      );

      items.forEach((item) => {
        const titleEl = item.querySelector('a, .event-name');
        const dateEl = item.querySelector(
          '[data-region="event-item-date"], .date, time, [data-region="date"]'
        );
        const courseEl = item.querySelector(
          '.event-name-container small, .text-muted, [data-region="course-name"]'
        );

        if (!titleEl) return;

        const courseId = this._resolveCourseFromElement(item, courseEl);
        if (!courseId) return; // Skip if we can't determine the course

        const date = this._parseDate(dateEl || item);
        if (!date) return; // Skip if date is unparseable

        this.events.push({
          id: `tl-${this._uid()}`,
          title: titleEl.textContent.trim(),
          courseId: courseId,
          type: this._inferType(titleEl.textContent),
          date: date,
          sourceUrl: titleEl.href || window.location.href,
          sourceText: `Timeline > ${titleEl.textContent.trim()}`,
        });
      });

      console.log(`[SpectrumX] Timeline: found ${this.events.length} events`);
    }

    /**
     * Upcoming Events block (calendar sidebar)
     */
    scrapeUpcomingEvents() {
      const items = document.querySelectorAll(
        '.block_calendar_upcoming .event, [data-region="upcoming-events"] [data-event-id], ' +
        '.block_calendar_upcoming .calendar-event-card'
      );

      const countBefore = this.events.length;

      items.forEach((item) => {
        const titleEl = item.querySelector(
          '.referer a, .event-name a, a[data-action="view-event"], a[href*="mod/"]'
        );
        const dateEl = item.querySelector('.date, .col-11, time');

        if (!titleEl) return;

        const courseId = this._resolveCourseFromElement(item, null);
        if (!courseId) return;

        const date = this._parseDate(dateEl || item);
        if (!date) return;

        this.events.push({
          id: `ue-${this._uid()}`,
          title: titleEl.textContent.trim(),
          courseId: courseId,
          type: this._inferType(titleEl.textContent),
          date: date,
          sourceUrl: titleEl.href || window.location.href,
          sourceText: `Upcoming > ${titleEl.textContent.trim()}`,
        });
      });

      console.log(
        `[SpectrumX] Upcoming Events: found ${this.events.length - countBefore} events`
      );
    }

    /**
     * Calendar events
     */
    scrapeCalendarEvents() {
      const items = document.querySelectorAll(
        '.calendar_event_course, .calendar_event_category, [data-type="event"], ' +
        '.calendartable .event'
      );

      const countBefore = this.events.length;

      items.forEach((item) => {
        const titleEl = item.querySelector('.eventname a, a[href*="mod/"], a[href*="calendar"]');
        const dateEl = item.querySelector('.date, time, [data-region="time"]');

        if (!titleEl) return;

        const courseId = this._resolveCourseFromElement(item, null);
        if (!courseId) return;

        const date = this._parseDate(dateEl || item);
        if (!date) return;

        this.events.push({
          id: `cal-${this._uid()}`,
          title: titleEl.textContent.trim(),
          courseId: courseId,
          type: this._inferType(titleEl.textContent),
          date: date,
          sourceUrl: titleEl.href || window.location.href,
          sourceText: `Calendar > ${titleEl.textContent.trim()}`,
        });
      });

      console.log(
        `[SpectrumX] Calendar: found ${this.events.length - countBefore} events`
      );
    }

    /**
     * Activity dates on course pages (Due: ..., Closes: ...)
     */
    scrapeActivityDates() {
      const items = document.querySelectorAll(
        '[data-region="activity-dates"] [data-region="activity-date-item"], ' +
        '.activity-dates .description-inner, .activity-dates li'
      );

      const countBefore = this.events.length;

      items.forEach((item) => {
        const text = item.textContent.trim();
        const dueMatch = text.match(/(?:Due|Closes|Deadline):\s*(.+)/i);

        if (!dueMatch) return;

        const date = this._parseDateText(dueMatch[1]);
        if (!date) return;

        // On a course page, we know the course from URL
        const courseId = this._resolveFromUrl();
        if (!courseId) return;

        const pageTitle =
          document.querySelector('#page-header h1, .page-header-headings h1, h1')
            ?.textContent?.trim() || 'Activity';

        this.events.push({
          id: `ad-${this._uid()}`,
          title: pageTitle,
          courseId: courseId,
          type: this._inferType(pageTitle),
          date: date,
          sourceUrl: window.location.href,
          sourceText: `Course Page > ${pageTitle}`,
        });
      });

      console.log(
        `[SpectrumX] Activity dates: found ${this.events.length - countBefore} events`
      );
    }

    // ----------------------------------------------------------
    // Course Resolution — the critical logic
    // ----------------------------------------------------------

    /**
     * Resolve which course an element belongs to. Tries multiple strategies:
     * 1. URL params of links within the element
     * 2. Explicit course name element
     * 3. Breadcrumb (only on course pages)
     * 4. DOM text walk (last resort, must match enrolled course)
     */
    _resolveCourseFromElement(element, explicitCourseEl) {
      // Strategy 1: Check for links with course IDs in the URL
      const links = element.querySelectorAll('a[href*="course"]');
      for (const link of links) {
        const urlMatch = link.href.match(/course\/view\.php\?id=(\d+)/);
        if (urlMatch) {
          const moodleId = urlMatch[1];
          const course = this.registry.courses.get(moodleId);
          if (course) return course.code || course.id;
        }
      }

      // Strategy 2: Explicit course name element
      if (explicitCourseEl) {
        const code = this._extractCodeFromText(explicitCourseEl.textContent);
        if (code && this.registry.isEnrolled(code)) return code;
      }

      // Strategy 3: Breadcrumb (reliable on individual course pages)
      const breadcrumb = this._resolveFromBreadcrumb();
      if (breadcrumb) return breadcrumb;

      // Strategy 4: URL param
      const fromUrl = this._resolveFromUrl();
      if (fromUrl) return fromUrl;

      // Strategy 5: Controlled DOM text walk — only match against enrolled courses
      const courseMatch = this._matchEnrolledCourse(element.textContent);
      if (courseMatch) return courseMatch;

      return null; // Unknown → will be filtered out
    }

    /**
     * Get course from current page URL
     */
    _resolveFromUrl() {
      const urlMatch = window.location.href.match(/course\/view\.php\?id=(\d+)/);
      if (urlMatch) {
        const course = this.registry.courses.get(urlMatch[1]);
        if (course) return course.code || course.id;
      }
      return null;
    }

    /**
     * Get course from breadcrumb
     */
    _resolveFromBreadcrumb() {
      const crumbs = document.querySelectorAll('.breadcrumb-item a, .breadcrumb a');
      for (const crumb of crumbs) {
        const code = this._extractCodeFromText(crumb.textContent);
        if (code && this.registry.isEnrolled(code)) return code;
      }
      return null;
    }

    /**
     * Match text against known enrolled course codes/names
     */
    _matchEnrolledCourse(text) {
      if (!text) return null;
      for (const [, course] of this.registry.courses) {
        // Check code
        if (course.code && text.toUpperCase().includes(course.code.toUpperCase())) {
          return course.code;
        }
        // Check Moodle ID
        if (text.includes(course.id)) {
          return course.code || course.id;
        }
      }
      return null;
    }

    // ----------------------------------------------------------
    // Date Parsing — returns null instead of faking dates
    // ----------------------------------------------------------

    _parseDate(element) {
      if (!element) return null;

      // Try <time> element with datetime attribute
      const timeEl =
        element.tagName === 'TIME'
          ? element
          : element.querySelector('time');
      if (timeEl) {
        const dt =
          timeEl.dateTime ||
          timeEl.getAttribute('datetime');
        if (dt) {
          const parsed = new Date(dt);
          if (!isNaN(parsed.getTime())) return parsed.toISOString();
        }
      }

      // Try data-timestamp (Moodle uses Unix timestamps in seconds)
      const ts =
        element.getAttribute('data-timestamp') ||
        element.querySelector('[data-timestamp]')?.getAttribute('data-timestamp');
      if (ts) {
        const parsed = new Date(parseInt(ts) * 1000);
        if (!isNaN(parsed.getTime())) return parsed.toISOString();
      }

      // Try parsing text content
      const text = element.textContent.trim();
      return this._parseDateText(text);
    }

    /**
     * Parse a date string — returns null if unparseable
     */
    _parseDateText(text) {
      if (!text || text.length < 4) return null;

      // Clean up common Moodle date formats
      let cleaned = text
        .replace(/(\d+)(?:st|nd|rd|th)/g, '$1') // "1st" → "1"
        .replace(/\s+/g, ' ')
        .trim();

      // Try direct parsing
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2020) {
        return parsed.toISOString();
      }

      // Try common Moodle format: "Friday, 16 May 2026, 11:59 PM"
      const longMatch = cleaned.match(
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)?/i
      );
      if (longMatch) {
        const dateStr = `${longMatch[1]} ${longMatch[2]} ${longMatch[3]} ${longMatch[4]}:${longMatch[5]}${longMatch[6] ? ' ' + longMatch[6] : ''}`;
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // Try short format: "16 May 2026"
      const shortMatch = cleaned.match(
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i
      );
      if (shortMatch) {
        const d = new Date(`${shortMatch[1]} ${shortMatch[2]} ${shortMatch[3]}`);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      return null; // IMPORTANT: return null, not a fake date
    }

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------

    _extractCodeFromText(text) {
      if (!text) return null;
      const match = text.match(/\b([A-Z]{2,4}\d{4}[A-Z]?)\b/);
      return match ? match[1] : null;
    }

    _inferType(text) {
      const lower = (text || '').toLowerCase();
      if (/\bfinal\s*exam|mid[\s-]*sem.*exam/.test(lower)) return 'exam';
      if (/\bquiz\b/.test(lower)) return 'quiz';
      if (/\bexam\b/.test(lower)) return 'exam';
      if (/\blab\b/.test(lower)) return 'lab';
      if (/\bviva\b/.test(lower)) return 'viva';
      if (/\bpresent/.test(lower)) return 'presentation';
      if (/\bproject\b/.test(lower)) return 'project';
      if (/\bassign|\bsubmission|\bsubmit|\breport\b/.test(lower)) return 'assignment';
      if (/\btutorial\b|\btut\b/.test(lower)) return 'tutorial';
      return 'other';
    }

    _uid() {
      return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    }
  }

  // ============================================================
  // Deep Scanner — autonomously fetches ALL course pages
  // ============================================================
  class DeepScanner {
    constructor(courseRegistry) {
      this.registry = courseRegistry;
      this.events = [];
      this.scanned = 0;
      this.total = 0;
    }

    async deepScan() {
      const courses = this.registry.toArray();
      this.total = courses.length;
      this.scanned = 0;
      this.events = [];

      if (courses.length === 0) {
        console.warn('[SpectrumX] DeepScan: No courses detected yet');
        return { events: [], courses: [] };
      }

      console.log(`[SpectrumX] DeepScan: Starting scan of ${courses.length} courses`);
      this._sendProgress(`Scanning 0/${this.total} courses...`);

      for (const course of courses) {
        this.scanned++;
        this._sendProgress(`Scanning ${course.code || course.id} (${this.scanned}/${this.total})...`);

        try {
          const html = await this._fetchPage(course.url);
          if (!html) {
            console.warn(`[SpectrumX] DeepScan: Failed to fetch ${course.name}`);
            continue;
          }

          // Check for session expiry (login redirect)
          const quickCheck = html.substring(0, 2000);
          if (/id="login"|class="login-form"|name="login"/i.test(quickCheck)) {
            console.warn('[SpectrumX] DeepScan: Session expired — login page detected');
            this._sendProgress('Session expired! Please log in to Spectrum again.');
            break;
          }

          const doc = new DOMParser().parseFromString(html, 'text/html');
          const pageEvents = this._scanCoursePage(doc, course);
          this.events.push(...pageEvents);

          // Fetch sub-pages for deeper data (assignments, quizzes)
          const subLinks = this._findActivityLinks(doc, course);
          for (const subLink of subLinks) {
            await this._delay(300);
            const subHtml = await this._fetchPage(subLink.url);
            if (subHtml) {
              const subDoc = new DOMParser().parseFromString(subHtml, 'text/html');
              const subEvents = this._scanActivityPage(subDoc, course, subLink);
              this.events.push(...subEvents);
            }
          }
        } catch (err) {
          console.warn(`[SpectrumX] DeepScan error on ${course.name}:`, err.message);
        }

        await this._delay(400); // Rate limit between courses
      }

      // Deduplicate
      const seen = new Set();
      this.events = this.events.filter(evt => {
        const key = `${evt.title}::${evt.date}::${evt.courseId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Filter invalid dates
      this.events = this.events.filter(evt => evt.date !== null);

      console.log(`[SpectrumX] DeepScan complete: ${this.events.length} events from ${courses.length} courses`);
      this._sendProgress(`Done! Found ${this.events.length} events ✅`);

      return { events: this.events, courses: this.registry.toArray() };
    }

    async _fetchPage(url) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) return null;
        return await resp.text();
      } catch (e) {
        console.warn('[SpectrumX] Fetch failed:', url, e.message);
        return null;
      }
    }

    _delay(ms) {
      return new Promise(r => setTimeout(r, ms));
    }

    _sendProgress(message) {
      try {
        chrome.runtime.sendMessage({
          type: 'DEEP_SCAN_PROGRESS',
          payload: { current: this.scanned, total: this.total, message }
        });
      } catch (e) { /* popup may not be open */ }
    }

    // ----------------------------------------------------------
    // Course page scanner
    // ----------------------------------------------------------
    _scanCoursePage(doc, course) {
      const events = [];
      const cid = course.code || course.id;

      // Strategy 1: Moodle 4.x inline activity dates
      const activities = doc.querySelectorAll('.activity');
      activities.forEach(act => {
        const nameEl = act.querySelector('.activity-instance a, .instancename, a.aalink, a[href*="mod/"]');
        if (!nameEl) return;

        const name = this._cleanActivityName(nameEl.textContent);
        const href = nameEl.href || nameEl.getAttribute('href') || '';
        if (name.length < 3) return;

        // Moodle 4.x: explicit date elements
        const dateEls = act.querySelectorAll('.activity-dates .date-text, [data-region="activity-date"]');
        if (dateEls.length > 0) {
          dateEls.forEach(dateEl => {
            const date = this._parseDateFromLabel(dateEl.textContent);
            if (date) {
              events.push(this._makeEvent(name, cid, date, href));
            }
          });
        } else {
          // Fallback: scan activity text for date patterns
          const date = this._parseDateFromText(act.textContent);
          if (date) {
            events.push(this._makeEvent(name, cid, date, href));
          }
        }
      });

      // Strategy 2: Upcoming events block
      const upcomingItems = doc.querySelectorAll(
        '.block_calendar_upcoming .event, [data-region="upcoming-event"]'
      );
      upcomingItems.forEach(item => {
        const nameEl = item.querySelector('.referer a, .event-name a, a[href*="mod/"]');
        if (!nameEl) return;
        const date = this._parseDateFromText(item.textContent);
        if (!date) return;
        events.push(this._makeEvent(nameEl.textContent.trim(), cid, date, nameEl.href || course.url));
      });

      // Strategy 3: Submission/grade tables
      const tables = doc.querySelectorAll('table.generaltable');
      tables.forEach(table => {
        const rows = table.querySelectorAll('tr');
        rows.forEach(row => {
          const date = this._parseDateFromText(row.textContent);
          if (!date) return;
          const nameEl = row.querySelector('a');
          if (!nameEl) return;
          const name = nameEl.textContent.trim();
          if (name.length < 3) return;
          events.push(this._makeEvent(name, cid, date, nameEl.href || course.url));
        });
      });

      console.log(`[SpectrumX] DeepScan ${cid}: ${events.length} events from course page`);
      return events;
    }

    // ----------------------------------------------------------
    // Find sub-page links (assignments, quizzes)
    // ----------------------------------------------------------
    _findActivityLinks(doc, course) {
      const links = [];
      const seen = new Set();

      const selectors = 'a[href*="mod/assign/view"], a[href*="mod/quiz/view"]';
      doc.querySelectorAll(selectors).forEach(link => {
        const href = link.href;
        if (!href || seen.has(href)) return;
        seen.add(href);
        links.push({
          url: href,
          name: link.textContent.trim(),
          type: /quiz/i.test(href) ? 'quiz' : 'assignment'
        });
      });

      return links.slice(0, 5); // Max 5 sub-pages per course
    }

    // ----------------------------------------------------------
    // Scan activity page (assignment/quiz) for dates
    // ----------------------------------------------------------
    _scanActivityPage(doc, course, linkInfo) {
      const events = [];
      const cid = course.code || course.id;
      const pageTitle = doc.querySelector('#page-header h1, h1')?.textContent?.trim() || linkInfo.name;

      const body = doc.body?.textContent || '';

      // Pattern: "Due date: Friday, 16 May 2026, 11:59 PM"
      const patterns = [
        { regex: /Due date[^:]*:\s*(.+?)(?:\n|$)/i, label: 'Due' },
        { regex: /Closing date[^:]*:\s*(.+?)(?:\n|$)/i, label: 'Closes' },
        { regex: /Cut-?off date[^:]*:\s*(.+?)(?:\n|$)/i, label: 'Cut-off' },
        { regex: /Deadline[^:]*:\s*(.+?)(?:\n|$)/i, label: 'Deadline' },
      ];

      patterns.forEach(({ regex, label }) => {
        const match = body.match(regex);
        if (match) {
          const date = this._parseDateFromText(match[1].trim());
          if (date) {
            events.push(this._makeEvent(`${pageTitle} (${label})`, cid, date, linkInfo.url));
          }
        }
      });

      // Also check <time> elements for deadline context
      doc.querySelectorAll('time[datetime]').forEach(timeEl => {
        const dt = timeEl.getAttribute('datetime');
        if (!dt) return;
        const parsed = new Date(dt);
        if (isNaN(parsed.getTime()) || parsed.getFullYear() <= 2020) return;
        if (parsed <= new Date()) return;

        const parent = timeEl.closest('tr, .fitem, .form-group, .generaltable');
        const context = parent ? parent.textContent : '';
        if (/due|deadline|close|cutoff|end/i.test(context)) {
          events.push(this._makeEvent(pageTitle, cid, parsed.toISOString(), linkInfo.url));
        }
      });

      if (events.length > 0) {
        console.log(`[SpectrumX] DeepScan ${cid}: ${events.length} events from ${linkInfo.name}`);
      }
      return events;
    }

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------
    _makeEvent(title, courseId, date, sourceUrl) {
      return {
        id: `ds-${Date.now().toString(36)}${Math.random().toString(36).substr(2, 6)}`,
        title: title,
        courseId: courseId,
        type: this._inferType(title),
        date: date,
        sourceUrl: sourceUrl,
        sourceText: `${courseId} > ${title}`,
      };
    }

    _cleanActivityName(text) {
      return text.replace(/\s+/g, ' ').replace(/Accessibility.*$/i, '').trim();
    }

    _parseDateFromLabel(text) {
      const cleaned = text.replace(/^(Due|Closes?|Deadline|Cut-?off|Open)\s*:?\s*/i, '').trim();
      return this._parseDateFromText(cleaned);
    }

    _parseDateFromText(text) {
      if (!text || text.length < 4) return null;

      let cleaned = text
        .replace(/(\d+)(st|nd|rd|th)/gi, '$1')
        .replace(/\s+/g, ' ')
        .trim();

      // Long Moodle format: "Friday, 16 May 2026, 11:59 PM"
      const longMatch = cleaned.match(
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)/i
      );
      if (longMatch) {
        const d = new Date(`${longMatch[1]} ${longMatch[2]} ${longMatch[3]} ${longMatch[4]}:${longMatch[5]} ${longMatch[6]}`);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // Short date + time: "16 May 2026, 11:59 PM"
      const shortDt = cleaned.match(
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})[,\s]+(\d{1,2}):(\d{2})/
      );
      if (shortDt) {
        const ampm = cleaned.match(/(AM|PM)/i);
        const suffix = ampm ? ' ' + ampm[1] : '';
        const d = new Date(`${shortDt[1]} ${shortDt[2]} ${shortDt[3]} ${shortDt[4]}:${shortDt[5]}${suffix}`);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // Short date only: "16 May 2026"
      const shortD = cleaned.match(
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i
      );
      if (shortD) {
        const d = new Date(`${shortD[1]} ${shortD[2]} ${shortD[3]}`);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // ISO format
      const isoMatch = cleaned.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?)/);
      if (isoMatch) {
        const d = new Date(isoMatch[1]);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // Direct parse last resort
      try {
        const d = new Date(cleaned.substring(0, 50));
        if (!isNaN(d.getTime()) && d.getFullYear() > 2020 && d.getFullYear() < 2030) {
          return d.toISOString();
        }
      } catch (e) {}

      return null;
    }

    _inferType(text) {
      const lower = (text || '').toLowerCase();
      if (/\bfinal\s*exam|mid[\s-]*sem.*exam/.test(lower)) return 'exam';
      if (/\bquiz\b/.test(lower)) return 'quiz';
      if (/\bexam\b/.test(lower)) return 'exam';
      if (/\blab\b/.test(lower)) return 'lab';
      if (/\bviva\b/.test(lower)) return 'viva';
      if (/\bpresent/.test(lower)) return 'presentation';
      if (/\bproject\b/.test(lower)) return 'project';
      if (/\bassign|\bsubmission|\bsubmit|\breport\b/.test(lower)) return 'assignment';
      if (/\btutorial\b|\btut\b/.test(lower)) return 'tutorial';
      return 'other';
    }
  }

  // ============================================================
  // Deep Scan orchestrator — merges surface + deep results
  // ============================================================
  async function deepScanAndSend() {
    // Re-detect courses first
    registry.detect();

    const scanner = new DeepScanner(registry);
    const deepData = await scanner.deepScan();

    // Also do a surface scrape (timeline, upcoming events on current page)
    const surfaceScraper = new SpectrumScraper(registry);
    const surfaceData = await surfaceScraper.scrapeAll();

    // Combine and deduplicate
    const allEvents = [...deepData.events, ...surfaceData.events];
    const seen = new Set();
    const deduped = allEvents.filter(evt => {
      const key = `${evt.title}::${evt.date}::${evt.courseId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).filter(e => e.date !== null);

    const result = {
      events: deduped,
      courses: deepData.courses
    };

    console.log(`[SpectrumX] Deep scan total: ${result.events.length} events (${deepData.events.length} deep + ${surfaceData.events.length} surface)`);

    // Send to background for storage
    chrome.runtime.sendMessage({
      type: 'EVENTS_SCRAPED',
      payload: result
    });

    // Update FAB badge
    const urgentCount = result.events.filter(e => {
      const diff = new Date(e.date) - new Date();
      return diff > 0 && diff <= 48 * 60 * 60 * 1000;
    }).length;

    const badge = document.getElementById('spectrumx-badge');
    if (badge && urgentCount > 0) {
      badge.textContent = urgentCount;
      badge.style.display = 'flex';
    }

    return result;
  }

  // ============================================================
  // Message Listener — handles requests from popup/background
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DEEP_SCAN_REQUEST') {
      console.log('[SpectrumX] Deep scan request received');
      deepScanAndSend()
        .then(result => sendResponse({ success: true, eventCount: result.events.length }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Keep channel open for async response
    }
  });

  // ============================================================
  // Floating Action Button
  // ============================================================
  function injectFAB() {
    if (document.getElementById('spectrumx-fab')) return;

    const fab = document.createElement('div');
    fab.id = 'spectrumx-fab';
    fab.innerHTML = `
      <div class="spectrumx-fab-container">
        <button class="spectrumx-fab-btn" id="spectrumx-main-btn" title="SpectrumX">
          <span class="spectrumx-fab-icon">⚡</span>
          <span class="spectrumx-fab-badge" id="spectrumx-badge" style="display:none;">0</span>
        </button>
        <div class="spectrumx-fab-menu" id="spectrumx-menu" style="display:none;">
          <button class="spectrumx-fab-menu-item" data-action="dashboard">📋 Dashboard</button>
          <button class="spectrumx-fab-menu-item" data-action="chatbot">🤖 Ask SpectrumX</button>
          <button class="spectrumx-fab-menu-item" data-action="deepscan">🔍 Deep Scan All Courses</button>
          <button class="spectrumx-fab-menu-item" data-action="refresh">🔄 Refresh Data</button>
        </div>
      </div>
    `;
    document.body.appendChild(fab);

    const mainBtn = document.getElementById('spectrumx-main-btn');
    const menu = document.getElementById('spectrumx-menu');

    mainBtn.addEventListener('click', () => {
      const isOpen = menu.style.display !== 'none';
      menu.style.display = isOpen ? 'none' : 'flex';
      mainBtn.classList.toggle('active', !isOpen);
    });

    menu.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      menu.style.display = 'none';
      mainBtn.classList.remove('active');

      switch (action) {
        case 'dashboard':
          // Open the popup by opening sidepanel (popup can't be opened programmatically)
          try {
            await chrome.runtime.sendMessage({ type: 'OPEN_CHATBOT' });
          } catch(e) {
            showToast('Click the ⚡ extension icon for dashboard');
          }
          break;
        case 'chatbot':
          try {
            await chrome.runtime.sendMessage({ type: 'OPEN_CHATBOT' });
          } catch(e) {
            showToast('Click ⚡ icon → Chat button');
          }
          break;
        case 'deepscan':
          showToast('🔍 Deep scanning all courses...');
          try {
            const result = await deepScanAndSend();
            showToast(`Deep scan complete! Found ${result.events.length} events ✅`);
          } catch(err) {
            showToast('Deep scan failed: ' + err.message);
          }
          break;
        case 'refresh':
          await scrapeAndSend();
          showToast('Data refreshed! ✅');
          break;
      }
    });

    document.addEventListener('click', (e) => {
      if (!fab.contains(e.target)) {
        menu.style.display = 'none';
        mainBtn.classList.remove('active');
      }
    });
  }

  // ============================================================
  // Toast
  // ============================================================
  function showToast(message) {
    const existing = document.getElementById('spectrumx-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'spectrumx-toast';
    toast.textContent = message;
    toast.className = 'spectrumx-toast';
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ============================================================
  // Main: detect courses → scrape → send to background
  // ============================================================
  const registry = new CourseRegistry();

  async function scrapeAndSend() {
    // Always re-detect courses first (navigation may have changed)
    registry.detect();

    const scraper = new SpectrumScraper(registry);
    const data = await scraper.scrapeAll();

    console.log(
      `[SpectrumX] Scraped ${data.events.length} events from ${data.courses.length} enrolled courses`
    );

    if (data.events.length > 0) {
      chrome.runtime.sendMessage({
        type: 'EVENTS_SCRAPED',
        payload: data,
      });

      // Update FAB badge with urgent count
      const urgentCount = data.events.filter((e) => {
        const diff = new Date(e.date) - new Date();
        return diff > 0 && diff <= 48 * 60 * 60 * 1000;
      }).length;

      const badge = document.getElementById('spectrumx-badge');
      if (badge && urgentCount > 0) {
        badge.textContent = urgentCount;
        badge.style.display = 'flex';
      }
    }

    return data;
  }

  // ============================================================
  // Initialize
  // ============================================================
  function init() {
    injectFAB();

    // Scrape after delay for Moodle JS to finish rendering
    setTimeout(async () => {
      const data = await scrapeAndSend();
      console.log(`[SpectrumX] Initial scrape: ${data.events.length} events, ${data.courses.length} courses`);
    }, 2500);

    // Re-scrape on SPA navigation (debounced)
    let debounceTimer = null;
    const observer = new MutationObserver((mutations) => {
      const significant = mutations.some(
        (m) =>
          m.addedNodes.length > 0 &&
          Array.from(m.addedNodes).some(
            (n) =>
              n.nodeType === 1 &&
              (n.classList?.contains('course-content') ||
                n.classList?.contains('block_timeline') ||
                n.getAttribute?.('data-region') === 'timeline' ||
                n.getAttribute?.('data-region') === 'event-list-content')
          )
      );

      if (significant) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scrapeAndSend, 1500);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();