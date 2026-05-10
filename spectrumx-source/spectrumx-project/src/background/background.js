/**
 * SpectrumX — Background Service Worker
 * 
 * Handles:
 * - Storage management for scraped events
 * - Alarm-based deadline notifications
 * - DeepScan — crawl multiple Spectrum pages for all deadlines
 * - Communication between content script, popup, and side panel
 */

// Import DeepScanner (uses importScripts since manifest is not "type": "module")
importScripts('./deepscan.js');

// ============================================================
// Side Panel Setup — opens chatbot when extension icon clicked
// ============================================================
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

// ============================================================
// Installation & Startup
// ============================================================
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[SpectrumX] Extension installed');

  // Set default settings
  await chrome.storage.local.set({
    settings: {
      notificationsEnabled: true,
      notifyBeforeHours: 24,
      showPastEvents: false,
      theme: 'dark'
    },
    events: [],
    courses: [],
    lastScraped: null
  });

  // Create notification alarm — checks every 30 minutes
  chrome.alarms.create('checkDeadlines', { periodInMinutes: 30 });
});

// ============================================================
// Alarm Handler — triggers deadline notifications
// ============================================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkDeadlines') {
    const data = await chrome.storage.local.get(['events', 'settings']);
    const settings = data.settings || {};
    const events = data.events || [];

    if (!settings.notificationsEnabled) return;

    const now = new Date();
    const notifyMs = (settings.notifyBeforeHours || 24) * 60 * 60 * 1000;

    // Find events that are coming up within the notification window
    events.forEach(event => {
      const eventDate = new Date(event.date);
      const timeUntil = eventDate - now;

      // Notify if event is within the window and hasn't passed
      if (timeUntil > 0 && timeUntil <= notifyMs) {
        const hoursLeft = Math.round(timeUntil / (1000 * 60 * 60));

        chrome.notifications.create(`spectrumx-${event.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: `⏰ ${event.title}`,
          message: `Due in ${hoursLeft} hours — ${event.courseId}`,
          priority: 2
        });
      }
    });
  }
});

// ============================================================
// Message Handler — routes messages between extension components
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep message channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    // Content script sends scraped events
    case 'EVENTS_SCRAPED': {
      const { events, courses } = message.payload;
      await chrome.storage.local.set({
        events,
        courses,
        lastScraped: new Date().toISOString()
      });
      return { success: true, count: events.length };
    }

    // Popup or sidepanel requests current events
    case 'GET_EVENTS': {
      const data = await chrome.storage.local.get(['events', 'courses', 'lastScraped']);
      return {
        events: data.events || [],
        courses: data.courses || [],
        lastScraped: data.lastScraped
      };
    }

    // Get or update settings
    case 'GET_SETTINGS': {
      const data = await chrome.storage.local.get(['settings']);
      return data.settings || {};
    }

    case 'UPDATE_SETTINGS': {
      await chrome.storage.local.set({ settings: message.payload });
      return { success: true };
    }

    // Trigger deep scan on a Spectrum tab
    case 'TRIGGER_DEEP_SCAN': {
      try {
        const tabs = await chrome.tabs.query({ url: '*://spectrum.um.edu.my/*' });
        if (tabs.length === 0) {
          return { success: false, error: 'No Spectrum tab open. Open spectrum.um.edu.my first.' };
        }
        const tab = tabs[0];
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'DEEP_SCAN_REQUEST' });
        return response || { success: false, error: 'No response from content script' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // DeepScan — context-aware: scan one course deeply
    case 'DEEP_SCAN_CURRENT_COURSE': {
      try {
        const { courseUrl } = message.payload || {};
        if (!courseUrl) {
          return { success: false, error: 'No course URL provided' };
        }
        const scanner = new DeepScanner();
        const results = await scanner.scanCurrentCourse(courseUrl, (progress) => {
          chrome.runtime.sendMessage({
            type: 'DEEP_SCAN_PROGRESS',
            payload: progress
          }).catch(() => {});
        });

        if (results.events.length > 0) {
          const existing = await chrome.storage.local.get(['events', 'courses']);
          const existingEvents = existing.events || [];
          const allEvents = [...existingEvents, ...results.events];
          const seen = new Set();
          const merged = allEvents.filter(evt => {
            const key = `${evt.title?.toLowerCase()?.trim()}-${evt.date?.substring(0, 10)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          await chrome.storage.local.set({
            events: merged,
            courses: results.courses.length > 0 ? results.courses : (existing.courses || []),
            lastScraped: new Date().toISOString(),
            isDemo: false
          });
        }

        return {
          success: true,
          eventsFound: results.events.length,
          pagesScanned: results.scannedUrls.length,
          errors: results.errors
        };
      } catch (err) {
        console.error('[SpectrumX] Current course scan error:', err);
        return { success: false, error: err.message };
      }
    }

    // DeepScan — crawl multiple Spectrum pages for events via offscreen document
    case 'DEEP_SCAN': {
      try {
        const scanner = new DeepScanner();
        const results = await scanner.scan((progress) => {
          // Send progress updates back to popup/sidepanel
          chrome.runtime.sendMessage({
            type: 'DEEP_SCAN_PROGRESS',
            payload: progress
          }).catch(() => {}); // Ignore if popup/sidepanel closed
        });

        // Save results to storage
        if (results.events.length > 0) {
          const existing = await chrome.storage.local.get(['events', 'courses']);
          const existingEvents = existing.events || [];

          // Combine and deduplicate
          const allEvents = [...existingEvents, ...results.events];
          const seen = new Set();
          const merged = allEvents.filter(evt => {
            const key = `${evt.title?.toLowerCase()?.trim()}-${evt.date?.substring(0, 10)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          await chrome.storage.local.set({
            events: merged,
            courses: results.courses.length > 0 ? results.courses : (existing.courses || []),
            lastScraped: new Date().toISOString(),
            lastDeepScan: new Date().toISOString(),
            isDemo: false
          });
        }

        return {
          success: true,
          eventsFound: results.events.length,
          pagesScanned: results.scannedUrls.length,
          errors: results.errors
        };
      } catch (err) {
        console.error('[SpectrumX] DeepScan error:', err);
        return { success: false, error: err.message };
      }
    }

    // Open side panel (chatbot)
    case 'OPEN_CHATBOT': {
      if (sender.tab) {
        await chrome.sidePanel.open({ tabId: sender.tab.id });
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// ============================================================
// Notification click handler — opens source URL
// ============================================================
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('spectrumx-')) {
    const eventId = notificationId.replace('spectrumx-', '');
    const data = await chrome.storage.local.get(['events']);
    const event = (data.events || []).find(e => e.id === eventId);

    if (event && event.sourceUrl) {
      chrome.tabs.create({ url: event.sourceUrl });
    }
  }
});
