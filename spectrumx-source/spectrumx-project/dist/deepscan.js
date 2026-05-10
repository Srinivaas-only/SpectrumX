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

  /**
   * Context-aware scan: scan ONE specific course deeply.
   * Used when the user is currently on a course page.
   * Scans the course page + each assignment sub-page + announcements forum.
   */
  async scanCurrentCourse(courseUrl, onProgress) {
    this.events = [];
    this.courses = [];
    this.scannedUrls = [];
    this.errors = [];

    // Extract course ID from URL
    const idMatch = courseUrl.match(/id=(\d+)/);
    const moodleId = idMatch ? idMatch[1] : 'unknown';

    onProgress?.({ phase: 'course', message: 'Scanning course page...' });
    const courseData = await this.fetchAndParse(courseUrl, 'course');
    if (!courseData) {
      try { await chrome.offscreen.closeDocument(); } catch (e) {}
      return {
        events: [],
        courses: [],
        scannedUrls: this.scannedUrls,
        errors: this.errors
      };
    }

    this.events.push(...(courseData.events || []));

    // Determine course code from the events we found, or fallback
    const courseCode = courseData.events?.[0]?.courseId || `Course-${moodleId}`;
    this.courses = [{ id: courseCode, moodleId: moodleId, url: courseUrl }];

    // Scan each assignment sub-page (limit to 10 to avoid hammering)
    const assignmentUrls = (courseData.assignmentUrls || []).slice(0, 10);
    for (let i = 0; i < assignmentUrls.length; i++) {
      onProgress?.({
        phase: 'assignments',
        message: `Scanning assignments (${i + 1}/${assignmentUrls.length})...`
      });
      const assignData = await this.fetchAndParse(assignmentUrls[i], 'assignment', courseCode);
      if (assignData) this.events.push(...(assignData.events || []));
      await this.delay(200);
    }

    // Scan announcements forum (max 1)
    const forumUrls = (courseData.forumUrls || []).slice(0, 1);
    for (let i = 0; i < forumUrls.length; i++) {
      onProgress?.({ phase: 'announcements', message: 'Scanning announcements...' });
      const forumData = await this.fetchAndParse(forumUrls[i], 'forum', courseCode);
      if (forumData) this.events.push(...(forumData.events || []));
      await this.delay(200);
    }

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

  /**
   * Smart PDF Scan: extract deadlines from PDFs on the current course page.
   * Uses PDF.js for text extraction, then Z.AI GLM-5.1 for understanding.
   */
  async smartScanCurrentCourse(courseUrl, apiKey, onProgress) {
    this.events = [];
    this.scannedUrls = [];
    this.errors = [];

    if (!apiKey) {
      return {
        events: [],
        scannedUrls: [],
        errors: [{ message: 'Z.AI API key required for Smart Scan' }]
      };
    }

    // Step 1: Get the course page to find PDF URLs
    onProgress?.({ phase: 'discover', message: 'Finding PDFs on course page...' });
    const courseData = await this.fetchAndParse(courseUrl, 'course');
    if (!courseData) {
      try { await chrome.offscreen.closeDocument(); } catch (e) {}
      return { events: [], scannedUrls: this.scannedUrls, errors: this.errors };
    }

    const pdfUrls = (courseData.pdfUrls || []).slice(0, 8);
    const courseCode = courseData.events?.[0]?.courseId ||
      this.extractCourseFromUrl(courseUrl) || 'Unknown';

    if (pdfUrls.length === 0) {
      try { await chrome.offscreen.closeDocument(); } catch (e) {}
      return {
        events: [],
        scannedUrls: this.scannedUrls,
        errors: [{ message: 'No PDFs found on this course page' }]
      };
    }

    // Step 2: For each PDF, extract text and send to Z.AI
    for (let i = 0; i < pdfUrls.length; i++) {
      const pdf = pdfUrls[i];
      onProgress?.({
        phase: 'pdf',
        message: `Reading PDF ${i + 1}/${pdfUrls.length}: ${pdf.title.substring(0, 30)}...`
      });

      const extractResult = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'EXTRACT_PDF_TEXT',
        payload: { url: pdf.url }
      });

      if (!extractResult || !extractResult.success) {
        this.errors.push({
          url: pdf.url,
          message: `Failed to read PDF: ${extractResult?.error || 'unknown'}`
        });
        continue;
      }

      if (!extractResult.text || extractResult.text.length < 100) {
        continue;
      }

      onProgress?.({
        phase: 'ai',
        message: `AI reading: ${pdf.title.substring(0, 30)}...`
      });

      const aiEvents = await this.askGlmForDeadlines(
        apiKey, pdf.title, extractResult.text, pdf.url, courseCode
      );

      if (aiEvents.length > 0) {
        this.events.push(...aiEvents);
      }

      await this.delay(300);
    }

    try { await chrome.offscreen.closeDocument(); } catch (e) {}

    this.cleanInvalidEvents();
    this.deduplicateEvents();

    return {
      events: this.events,
      scannedUrls: this.scannedUrls,
      errors: this.errors,
      pdfsScanned: pdfUrls.length
    };
  }

  /**
   * Send PDF text to Z.AI GLM-5.1 with a structured prompt to extract deadlines.
   */
  async askGlmForDeadlines(apiKey, pdfTitle, pdfText, sourceUrl, courseCode) {
    const maxChars = 12000;
    const text = pdfText.length > maxChars
      ? pdfText.substring(0, maxChars) + '\n[... truncated ...]'
      : pdfText;

    const systemPrompt = `You are a deadline extraction assistant for university students.
You read PDFs (assignment briefs, project specs, course outlines) and extract submission deadlines.

You return STRICT JSON in this exact format, with no other text:
{
  "events": [
    {
      "title": "short descriptive title (e.g. 'Group Project Final Report')",
      "date": "ISO 8601 datetime like 2026-05-28T23:59:00",
      "type": "assignment|quiz|exam|project|presentation|lab|viva|other",
      "confidence": "high|medium|low",
      "description": "brief 1-sentence description"
    }
  ]
}

If no deadlines are found, return: {"events": []}

Rules:
- Only include events with explicit dates. Don't guess dates from "Week 7" without context.
- Confidence "high" = explicit date with clear deadline language. "medium" = inferred or ambiguous. "low" = uncertain.
- Default time to 23:59:00 if no time specified.
- Today's date for context: ${new Date().toISOString().substring(0, 10)}
- Year: assume current academic year if year is missing.
- If PDF is in Bahasa Malaysia, still extract the deadlines (e.g. "Tarikh akhir = deadline").
- Don't extract lecture dates or meeting dates. ONLY assignment/submission/exam deadlines.
- Maximum 5 events per PDF.`;

    const userPrompt = `PDF Title: ${pdfTitle}
Course: ${courseCode}

PDF Content:
${text}

Extract any submission deadlines, project due dates, exam dates, or assignment deadlines from this PDF. Return JSON only.`;

    try {
      const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'glm-5.1',
          max_tokens: 1500,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      if (!response.ok) {
        this.errors.push({ url: sourceUrl, message: `Z.AI error: HTTP ${response.status}` });
        return [];
      }

      const data = await response.json();
      const aiResponse = data.choices?.[0]?.message?.content || '';

      const cleanJson = aiResponse
        .replace(/```json\s*/gi, '')
        .replace(/```\s*$/g, '')
        .trim();

      let parsed;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (e) {
        this.errors.push({ url: sourceUrl, message: 'AI returned invalid JSON' });
        return [];
      }

      const events = (parsed.events || []).map(evt => ({
        id: `pdf-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        title: evt.title || 'Deadline',
        courseId: courseCode,
        type: evt.type || 'assignment',
        date: evt.date,
        sourceUrl: sourceUrl,
        sourceText: `Spectrum > ${courseCode} > ${pdfTitle}`,
        description: `${evt.description || ''} [AI confidence: ${evt.confidence || 'medium'}]`,
        aiExtracted: true,
        confidence: evt.confidence || 'medium'
      })).filter(e => e.date && e.title);

      return events;
    } catch (err) {
      this.errors.push({ url: sourceUrl, message: `AI request failed: ${err.message}` });
      return [];
    }
  }

  extractCourseFromUrl(url) {
    const idMatch = url.match(/id=(\d+)/);
    return idMatch ? `Course-${idMatch[1]}` : null;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.DeepScanner = DeepScanner;
}
