/**
 * SpectrumX DeepScan Engine (Offscreen-powered)
 * 
 * Crawls multiple Spectrum/Moodle pages to find ALL deadlines.
 * Uses an offscreen document for HTML parsing (DOMParser is unavailable in MV3 service workers).
 */

class DeepScanner {
  constructor() {
    this.events = [];
    this.courses = [];
    this.scannedUrls = [];
    this.errors = [];
  }

  /**
   * Ensure the offscreen document is created (singleton).
   */
  async ensureOffscreen() {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) return;

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse fetched Moodle HTML to extract events and deadlines'
      });
    } catch (err) {
      if (!err.message.includes('Only a single offscreen')) {
        throw err;
      }
    }
  }

  /**
   * Send a parse request to the offscreen document.
   */
  async fetchAndParse(url, extractType, courseCode = null) {
    await this.ensureOffscreen();
    this.scannedUrls.push(url);

    try {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'PARSE_HTML',
        payload: { url, extractType, courseCode }
      });

      if (!response || !response.success) {
        this.errors.push({
          url,
          message: response?.error || 'Unknown error'
        });
        return null;
      }

      return response.data;
    } catch (err) {
      this.errors.push({ url, message: err.message });
      return null;
    }
  }

  /**
   * Run the full deep scan across all known pages.
   */
  async scan(onProgress) {
    this.events = [];
    this.courses = [];
    this.scannedUrls = [];
    this.errors = [];

    // Phase 1: Dashboard — get enrolled courses + timeline events
    onProgress?.({ phase: 'dashboard', message: 'Scanning dashboard...' });
    const dashboardData = await this.fetchAndParse('https://spectrum.um.edu.my/my/', 'dashboard');
    if (dashboardData) {
      this.courses = dashboardData.courses || [];
      this.events.push(...(dashboardData.events || []));
    }

    // Phase 2: Calendar pages
    onProgress?.({ phase: 'calendar', message: 'Scanning calendar...' });
    const upcomingData = await this.fetchAndParse(
      'https://spectrum.um.edu.my/calendar/view.php?view=upcoming',
      'calendar-upcoming'
    );
    if (upcomingData) this.events.push(...(upcomingData.events || []));

    const monthData = await this.fetchAndParse(
      'https://spectrum.um.edu.my/calendar/view.php?view=month',
      'calendar-month'
    );
    if (monthData) this.events.push(...(monthData.events || []));

    // Phase 3: Each enrolled course page
    for (let i = 0; i < this.courses.length; i++) {
      const course = this.courses[i];
      onProgress?.({
        phase: 'courses',
        message: `Scanning ${course.id || 'course'} (${i + 1}/${this.courses.length})...`
      });

      const courseData = await this.fetchAndParse(course.url, 'course', course.id);
      if (courseData) {
        this.events.push(...(courseData.events || []));

        // Scan up to 2 forum/announcement pages per course
        const forumUrls = (courseData.forumUrls || []).slice(0, 2);
        for (const forumUrl of forumUrls) {
          await this.delay(200);
          const forumData = await this.fetchAndParse(forumUrl, 'forum', course.id);
          if (forumData) this.events.push(...(forumData.events || []));
        }
      }

      await this.delay(300); // Rate limit between courses
    }

    // Close offscreen document to save memory
    try {
      if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } catch (e) { /* ignore */ }

    this.deduplicateEvents();
    this.cleanInvalidEvents();

    return {
      events: this.events,
      courses: this.courses,
      scannedUrls: this.scannedUrls,
      errors: this.errors
    };
  }

  cleanInvalidEvents() {
    this.events = this.events.filter(evt => {
      if (!evt.title || evt.title.length < 2) return false;
      if (!evt.date) return false;
      const d = new Date(evt.date);
      if (isNaN(d.getTime())) return false;
      // Add ID if missing
      if (!evt.id) {
        evt.id = `ds-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      }
      evt.scannedAt = new Date().toISOString();
      return true;
    });
  }

  deduplicateEvents() {
    const seen = new Set();
    this.events = this.events.filter(evt => {
      const key = `${evt.title?.toLowerCase()?.replace(/\s+/g, ' ')?.trim()}-${evt.date?.substring(0, 10)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Make available in service worker global scope
if (typeof globalThis !== 'undefined') {
  globalThis.DeepScanner = DeepScanner;
}