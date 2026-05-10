/**
 * SpectrumX DeepScan Engine (Offscreen-powered)
 *
 * Crawls UM Spectrum to find ALL deadlines.
 *
 * Scan plan (validated against real Spectrum HTML):
 *   1. Home page (https://spectrum.um.edu.my/) — get enrolled courses
 *   2. Calendar month view — get all calendar events with dates
 *   3. Each course page — get assignments/quizzes with embedded dates
 */

class DeepScanner {
  constructor() {
    this.events = [];
    this.courses = [];
    this.scannedUrls = [];
    this.errors = [];
  }

  async ensureOffscreen() {
    try {
      const existing = await chrome.offscreen.hasDocument?.();
      if (existing) return;
    } catch (e) { /* hasDocument may not exist in older Chrome */ }

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse fetched Moodle HTML to extract deadlines'
      });
    } catch (err) {
      if (!err.message.includes('Only a single offscreen')) {
        throw err;
      }
    }
  }

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
        this.errors.push({ url, message: response?.error || 'Unknown error' });
        return null;
      }
      return response.data;
    } catch (err) {
      this.errors.push({ url, message: err.message });
      return null;
    }
  }

  async scan(onProgress) {
    this.events = [];
    this.courses = [];
    this.scannedUrls = [];
    this.errors = [];

    // Phase 1: Home page → enrolled courses
    onProgress?.({ phase: 'home', message: 'Finding your courses...' });
    const homeData = await this.fetchAndParse('https://spectrum.um.edu.my/', 'home');
    if (homeData) {
      this.courses = homeData.courses || [];
    }

    // Phase 2: Calendar month view → all calendar events
    onProgress?.({ phase: 'calendar', message: 'Scanning calendar...' });
    const calData = await this.fetchAndParse(
      'https://spectrum.um.edu.my/calendar/view.php?view=month',
      'calendar-month'
    );
    if (calData) this.events.push(...(calData.events || []));

    // Phase 3: Each course page → assignments with embedded dates
    for (let i = 0; i < this.courses.length; i++) {
      const course = this.courses[i];
      onProgress?.({
        phase: 'courses',
        message: `Scanning ${course.id} (${i + 1}/${this.courses.length})...`
      });

      const courseData = await this.fetchAndParse(course.url, 'course', course.id);
      if (courseData) {
        this.events.push(...(courseData.events || []));
      }
      await this.delay(250);
    }

    // Cleanup
    try { await chrome.offscreen.closeDocument(); } catch (e) {}

    this.cleanInvalidEvents();
    this.deduplicateEvents();

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
      if (!evt.id) {
        evt.id = `ds-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      }
      evt.scannedAt = new Date().toISOString();
      return true;
    });
  }

  deduplicateEvents() {
    // Dedup key: course + normalized title + date (day precision)
    const seen = new Map();
    this.events = this.events.filter(evt => {
      const normTitle = evt.title.toLowerCase()
        .replace(/\b(opens|closes|is due|due)\b/gi, '')
        .replace(/\s+/g, ' ').trim();
      const key = `${evt.courseId}-${normTitle}-${evt.date.substring(0, 10)}`;

      // Prefer event with longer/richer info if duplicate
      if (seen.has(key)) {
        const existing = seen.get(key);
        if ((evt.description?.length || 0) > (existing.description?.length || 0)) {
          seen.set(key, evt);
        }
        return false;
      }
      seen.set(key, evt);
      return true;
    });
    // Replace with the chosen versions
    this.events = Array.from(seen.values());
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.DeepScanner = DeepScanner;
}