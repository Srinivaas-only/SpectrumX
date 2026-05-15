# ⚡ SpectrumX

**A Chrome extension that transforms UM's SPeCTRUM LMS from the inside.**

> Built for the [Shortcut Asia Internship Challenge 2026](https://shortcut.my)

---

## What is SpectrumX?

SpectrumX is a Chrome extension for Universiti Malaya students that enhances SPeCTRUM (Moodle 4.x) without leaving the page. It aggregates deadlines, files, and course data across all enrolled courses into one smart interface.

**Why a browser extension?** Spectrum requires UM SSO authentication. A standalone app would need re-authentication. The extension shares the browser's existing session — seamless, zero-friction.

---

## Features

### Core (No AI Required)
| Feature | Description |
|---------|-------------|
| **DeepScan** | Crawls all 7 enrolled courses + calendar to find every deadline automatically |
| **Smart Dashboard** | Live countdown timer, urgency filters (Exams/Quizzes/Assignments), course filter |
| **Spotlight Search** | `Cmd+K` / `Ctrl+K` — fuzzy search across deadlines, courses, and Spectrum pages |
| **Reader Mode** | One-click distraction-free reading — strips all Moodle UI chrome |
| **Focus Mode** | Pin any course section — hides everything else |
| **File Manager** | All files from all courses in one searchable, filterable grid |
| **Auto-Attendance** | Detects open attendance sessions, one-click mark as Present |
| **Semester Export** | One-click export of entire course structure to Notion/Obsidian markdown |

### AI-Powered (Z.AI GLM-5.1)
| Feature | Description |
|---------|-------------|
| **Forum TL;DR** | Summarizes any forum discussion thread into key points + action items |
| **Smart PDF Scan** | Reads assignment PDFs and extracts deadlines using AI |
| **AI Chatbot** | Ask questions about your courses and deadlines in natural language |

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| Chrome Manifest V3 | Extension runtime |
| Vanilla JS + ES Modules | Core language (zero build tools) |
| Chrome Offscreen Document API | Background HTML parsing (MV3-compliant) |
| Z.AI GLM-5.1 | AI features (optional) |
| PDF.js (Mozilla) | Client-side PDF text extraction |
| CSS Custom Properties | Dark theme design system |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     CHROME EXTENSION                     │
├──────────────┬──────────────┬───────────────────────────┤
│   Popup      │  Side Panel  │     Content Scripts        │
│  (Dashboard, │  (AI Chat)   │  (Reader, Focus, Cmd+K,   │
│   Triage)    │              │   TL;DR, Attendance,       │
│              │              │   Export, File Manager)     │
├──────────────┴──────────────┴───────────────────────────┤
│                chrome.storage.local                      │
│            (Single source of truth for all data)         │
├─────────────────────────────────────────────────────────┤
│              Service Worker (background.js)               │
│  DeepScanner orchestrator → message routing → storage    │
├─────────────────────────────────────────────────────────┤
│              Offscreen Document (offscreen.js)            │
│  fetch() + DOMParser + PDF.js → structured data          │
└──────────────────────┬──────────────────────────────────┘
                       │ fetch (with session cookies)
                       ▼
            ┌──────────────────────┐
            │  spectrum.um.edu.my  │
            │   (Moodle 4.x +     │
            │    Moove theme)      │
            └──────────────────────┘
```

---

## Run Locally

### Prerequisites
- Google Chrome (v120+)
- Logged into [spectrum.um.edu.my](https://spectrum.um.edu.my)

### Install
1. Clone the repo:
   ```bash
   git clone https://github.com/Srinivaas-only/SpectrumX.git
   cd spectrumx
   ```
2. Build the extension:
   ```bash
   bash build.sh
   ```
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (top right toggle)
5. Click **Load unpacked** → select the `dist/` folder (or `spectrumx-v1.0.0/`)
6. Pin SpectrumX to the Chrome toolbar
7. Navigate to spectrum.um.edu.my → click the SpectrumX icon → click **Deep Scan**

---

## Folder Structure

```
spectrumx/
├── public/
│   ├── manifest.json          # Chrome MV3 manifest
│   ├── offscreen.html         # Offscreen document host
│   ├── icons/                 # Extension icons (16/48/128px)
│   └── lib/                   # PDF.js library files
├── src/
│   ├── shared/
│   │   └── data.js            # Constants, demo data, utilities
│   ├── background/
│   │   ├── background.js      # Service worker, message router
│   │   ├── deepscan.js        # DeepScanner class (scan orchestration)
│   │   └── offscreen.js       # HTML parser + PDF extractor
│   ├── content/
│   │   ├── content.js         # DOM injector (FAB, Reader, Focus, etc.)
│   │   └── content.css        # All injected UI styles
│   ├── popup/
│   │   ├── popup.html         # Dashboard + Triage views
│   │   ├── popup.css          # Popup styling
│   │   └── popup.js           # Dashboard logic, DeepScan trigger
│   └── sidepanel/
│       ├── sidepanel.html     # AI Chatbot panel
│       ├── sidepanel.css      # Chat styling
│       └── sidepanel.js       # Z.AI GLM integration
├── build.sh                   # Build script → dist/
└── README.md
```

---

## Submission

- **Challenge:** Shortcut Asia Internship Challenge 2026
- **Deadline:** May 15, 2026, 11:59pm MYT
- **Career Fair:** May 21-22, 2026 (MYTECH)
- **GitHub:** [github.com/Srinivaas-only/SpectrumX](https://github.com/Srinivaas-only/SpectrumX)

---

## License

This project is the intellectual property of the author. Built as a portfolio piece for the Shortcut Asia Internship Challenge.
