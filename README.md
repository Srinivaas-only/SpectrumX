# ⚡ SpectrumX — Chrome Extension for UM Spectrum

> A smarter way to track deadlines, exams, and assignments on Universiti Malaya's SPeCTRUM (Moodle v4). Never miss a deadline again.

## 🎯 What This Is

A **Chrome browser extension** that enhances UM's Spectrum LMS with:

1. **Source-linked Smart Dashboard** — Clean upcoming-only view with every date linking back to its exact Spectrum page
2. **AI Chatbot** (powered by Z.AI GLM-5.1) — Ask "what's due this week?" and get instant answers with source links

Built for the **Shortcut Asia Internship Challenge 2026**.

---

## 📁 Project Structure

```
spectrumx/
├── public/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   └── icons/                 # Extension icons (16, 48, 128px)
├── src/
│   ├── shared/
│   │   └── data.js            # Constants, demo data, utilities
│   ├── background/
│   │   └── background.js      # Service worker: storage, alarms, notifications
│   ├── content/
│   │   ├── content.js         # DOM scraper + floating action button
│   │   └── content.css        # FAB + toast styles (injected into Spectrum)
│   ├── popup/
│   │   ├── popup.html         # Smart Dashboard shell
│   │   ├── popup.css          # Dashboard styling (dark theme)
│   │   └── popup.js           # Dashboard logic: filtering, rendering, events
│   └── sidepanel/
│       ├── sidepanel.html     # AI Chatbot shell
│       ├── sidepanel.css      # Chat interface styling
│       └── sidepanel.js       # Chatbot: Z.AI GLM-5.1 API, local fallback
├── dist/                      # Built extension (load this in Chrome)
├── build.sh                   # Build script
└── README.md
```

---

## 🚀 Quick Start

### Install in Chrome (for testing)
1. Run `bash build.sh` (or use the pre-built `dist/` folder)
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the `dist/` folder
5. Click the ⚡ SpectrumX icon → dashboard appears with demo data

### Enable AI Chatbot
1. Open the side panel (click the chat icon in the dashboard header)
2. Enter your Z.AI API key
3. Start asking about your deadlines!

---

## 🛠 Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Extension | Chrome Manifest V3 | Modern extension standard |
| UI | Vanilla HTML/CSS/JS + ES Modules | Zero dependencies, fast, lightweight |
| AI | Z.AI GLM-5.1 API | OpenAI-compatible, powerful reasoning |
| Styling | Custom CSS with CSS Variables | Dark theme, Plus Jakarta Sans font |
| Data | Chrome Storage API | Persists scraped events locally |
| Notifications | Chrome Alarms + Notifications API | Smart deadline reminders |

---

## 🧩 Key Architecture Decisions

### Why a Browser Extension (not a web app)?
Spectrum is behind UM's SSO login. A web app can't access student data without OAuth integration (which UM doesn't provide). A browser extension runs *inside* Spectrum, reading the page DOM directly — no auth needed.

### Why No Build Tools (Webpack, Vite)?
For a 2-week challenge, zero-config wins. ES Modules work natively in extension pages (popup, sidepanel). The content script uses an IIFE to avoid module issues. The build script is a simple bash file that copies + patches import paths.

### Demo Mode
Judges can't log into UM Spectrum. Demo mode generates realistic sample data from actual FSKTM courses (WIA2005, WIA2004, etc.) with dates relative to today — so it always looks fresh.

### Source Links (the differentiator)
Every single event in the dashboard and chatbot response includes a clickable link back to the exact Spectrum page. This was the #1 feature requested by real UM students during user research.

---

## 📋 How the Scraper Works

The content script (`content.js`) uses 6 scraping strategies because Moodle surfaces dates in different DOM structures:

1. **Course List** — `[data-region="course-content"]` for enrolled courses
2. **Timeline Block** — `[data-region="timeline"]` for Moodle's built-in deadline overview
3. **Upcoming Events** — `.block_calendar_upcoming` for the calendar sidebar
4. **Calendar Events** — `.calendar_event_course` for calendar page events
5. **Activity Dates** — `[data-region="activity-dates"]` for per-activity due dates
6. **Announcement Parsing** — Regex date extraction from forum posts

Events are deduplicated, typed (exam/quiz/assignment/lab/etc.), and sent to the background worker for storage.

---

## 🤖 AI Chatbot Architecture

1. Events loaded from chrome.storage (or demo data)
2. System prompt built with ALL event context (dates, courses, source URLs)
3. User query sent to Z.AI GLM-5.1 via OpenAI-compatible API
4. Response rendered with rich event cards + source links
5. Falls back to smart local parsing if no API key set

---

## 📝 For Z.AI Coding Agent (VSCode)

If you're extending this project, here's what to know:

- **No npm/node_modules** — this is vanilla JS with ES modules
- **Build:** `bash build.sh` to create `dist/`
- **Test:** Load `dist/` as unpacked extension in Chrome
- **Hot reload:** After code changes, run `bash build.sh` then click the reload button on `chrome://extensions`
- **API key:** Stored in `chrome.storage.local` under key `zaiApiKey`
- **Demo data:** Modify `src/shared/data.js` `generateDemoEvents()` to add/change sample events
