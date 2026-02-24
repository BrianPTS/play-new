import moment from "moment";
import { setTimeout } from "timers/promises";
import { Event, ErrorLog, ConsecutiveGroup } from "./models/index.js";
import { ScrapeEvent, refreshHeaders, generateEnhancedHeaders } from "./scraper.js";
import * as fs from "fs";
import path from "path";
import ProxyManager from "./helpers/ProxyManager.js";
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import SessionManager from './helpers/SessionManager.js';
import pThrottle from 'p-throttle';
import config from './config/scraperConfig.js';
import _ from 'lodash';
import InventoryApi from './utils/inventoryApi.js';
import { cleanup as cleanupBrowsers, browserPagePool } from './browser-cookies.js';
// CSV upload functionality removed
let inventoryIdCounter = 0;

function generateUniqueInventoryId() {
  // Enhanced algorithm to prevent collisions even under high load
  const timestamp = Date.now();
  const processId = process.pid % 1000; // Use process ID for multi-instance uniqueness
  const random = Math.floor(Math.random() * 1000); // Add randomness
  
  // Increment counter and reset if it exceeds 3 digits (0-999)
  inventoryIdCounter = (inventoryIdCounter + 1) % 1000;
  
  // Create a unique string: timestamp(13) + processId(3) + counter(3) + random(3) = 22 digits
  const fullUniqueString = `${timestamp}${processId.toString().padStart(3, '0')}${inventoryIdCounter.toString().padStart(3, '0')}${random.toString().padStart(3, '0')}`;
  
  // Hash to 10 digits for compatibility while maintaining uniqueness
  // Use a simple but effective hash that preserves uniqueness
  const hash = fullUniqueString.split('').reduce((acc, char, index) => {
    return ((acc << 5) - acc + char.charCodeAt(0) + index) & 0x7fffffff;
  }, 0);
  
  // Ensure it's always 10 digits by taking modulo and padding
  const tenDigitId = (hash % 9000000000) + 1000000000; // Ensures 10 digits (1000000000-9999999999)
  
  return tenDigitId;
}

// CSV processing functionality removed entirely

const MAX_UPDATE_INTERVAL = config.MAX_UPDATE_INTERVAL; // Use config value
const MAX_RETRIES = config.MAX_RETRIES; // Use config value
const SCRAPE_TIMEOUT = config.SCRAPE_TIMEOUT; // Use config value
const MIN_TIME_BETWEEN_EVENT_SCRAPES = config.MIN_TIME_BETWEEN_EVENT_SCRAPES; // Use config value (reduced to 5000ms)
const MAX_ALLOWED_UPDATE_INTERVAL = 180000; // Maximum 3 minutes allowed between updates
const EVENT_FAILURE_THRESHOLD = 120000; // 2 minutes for faster recovery
const STALE_EVENT_THRESHOLD = 600000; // 10 minutes - events will be stopped after this

// Multi-tier recovery intervals for aggressive processing
const CRITICAL_RECOVERY_INTERVAL = config.PROCESSING_INTERVAL * 20; // Check critical events more frequently
const AGGRESSIVE_RECOVERY_INTERVAL = config.PROCESSING_INTERVAL * 40; // Check stale events more frequently
const STANDARD_RECOVERY_INTERVAL = config.PROCESSING_INTERVAL * 60; // Check standard events more frequently
const AUTO_STOP_CHECK_INTERVAL = config.PROCESSING_INTERVAL * 120; // Check auto-stop events more frequently
const DISABLE_AUTO_STOP = true; // Global constant to disable auto-stopping of stale or failed events - PERMANENTLY DISABLED

// Logging levels: 0 = errors only, 1 = warnings + errors, 2 = info + warnings + errors, 3 = all (verbose)
const LOG_LEVEL = 3; // Default to warnings and errors only

// Cookie expiration threshold: refresh cookies every 20 minutes
const COOKIE_EXPIRATION_MS = 20 * 60 * 1000; // 20 minutes (standardized timing)
const SESSION_REFRESH_INTERVAL = 20 * 60 * 1000; // 20 minutes for session refresh (standardized)

// Anti-bot helpers: rotate User-Agent and spoof IP
const generateRandomIp = () => Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join('.');
// Number of proxy rotation attempts when fetching fresh cookies/headers

// Only accept cookie sets with at least this many cookies to avoid challenge pages
const MIN_VALID_COOKIES = 3;

// Realistic fingerprint options to mimic human browsers (language, timezone, plugins, screen size, etc.)
const FINGERPRINT_POOL = [
  { language: 'en-US', timezone: 'America/Los_Angeles', platform: 'Win32', screen: { width:1920, height:1080 }, deviceMemory: 8, hardwareConcurrency: 8, plugins: ['Widevine Content Decryption Module','Chrome PDF Viewer','Native Client'] },
  { language: 'en-GB', timezone: 'Europe/London', platform: 'MacIntel', screen: { width:1440, height:900 }, deviceMemory: 8, hardwareConcurrency: 4, plugins: ['PDF Viewer','QuickTime Plug-in 7.7.9','Java(TM) Platform SE 8 U211'] },
  { language: 'fr-FR', timezone: 'Europe/Paris', platform: 'Win32', screen: { width:1366, height:768 }, deviceMemory: 4, hardwareConcurrency: 4, plugins: ['Chrome PDF Viewer','Widevine Content Decryption Module'] },
  { language: 'de-DE', timezone: 'Europe/Berlin', platform: 'Linux x86_64', screen: { width:1920, height:1080 }, deviceMemory: 16, hardwareConcurrency: 8, plugins: ['Flash','QuickTime Plug-in','Java Bridge'] },
  // Firefox fingerprint with common privacy/bot-buster add-ons for human-like behavior
  { language: 'en-US', timezone: 'America/New_York', platform: 'MacIntel', screen: { width:1680, height:1050 }, deviceMemory: 8, hardwareConcurrency: 4, plugins: ['uBlock Origin','Privacy Badger','CanvasBlocker','NoScript','Video DownloadHelper'] }
];
// Helper to pick a random fingerprint
const randomFingerprint = () => FINGERPRINT_POOL[Math.floor(Math.random() * FINGERPRINT_POOL.length)];

// Enhanced cookie management
const COOKIE_MANAGEMENT = {
  ESSENTIAL_COOKIES: [
    "TMUO",
    "TMPS",
    "TM_TKTS",
    "SESSION",
    "audit",
    "CMPS",
    "CMID",
    "MUID",
    "au_id",
    "aud",
    "tmTrackID",
    "TapAd_DID",
    "uid",
  ],
  AUTH_COOKIES: ["TMUO", "TMPS", "TM_TKTS", "SESSION", "audit"],
  MAX_COOKIE_LENGTH: 8000,
  COOKIE_REFRESH_INTERVAL: 20 * 60 * 1000, // 20 minutes (standardized timing)
  MAX_COOKIE_AGE:   30 * 60 * 60 * 1000,
  COOKIE_ROTATION: {
    ENABLED: true,
    MAX_STORED_COOKIES: 100,
    ROTATION_INTERVAL: 20 * 60 * 1000, // 20 minutes (standardized timing)
    LAST_ROTATION: Date.now(),
    ENFORCE_UNIQUE: true, // Ensure unique cookies are generated
  },
};

// CSV upload constants removed


export class ScraperManager {
  constructor() {
    this.startTime = moment();
    this.lastSuccessTime = moment(); // Initialize to now to avoid false stall detection on startup
    this.successCount = 0;
    this.activeJobs = new Map();
    this.failedEvents = new Set(); // Kept for tracking purposes only, no retry logic
    // retryQueue removed
    this.isRunning = false;
    this.headersCache = new Map();
    this.eventUpdateTimestamps = new Map();
    this.priorityQueue = new Set();
    this.processingEvents = new Set(); // Track events currently being processed
    this.processingLocks = new Map(); // Track events that are locked for processing
    this.headerRefreshTimestamps = new Map(); // Track when headers were last refreshed
    this.cooldownEvents = new Map(); // Events that need to cool down before retry
    this.eventFailureCount = new Map(); // Track failure count per event
    this.eventLastFailureTime = new Map(); // Track last failure time per event

    // System circuit breaker removed
    this.eventUpdateSchedule = new Map(); // Tracks when each event needs to be updated next
    this.eventFailureCounts = new Map(); // Track consecutive failures per event
    this.eventFailureTimes = new Map(); // Track when failures happened
    this.globalConsecutiveErrors = 0; // Track consecutive errors across all events
    this.lastCookieReset = null; // Track when cookies were last reset
    this.cookiesPath = path.join(process.cwd(), "cookies.json"); // Path to cookies file
    // Initialize the proxy manager
    this.proxyManager = new ProxyManager(this);

    // Initialize SessionManager for robust session handling
    this.sessionManager = new SessionManager(this);

    // Setup cookie rotation tracking
    this.cookieRotationIntervalId = null;
    this.lastCookieRotation = Date.now();

    // New: Data caching and API error handling
    this.headerRotationPool = []; // Pool of working headers
    this.proxySuccessRates = new Map(); // Track success rates per proxy
    // API circuit breaker removed
    this.headerSuccessRates = new Map(); // Track which headers work better

    // Event processing
    this.eventProcessingQueue = []; // Queue of events to process
    this.eventLastProcessedTime = new Map(); // Track when each event was last processed
    this.eventPriorityScores = new Map(); // Cache priority scores
    this.eventMaxRetries = new Map(); // Track dynamic retry limits per event

    // Enhanced throttled ScrapeEvent for parallel processing
    this.throttledScrapeEvent = pThrottle({
      limit: config.CONCURRENT_LIMIT, // 5 concurrent scrapes
      interval: 100, // Minimal interval for maximum throughput
      strict: false, // Allow bursts for better throughput
    })(ScrapeEvent);

    // Initialize inventory API for external deletions
    this.inventoryApi = new InventoryApi();
  }

  logWithTime(message, type = "info") {
    // Map log levels to numeric values
    const logLevels = {
      error: 0,
      warning: 1,
      info: 2,
      success: 2,
      debug: 3,
    };

    // Skip logging if level is higher than configured LOG_LEVEL
    if (logLevels[type] > LOG_LEVEL) {
      return;
    }

    const now = moment();
    const formattedTime = now.format("YYYY-MM-DD HH:mm:ss");

    const statusEmoji =
      {
        success: "✅",
        error: "❌",
        warning: "⚠️",
        info: "ℹ️",
        debug: "🔍",
      }[type] || "📝";

    // Only include detailed stats for errors or if we're at the highest verbosity
    if (type === "error" || LOG_LEVEL >= 3) {
      const runningTime = moment.duration(now.diff(this.startTime));
      console.log(
        `${statusEmoji} [${formattedTime}] ${message}\n` +
          `   Runtime: ${Math.floor(
            runningTime.asHours()
          )}h ${runningTime.minutes()}m ${runningTime.seconds()}s\n` +
          `   Active: ${this.activeJobs.size}, Success: ${this.successCount}, Failed: ${this.failedEvents.size}`
      );
    } else {
      console.log(`${statusEmoji} [${formattedTime}] ${message}`);
    }
  }

  async logError(eventId, errorType, error, metadata = {}) {
    try {
      const event = await Event.findOne({ Event_ID: eventId })
        .select("url _id Last_Updated")
        .lean();

      // Fix for missing eventUrl - provide a fallback
      const eventUrl = event?.url || `unknown-url-for-event-${eventId}`;
      const eventObjectId = event?._id || null;

      // Log to console first in case DB logging fails
      console.error(
        `Error for event ${eventId} (${errorType}): ${error.message}`
      );

      // Check if this is a failure that should be logged to the database
      const shouldLogToDB = this.shouldLogErrorToDatabase(eventId, errorType);

      // Only try to log to database if we have minimal required data and it's a significant error
      if (eventObjectId && shouldLogToDB) {
        await ErrorLog.create({
          eventUrl: eventUrl,
          eventId: eventObjectId,
          externalEventId: eventId,
          errorType,
          message: error.message,
          stack: error.stack,
          metadata: {
            ...metadata,
            timestamp: new Date(),
            iteration: metadata.iterationNumber || 1,
          },
        });
      } else if (!eventObjectId) {
        console.error(
          `Cannot log to ErrorLog - event ${eventId} not found in database`
        );
      }
    } catch (err) {
      console.error("Error logging to database:", err);
      console.error("Original error:", error);
    }
  }

  // Helper method to determine if an error should be logged to the database
  shouldLogErrorToDatabase(eventId, errorType) {
    // Always log critical errors like LONG_COOLDOWN
    if (errorType === "LONG_COOLDOWN") {
      return true;
    }

    // Check if the event has been marked as failed due to 10-min threshold
    const lastUpdate = this.eventUpdateTimestamps.get(eventId);
    if (!lastUpdate) {
      return true; // No record of updates, should log
    }

    // Only log errors to database if the event has exceeded the failure threshold (10 minutes)
    const timeSinceUpdate = moment().diff(lastUpdate);
    return timeSinceUpdate >= EVENT_FAILURE_THRESHOLD;
  }

  // Semaphore methods removed - using sequential processing

  // Start continuous scraping
  async startContinuousScraping() {
    if (this.isRunning) {
      this.logWithTime("Scraper is already running", "warning");
      return;
    }

    try {
      this.isRunning = true;
      this.logWithTime(
        "Starting continuous scraping with optimized retry handling...",
        "success"
      );

      // Background retry processor removed - retries handled in sequential processing

      // Start performance monitoring
      this.startPerformanceMonitoring();

      // Cookie refresh, session rotation, and header refresh are all REMOVED.
      // The browser page pool navigates to a real event page and gets authentic
      // cookies automatically. fetch() with credentials:'include' sends them.

      // Start failure tracking cleanup (every 10 minutes)
      setInterval(() => {
        this.cleanupFailureTracking();
      }, 600000);

      // Retry queue cleanup removed

      // Start concurrent event processing
      this.logWithTime(
        `Started parallel event processing (${config.CONCURRENT_LIMIT} concurrent, batch size ${config.BATCH_SIZE})`,
        "success"
      );

      // Pre-initialize browser page pool so the first batch doesn't burn 20-30s
      try {
        const proxy = global.proxyManager ? global.proxyManager.getProxyForEvent('pre-init') : null;
        // Grab one event ID so the seed page visits a real event URL for full cookies
        const sampleEvent = await Event.findOne({ Skip_Scraping: { $ne: true } }).select('Event_ID').lean();
        const seedEventId = sampleEvent?.Event_ID || null;
        this.logWithTime(`Pre-initializing browser page pool (proxy: ${proxy?.proxy || 'none'}, seed: ${seedEventId || 'homepage'})`, 'info');
        await browserPagePool.init(proxy, null, seedEventId);
        this.logWithTime('Browser page pool pre-initialized successfully', 'success');
      } catch (preInitErr) {
        this.logWithTime(`Pool pre-init failed (will lazy-init on first request): ${preInitErr.message}`, 'warning');
      }

      // Main concurrent processing loop
      await this.startConcurrentProcessing();
    } catch (error) {
      this.logWithTime(
        `Error in startContinuousScraping: ${error.message}`,
        "error"
      );
      this.isRunning = false;
      throw error;
    }
  }

  // Stop continuous scraping
  stopContinuousScraping() {
    if (!this.isRunning) {
      this.logWithTime("Scraper is not running", "warning");
      return;
    }

    this.isRunning = false;
    this.logWithTime("Stopping continuous scraping...", "warning");

    // Clear any active jobs
    this.activeJobs.clear();
    this.processingEvents.clear();

    // Retry queue cleanup interval removed

    this.logWithTime("Continuous scraping stopped", "success");
  }

  // Background retry processor removed - retries handled in sequential processing

  // processEventWithRetry method removed - retry logic handled in sequential processing

  // Helper methods for background retry processor removed - using sequential processing

  shouldSkipEvent(eventId) {
    // Check if event is in cooldown period
    if (this.cooldownEvents.has(eventId)) {
      const cooldownUntil = this.cooldownEvents.get(eventId);
      if (moment().isBefore(cooldownUntil)) {
        return true;
      } else {
        this.cooldownEvents.delete(eventId);
      }
    }

    // Check if event is already being processed
    if (this.processingEvents.has(eventId)) {
      return true;
    }

    // For high-performance mode, use last processed time instead of update timestamps
    const lastProcessed = this.eventLastProcessedTime.get(eventId);
    if (lastProcessed && Date.now() - lastProcessed < 5000) {
      // Skip if processed in last 5 seconds (reduced from 30 seconds for better scalability)
      return true;
    }

    return false;
  }

  async refreshEventHeaders(eventId, forceRefresh = false) {
    // Anti-bot: Aggressively fetch fresh cookies/headers with 20-minute refresh cycle
    try {
      // ALWAYS use random event IDs for cookie refresh, never the original eventId
      let eventToUse;

      // Use a cached pool of random event IDs to avoid DB aggregate on every call
      if (!this._randomEventPool || this._randomEventPool.length === 0 || 
          !this._randomEventPoolTime || Date.now() - this._randomEventPoolTime > 60000) {
        // Refresh pool every 60 seconds or when empty
        try {
          const poolEvents = await Event.aggregate([
            { $match: { Skip_Scraping: { $ne: true }, url: { $exists: true, $ne: "" } } },
            { $sample: { size: 50 } },
            { $project: { Event_ID: 1 } },
          ]);
          if (poolEvents && poolEvents.length > 0) {
            this._randomEventPool = poolEvents.map(e => e.Event_ID);
            this._randomEventPoolTime = Date.now();
          }
        } catch (poolError) {
          this.logWithTime(`Error refreshing random event pool: ${poolError.message}`, "warning");
        }
      }

      // Pick from cached pool
      if (this._randomEventPool && this._randomEventPool.length > 0) {
        const idx = Math.floor(Math.random() * this._randomEventPool.length);
        eventToUse = this._randomEventPool[idx];
      }

      // Fallback if pool is empty
      if (!eventToUse) {
      // Try multiple ways to get random event IDs to ensure we always get one
      try {
        // First attempt: Get multiple random active events from the database
        const randomEvents = await Event.aggregate([
          {
            $match: {
              Skip_Scraping: { $ne: true },
              url: { $exists: true, $ne: "" },
            },
          },
          { $sample: { size: 20 } },
          { $project: { Event_ID: 1, url: 1 } },
        ]);

        if (randomEvents && randomEvents.length > 0) {
          const randomIndex = Math.floor(Math.random() * randomEvents.length);
          const selectedEvent = randomEvents[randomIndex];
          eventToUse = selectedEvent.Event_ID;

          if (LOG_LEVEL >= 1) {
            // Increased to level 1 for visibility
            this.logWithTime(
              `Using random event ${eventToUse} for cookie refresh (original event: ${eventId})`,
              "info" // Changed from "debug" to "info"
            );
          }
        } else {
          // Second attempt: Try to get any random event ID from other data sources
          try {
            // Try to find any event from the failedEvents set
            if (this.failedEvents.size > 0) {
              const failedEventsArray = Array.from(this.failedEvents);
              const randomFailedEvent =
                failedEventsArray[
                  Math.floor(Math.random() * failedEventsArray.length)
                ];

              // Make sure it's different from the original event ID
              if (randomFailedEvent && randomFailedEvent !== eventId) {
                eventToUse = randomFailedEvent;
                this.logWithTime(
                  `Using random failed event ${eventToUse} for cookie refresh`,
                  "info"
                );
              }
            }

            // If still no event, try from active jobs
            if (!eventToUse && this.activeJobs.size > 0) {
              const activeJobsArray = Array.from(this.activeJobs.keys());
              const randomActiveEvent =
                activeJobsArray[
                  Math.floor(Math.random() * activeJobsArray.length)
                ];

              // Make sure it's different from the original event ID
              if (randomActiveEvent && randomActiveEvent !== eventId) {
                eventToUse = randomActiveEvent;
                this.logWithTime(
                  `Using random active event ${eventToUse} for cookie refresh`,
                  "info"
                );
              }
            }

            // If we still don't have a random event, try to use any cached event ID
            if (!eventToUse) {
              if (this.headerRefreshTimestamps.size > 0) {
                // Use a random event ID from the cache that's different from the original
                const cachedEvents = Array.from(
                  this.headerRefreshTimestamps.keys()
                );
                const filteredEvents = cachedEvents.filter(
                  (id) => id !== eventId
                );
                if (filteredEvents.length > 0) {
                  eventToUse =
                    filteredEvents[
                      Math.floor(Math.random() * filteredEvents.length)
                    ];
                  this.logWithTime(
                    `Using cached event ID ${eventToUse} for cookie refresh after database error`,
                    "warning"
                  );
                } else {
                  // If no suitable cached event, try a random one from the database again
                  try {
                    const broadQuery = await Event.findOne()
                      .sort({ Last_Updated: 1 })
                      .limit(1)
                      .lean();
                    if (broadQuery) {
                      eventToUse = broadQuery.Event_ID;
                      this.logWithTime(
                        `Using fallback database event ${eventToUse} for cookie refresh`,
                        "info"
                      );
                    } else {
                      eventToUse = eventId; // Last resort: use original
                      this.logWithTime(
                        `No alternative events found, using original event ID ${eventToUse} for cookie refresh`,
                        "warning"
                      );
                    }
                  } catch (fallbackError) {
                    eventToUse = eventId; // Last resort: use original
                    this.logWithTime(
                      `Fallback database query failed, using original event ID ${eventToUse} for cookie refresh`,
                      "warning"
                    );
                  }
                }
              } else {
                // No cached events available, try one more database query
                try {
                  const anyEvent = await Event.findOne()
                    .sort({ Last_Updated: 1 })
                    .limit(1)
                    .lean();
                  if (anyEvent) {
                    eventToUse = anyEvent.Event_ID;
                    this.logWithTime(
                      `Using any available event ID ${eventToUse} for cookie refresh`,
                      "info"
                    );
                  } else {
                    eventToUse = eventId; // Last resort: use original
                    this.logWithTime(
                      `No events found in database, using original event ID ${eventToUse} for cookie refresh`,
                      "warning"
                    );
                  }
                } catch (dbFallbackError) {
                  eventToUse = eventId; // Last resort: use original
                  this.logWithTime(
                    `Final database query failed, using original event ID ${eventToUse} for cookie refresh`,
                    "warning"
                  );
                }
              }
            }
          } catch (fallbackError) {
            this.logWithTime(
              `Error finding alternative random event: ${fallbackError.message}`,
              "warning"
            );
            // Try to use the original event ID as last resort
            eventToUse = eventId;
            this.logWithTime(
              `Falling back to original event ID ${eventToUse} for cookie refresh`,
              "warning"
            );
          }
        }
      } catch (dbError) {
        this.logWithTime(
          `Error getting random event: ${dbError.message}`,
          "warning"
        );

        // Try to find any existing event ID in the cache
        if (this.headerRefreshTimestamps.size > 0) {
          const cachedEvents = Array.from(this.headerRefreshTimestamps.keys());
          const filteredEvents = cachedEvents.filter((id) => id !== eventId);
          if (filteredEvents.length > 0) {
            eventToUse =
              filteredEvents[Math.floor(Math.random() * filteredEvents.length)];
            this.logWithTime(
              `Using cached event ID ${eventToUse} for cookie refresh after database error`,
              "warning"
            );
          } else {
            // Last resort: use original eventId
            eventToUse = eventId;
            this.logWithTime(
              `No alternative event IDs available, using original event ID ${eventToUse} for cookie refresh`,
              "warning"
            );
          }
        } else {
          // Last resort: use original eventId
          eventToUse = eventId;
          this.logWithTime(
            `No cached event IDs available, using original event ID ${eventToUse} for cookie refresh`,
            "warning"
          );
        }
      }
      } // end fallback if pool empty

      const eventDoc = await Event.findOne({ Event_ID: eventToUse })
        .select("url")
        .lean();
      const refererUrl = eventDoc?.url || "https://www.ticketmaster.com/";

      // More unique request ID format with microsecond precision
      const requestId = `req-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 10)}`;

      const lastRefresh = this.headerRefreshTimestamps.get(eventToUse);

      // Generate a new X-Forwarded-For and X-Request-Id for each request
      const refreshedIpAndId = {
        "X-Forwarded-For": generateRandomIp(),
        "X-Request-Id": requestId,
        "X-Timestamp": Date.now().toString(),
        "X-Unique-ID": uuidv4(),
      };

      // More aggressive refresh interval (20 minutes)
      const effectiveExpirationTime = COOKIE_MANAGEMENT.COOKIE_REFRESH_INTERVAL;

      // Force refresh if requested or refresh interval exceeded
      if (
        forceRefresh ||
        !lastRefresh ||
        moment().diff(lastRefresh) > effectiveExpirationTime
      ) {
        if (LOG_LEVEL >= 1) {
          // Increased logging level for better visibility
          this.logWithTime(
            `Refreshing headers for ${eventToUse} ${
              forceRefresh ? "(forced)" : ""
            }`,
            "info"
          );
        }

        // Clear any stale headers from the cache
        this.headersCache.delete(eventToUse);

        // Skip rotation pool and always get fresh cookies
        // This ensures we always have fresh, unique cookies

        // First attempt: Try with session manager
        let sessionData = null;
        try {
          // Get a fresh session or create a new one
          sessionData = await this.sessionManager.getSessionForEvent(
            eventToUse,
            null,
            true
          );

          if (sessionData && sessionData.cookies) {
            this.logWithTime(
              `Got fresh session for ${eventToUse} from session manager`,
              "info"
            );

            // Convert session cookies to headers
            const cookieString = sessionData.cookies
              .map((c) => `${c.name}=${c.value}`)
              .join("; ");

            // Get random fingerprint for diversity
            const fingerprint = sessionData.fingerprint || randomFingerprint();

            // Generate enhanced headers
            const enhanced = generateEnhancedHeaders(fingerprint, cookieString);

            // Inject anti-bot fields
            enhanced["Referer"] = refererUrl;
            enhanced["X-Forwarded-For"] = refreshedIpAndId["X-Forwarded-For"];
            enhanced["X-Request-Id"] = refreshedIpAndId["X-Request-Id"];
            enhanced["X-Unique-ID"] = refreshedIpAndId["X-Unique-ID"];

            const standardizedHeaders = {
              headers: enhanced,
              cookies: sessionData.cookies,
              fingerprint: fingerprint,
              timestamp: Date.now(),
              sessionId: sessionData.sessionId,
              freshlyGenerated: true,
            };

            // Cache the headers
            this.headersCache.set(eventToUse, standardizedHeaders);
            this.headerRefreshTimestamps.set(eventToUse, moment());

            return standardizedHeaders;
          }
        } catch (sessionError) {
          this.logWithTime(
            `Session manager error: ${sessionError.message}, trying direct refresh`,
            "warning"
          );
        }

        // Second attempt: Get a random proxy for refreshing headers
        const cookieProxy =
          this.proxyManager.getProxyForEvent(eventToUse);

        // Try to refresh headers with the proxy (now includes retry mechanism)
        let capturedState = null;
        try {
          this.logWithTime(
            `Attempting cookie refresh for ${eventToUse} with proxy ${
              cookieProxy ? cookieProxy.proxy : "none"
            }`,
            "info"
          );
          capturedState = await refreshHeaders(eventToUse, cookieProxy);
          this.logWithTime(
            `Successfully refreshed cookies for ${eventToUse}`,
            "info"
          );
        } catch (error) {
          this.logWithTime(
            `Cookie refresh failed for ${eventToUse} after retries: ${error.message}`,
            "warning"
          );
        }

        if (
          capturedState &&
          capturedState.cookies &&
          capturedState.cookies.length >= MIN_VALID_COOKIES
        ) {
          // Build enhanced headers using the shared generator
          const cookieString = capturedState.cookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");
          const poolFp = randomFingerprint();
          const mergedFp = { ...capturedState.fingerprint, ...poolFp };
          // Generate varied headers
          const enhanced = generateEnhancedHeaders(mergedFp, cookieString);
          // Inject anti-bot fields
          enhanced["Referer"] = refererUrl;
          enhanced["X-Forwarded-For"] = refreshedIpAndId["X-Forwarded-For"];
          enhanced["X-Request-Id"] = refreshedIpAndId["X-Request-Id"];
          enhanced["X-Unique-ID"] = refreshedIpAndId["X-Unique-ID"];

          const standardizedHeaders = {
            headers: enhanced,
            cookies: capturedState.cookies,
            fingerprint: mergedFp,
            timestamp: Date.now(),
            freshlyGenerated: true,
          };

          // Cache and rotate
          this.headersCache.set(eventToUse, standardizedHeaders);
          this.headerRefreshTimestamps.set(eventToUse, moment());

          // Add to rotation pool if not already present
          if (
            !this.headerRotationPool.some(
              (h) => h.headers.Cookie === cookieString
            )
          ) {
            this.headerRotationPool.push(standardizedHeaders);
            if (this.headerRotationPool.length > 20)
              // Increased pool size
              this.headerRotationPool.shift();
          }

          return standardizedHeaders;
        } else {
          this.logWithTime(
            `Failed to get valid cookies for ${eventToUse}`,
            "warning"
          );
        }
      } else {
        // Use cached headers but refresh dynamic fields
        const cachedHeaders = this.headersCache.get(eventToUse);
        if (cachedHeaders) {
          // Create a deep copy to avoid modifying the cached version
          const refreshedHeaders = JSON.parse(JSON.stringify(cachedHeaders));

          // Update dynamic anti-bot fields
          if (refreshedHeaders.headers) {
            refreshedHeaders.headers = {
              ...refreshedHeaders.headers,
              ...refreshedIpAndId,
            };
          }

          // Mark headers as reused (not freshly generated)
          refreshedHeaders.freshlyGenerated = false;

          return refreshedHeaders;
        }
      }
    } catch (error) {
      this.logWithTime(`Failed to refresh headers: ${error.message}`, "error");
    }

    // As a fallback, try to use any previously cached headers
    const cachedHeaders = this.headersCache.get(eventId);
    if (cachedHeaders) {
      // Update dynamic anti-bot fields here too
      const refreshedHeaders = JSON.parse(JSON.stringify(cachedHeaders));
      refreshedHeaders.headers["X-Forwarded-For"] = generateRandomIp();
      refreshedHeaders.headers[
        "X-Request-Id"
      ] = `req-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
      refreshedHeaders.headers["X-Unique-ID"] = uuidv4();
      refreshedHeaders.freshlyGenerated = false;
      return refreshedHeaders;
    }

    // If all else fails, try to use headers from rotation pool
    if (this.headerRotationPool.length > 0) {
      const headerIndex = Math.floor(
        Math.random() * this.headerRotationPool.length
      );
      const poolHeaders = JSON.parse(
        JSON.stringify(this.headerRotationPool[headerIndex])
      );

      // Update dynamic anti-bot fields
      if (poolHeaders.headers) {
        poolHeaders.headers["X-Forwarded-For"] = generateRandomIp();
        poolHeaders.headers["X-Request-Id"] = `req-${Date.now()}-${Math.random()
          .toString(36)
          .substring(2, 10)}`;
        poolHeaders.headers["X-Unique-ID"] = uuidv4();
      }

      poolHeaders.freshlyGenerated = false;
      return poolHeaders;
    }

    // Ultimate fallback: generate basic headers
    this.logWithTime(`Using fallback headers for ${eventId}`, "warning");
    return {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://www.ticketmaster.com/",
        "X-Forwarded-For": generateRandomIp(),
        "X-Request-Id": `req-${Date.now()}-${Math.random()
          .toString(36)
          .substring(2, 10)}`,
        "X-Unique-ID": uuidv4(),
      },
      freshlyGenerated: false,
    };
  }

  async resetCookiesAndHeaders() {
    // Avoid resetting cookies too frequently (at most once per hour)
    const now = moment();
    if (
      this.lastCookieReset &&
      now.diff(this.lastCookieReset) < COOKIE_EXPIRATION_MS
    ) {
      if (LOG_LEVEL >= 1) {
        this.logWithTime(
          `Skipping cookie reset - last reset was ${moment
            .duration(now.diff(this.lastCookieReset))
            .humanize()} ago`,
          "warning"
        );
      }
      return;
    }

    try {
      this.logWithTime(
        "Detected multiple API failures - resetting cookies and headers",
        "warning"
      );

      // Check if cookies.json exists before trying to delete it
      try {
        await fs.access(this.cookiesPath);
        // Only delete if expired
        const stats = await fs.stat(this.cookiesPath);
        const cookieAge = now.diff(moment(stats.mtime));
        if (cookieAge < COOKIE_EXPIRATION_MS) {
          if (LOG_LEVEL >= 2) {
            this.logWithTime(
              `Cookies not expired yet (age ${cookieAge}ms), skipping fresh retrieval`,
              "info"
            );
          }
          return true;
        }
        // Delete expired cookies
        await fs.unlink(this.cookiesPath);
        if (LOG_LEVEL >= 1) {
          this.logWithTime("Deleted expired cookies.json", "info");
        }
      } catch (e) {
        // File doesn't exist or stat failed, that's fine
        if (LOG_LEVEL >= 2) {
          this.logWithTime("No cookies.json file found to delete", "info");
        }
      }

      // Clear all cached headers
      this.headersCache.clear();
      this.headerRefreshTimestamps.clear();

      // Reset error counters
      this.globalConsecutiveErrors = 0;
      this.lastCookieReset = now;

      // Apply a system-wide cooldown to allow for fresh cookie generation
      this.logWithTime(
        "Applying 30-second cooldown to allow for cookie regeneration",
        "info"
      );
      await setTimeout(30000);

      // Trigger a headers refresh on the next event
      return true;
    } catch (error) {
      this.logWithTime(`Error resetting cookies: ${error.message}`, "error");
      return false;
    }
  }

  async updateEventMetadata(eventId, scrapeResult) {
    const startTime = performance.now();
    const session = await Event.startSession();
// save json here as well for scrapeResults 
// const scrapeResultJson = JSON.stringify(scrapeResult);
// fs.writeFileSync('debug/scrapeResult.json', scrapeResultJson);
    try {
      return await session.withTransaction(async () => {
        // Get event data upfront - always fresh, no caching
        const event = await Event.findOne({ Event_ID: eventId })
          .select(
            "priceIncreasePercentage inHandDate mapping_id Available_Seats metadata Event_Name Venue Event_DateTime"
          ) // Added Event_Name, Venue, Event_DateTime
          .session(session)
          .read('primary'); // Force read from primary for fresh data

      if (!event) {
        throw new Error(`Event ${eventId} not found in database`);
      }

      const priceIncreasePercentage = event.priceIncreasePercentage;
      const inHandDate = event.inHandDate; // This is for seat level inHandDate
      const mapping_id = event.mapping_id;
      const event_name = event.Event_Name;
      const venue_name = event.Venue;
      const event_date = event.Event_DateTime;

      if (!mapping_id) {
        throw new Error(`Event ${eventId} is missing required mapping_id`);
      }

      // Validate scrapeResult - null or empty data should not be considered success
      if (!scrapeResult || !Array.isArray(scrapeResult) || scrapeResult.length === 0) {
        throw new Error(`Event ${eventId} scrape failed - no valid data returned. Scrape result: ${scrapeResult ? 'empty array' : 'null/undefined'}`);
      }

      // Initialize variables for database operations tracking
      let rowsToDelete = [];
      let rowsToInsert = [];
      let rowsToUpdate = [];
      let unchangedRows = 0;

      // Filter valid groups - only check for basic structure, allow single seats
      const validScrapeResult = scrapeResult.filter(
        (group) =>
          group.seats &&
          group.seats.length > 1 &&
          group.inventory &&
          group.inventory.quantity > 1
      );
      
      // If all data was filtered out, this indicates a data quality issue, not an empty event
      if (validScrapeResult.length === 0) {
        throw new Error(`Event ${eventId} scrape validation failed - all ${scrapeResult.length} groups filtered out due to invalid structure or single seats`);
      }
      
      // const result = JSON.stringify(validScrapeResult);

      // fs.writeFileSync("debug/validScrapeResult.json", result);
      const currentTicketCount = validScrapeResult.reduce(
        (sum, group) => sum + (group.inventory?.quantity || 0), 0
      );

        // Quick update of basic info
        await Event.updateOne(
          { Event_ID: eventId },
          {
            $set: {
              Available_Seats: currentTicketCount,
              Last_Updated: new Date(), // Ensure Last_Updated is always set to now
              "metadata.lastUpdate": new Date(),
              "metadata.ticketCount": currentTicketCount,
            },
          }
        ).session(session);

      const LOG_LEVEL =
        global.config && typeof global.config.LOG_LEVEL !== "undefined"
          ? global.config.LOG_LEVEL
          : process.env.LOG_LEVEL || 2;

      if (validScrapeResult?.length > 0) {
          // Fetch existing groups for efficient row-level comparison - always fresh data
          const existingGroups = await ConsecutiveGroup.find(
            { eventId },
            {
              _id: 1,
              section: 1,
              row: 1,
              seats: 1,
              seatCount: 1,
              "inventory.listPrice": 1,
              "inventory.quantity": 1,
              "inventory.inventoryId": 1,
            }
          ).session(session).read('primary'); // Force read from primary for fresh data

        // Create maps for efficient lookups
        const existingRowMap = new Map();
        existingGroups.forEach((group) => {
          // Extract seat numbers and ensure they're all strings for consistent comparison
          const extractedSeats = group.seats
            .map((s) => {
              // Handle different possible seat formats
              let seatNumber;
              if (typeof s === "object" && s !== null) {
                seatNumber = s.number;
              } else {
                seatNumber = s;
              }
              // Ensure seat number is a string
              return String(seatNumber);
            })
            .sort(); // Sort lexicographically as strings

          // Create unique rowKey that includes seat range to avoid conflicts
          const seatRange = extractedSeats.length > 0 ? `${extractedSeats[0]}-${extractedSeats[extractedSeats.length - 1]}` : 'no-seats';
          const rowKey = `${group.section}-${group.row}-${seatRange}`;

          existingRowMap.set(rowKey, {
            _id: group._id,
            seatCount: group.seatCount,
            seats: extractedSeats,
            price: group.inventory?.listPrice,
            quantity: group.inventory?.quantity,
            inventoryId: group.inventory?.inventoryId,
          });
        });

        const newRowMap = new Map();
        validScrapeResult.forEach((group) => {
          // Extract seat numbers and ensure they're all strings for consistent comparison
          const extractedSeats = group.seats
            .map((s) => {
              // Handle different possible seat formats
              let seatNumber;
              if (typeof s === "object" && s !== null && "number" in s) {
                seatNumber = s.number;
              } else {
                seatNumber = s;
              }
              // Ensure seat number is a string
              return String(seatNumber);
            })
            .sort(); // Sort lexicographically as strings

          // Create unique rowKey that includes seat range to avoid conflicts
          const seatRange = extractedSeats.length > 0 ? `${extractedSeats[0]}-${extractedSeats[extractedSeats.length - 1]}` : 'no-seats';
          const rowKey = `${group.section}-${group.row}-${seatRange}`;
          
          const basePrice = parseFloat(group.inventory.listPrice);
          const increasedPrice = basePrice < 35 
            ? basePrice + 15 
            : basePrice * (1 + priceIncreasePercentage / 100);

          newRowMap.set(rowKey, {
            seatCount: group.inventory.quantity,
            seats: extractedSeats, // Use the normalized and sorted array
            price: increasedPrice,
            quantity: group.inventory.quantity,
            groupData: group,
          });
        });

     

        // Identify rows to delete or update
        for (const [rowKey, existingData] of existingRowMap) {
          const newData = newRowMap.get(rowKey);

          if (!newData) {
            // Row no longer exists in new data - mark for deletion
            rowsToDelete.push(existingData._id);
          } else {
            // Helper to compare two arrays of strings (already normalized and sorted)
            const areArraysEqual = (arr1, arr2) => {
              if (arr1.length !== arr2.length) {
                return false;
              }

              // Since we've already normalized to strings and sorted, we can do a direct comparison
              for (let i = 0; i < arr1.length; i++) {
                if (arr1[i] !== arr2[i]) {
                  return false;
                }
              }

              return true;
            };

            // Check if row data has changed (excluding inventory ID)
            const seatsChanged = !areArraysEqual(
              existingData.seats,
              newData.seats
            );

            const existingPrice = parseFloat(existingData.price);
            const newPrice = parseFloat(newData.price);
            const priceChanged = Math.abs(existingPrice - newPrice) > 0.01;
            const quantityChanged =
              Number(existingData.quantity) !== Number(newData.quantity);

            // Always preserve the existing inventory ID for updates
            // Only generate new inventory IDs for truly new inventory or deleted/re-added rows
            newData.groupData.inventory.inventoryId = existingData.inventoryId;

            // Now, decide if the DB record needs an update for any of these fields
             // Force delete-and-insert for all changes to ensure fresh inventory IDs
             if (seatsChanged || priceChanged || quantityChanged) {
               rowsToDelete.push(existingData._id);
               rowsToInsert.push({ rowKey, data: newData });
             } else {
              // This 'else' implies:
              // 1. !seatsChanged && !priceChanged (so inventoryId was preserved)
              // 2. AND !quantityChanged (so no other tracked change)
              // Therefore, truly no changes to the row data itself.
              unchangedRows++;
            }
          }
        }

        // Identify new rows to insert
        for (const [rowKey, newData] of newRowMap) {
          if (!existingRowMap.has(rowKey)) {
            rowsToInsert.push({ rowKey, data: newData });
          }
        }

        // Log database operation summary at level 3
        if (LOG_LEVEL >= 3) {
          this.logWithTime(
            `[Debug SM ${eventId}] Database operation summary: ${rowsToDelete.length} to delete, ${rowsToUpdate.length} to update, ${rowsToInsert.length} to insert, ${unchangedRows} unchanged`,
            "debug"
          );
        }
        // Console log only when there are actual DB changes
        if (rowsToDelete.length > 0 || rowsToUpdate.length > 0 || rowsToInsert.length > 0) {
          console.log(`[DB OPS ${eventId}] ${rowsToDelete.length}D ${rowsToUpdate.length}U ${rowsToInsert.length}I (${unchangedRows} unchanged)`);
        }

        // Perform efficient updates only if there are changes
        if (
          rowsToDelete.length > 0 ||
          rowsToInsert.length > 0 ||
          rowsToUpdate.length > 0
        ) {
          // const result = JSON.stringify(rowsToInsert);

          // fs.writeFileSync("debug/rowsToInsert.json", result);
            // Delete removed rows
            if (rowsToDelete.length > 0) {
              // First, get inventory IDs for external API deletion
              const groupsToDelete = await ConsecutiveGroup.find({
                _id: { $in: rowsToDelete }
              }, { 'inventory.inventoryId': 1 }).session(session);
              
              const inventoryIdsToDelete = groupsToDelete
                .map(group => group.inventory?.inventoryId)
                .filter(id => id) // Filter out null/undefined IDs
                .map(id => String(id)); // Convert to strings for API

              // Delete from database first
              await ConsecutiveGroup.deleteMany({
                _id: { $in: rowsToDelete },
              }).session(session);

              // Then delete from external API if we have inventory IDs
              if (inventoryIdsToDelete.length > 0) {
                try {
                  const apiDeleteResult = await this.inventoryApi.deleteInventoryBatch(
                    inventoryIdsToDelete
                  );

                  if (LOG_LEVEL >= 3) {
                    this.logWithTime(
                      `[Debug SM ${eventId}] External API deletion: ${apiDeleteResult.successful.length} successful, ${apiDeleteResult.failed.length} failed`,
                      "debug"
                    );
                  }
                  console.log(`[API DELETE ${eventId}] External API: ${apiDeleteResult.successful.length} successful, ${apiDeleteResult.failed.length} failed`);
                } catch (apiError) {
                  console.error(`[API DELETE ERROR ${eventId}] Failed to delete inventories via API:`, apiError.message);
                  if (LOG_LEVEL >= 1) {
                    this.logWithTime(
                      `[Warning SM ${eventId}] External API deletion failed: ${apiError.message}`,
                      "warning"
                    );
                  }
                }
              }

            if (LOG_LEVEL >= 2) {
              this.logWithTime(
                `[Info SM ${eventId}] Deleted ${rowsToDelete.length} removed rows.`,
                "info"
              );
            }
            if (LOG_LEVEL >= 3) {
              this.logWithTime(
                `[Debug SM ${eventId}] DELETE operation completed: ${rowsToDelete.length} rows removed from database`,
                "debug"
              );
            }
          }

          // Handle updates by deleting existing inventory and adding new ones
          if (rowsToUpdate.length > 0) {
            // First, get inventory IDs for external API deletion
            const groupsToUpdate = await ConsecutiveGroup.find({
              _id: { $in: rowsToUpdate.map(row => row._id) }
            }, { 'inventory.inventoryId': 1 }).session(session);
            
            const inventoryIdsToUpdate = groupsToUpdate
              .map(group => group.inventory?.inventoryId)
              .filter(id => id) // Filter out null/undefined IDs
              .map(id => String(id)); // Convert to strings for API

            // Delete existing inventory from database first
            await ConsecutiveGroup.deleteMany({
              _id: { $in: rowsToUpdate.map(row => row._id) },
            }).session(session);

            // Then delete from external API if we have inventory IDs
            if (inventoryIdsToUpdate.length > 0) {
              try {
                const apiDeleteResult = await this.inventoryApi.deleteInventoryBatch(inventoryIdsToUpdate);
                if (LOG_LEVEL >= 3) {
                  this.logWithTime(
                    `[Debug SM ${eventId}] External API deletion for updates: ${apiDeleteResult.successful.length} successful, ${apiDeleteResult.failed.length} failed`,
                    "debug"
                  );
                }
                console.log(`[API DELETE UPDATE ${eventId}] External API: ${apiDeleteResult.successful.length} successful, ${apiDeleteResult.failed.length} failed`);
              } catch (apiError) {
                console.error(`[API DELETE UPDATE ERROR ${eventId}] Failed to delete inventories via API:`, apiError.message);
                if (LOG_LEVEL >= 1) {
                  this.logWithTime(
                    `[Warning SM ${eventId}] External API deletion for updates failed: ${apiError.message}`,
                    "warning"
                  );
                }
              }
            }

            // Now prepare new inventory items to insert
            const newInventoryItems = rowsToUpdate.map(({ data }) => {
              const group = data.groupData;
              const eventDateObj =
                typeof event_date === "string"
                  ? new Date(event_date)
                  : event_date;
              const inHandDateObj = moment(eventDateObj).subtract(1, "day");
              const formattedInHandDate = inHandDateObj.toISOString();
              const increasedPrice = data.price;

              return {
                eventId,
                mapping_id,
                event_name,
                venue_name,
                event_date: eventDateObj.toISOString(),
                inHandDate: formattedInHandDate,
                section: group.section,
                row: group.row,
                seatCount: group.inventory.quantity,
                seatRange: `${Math.min(...group.seats)}-${Math.max(
                  ...group.seats
                )}`,
                seats: group.seats.map((seatNumber) => ({
                  number: seatNumber.toString(),
                  inHandDate: formattedInHandDate,
                  price: increasedPrice,
                  mapping_id,
                })),
                inventory: {
                  inventoryId: generateUniqueInventoryId(), // Always generate new inventory ID for updates
                  quantity: group.inventory.quantity,
                  section: group.section,
                  hideSeatNumbers: group.inventory.hideSeatNumbers || true,
                  row: group.row,
                  cost: group.inventory.cost,
                  stockType: group.inventory.stockType || "MOBILE_TRANSFER",
                  lineType: group.inventory.lineType,
                  seatType: group.inventory.seatType,
                  inHandDate: formattedInHandDate,
                  notes: group.inventory.notes,
                  tags: group.inventory.tags,
                  offerId: group.inventory.offerId,
                  splitType: group.inventory.splitType || "CUSTOM",
                  publicNotes: group.inventory.publicNotes,
                  listPrice: increasedPrice,
                  face_price: group.inventory.faceValue,
                  taxed_cost: group.inventory.taxedCost,
                  cost: group.inventory.cost,
                  hide_seats: group.inventory.hideSeatNumbers || true,
                  in_hand:
                    typeof group.inventory.inHand === "boolean"
                      ? group.inventory.inHand
                      : true,
                  in_hand_date: formattedInHandDate,
                  instant_transfer:
                    typeof group.inventory.instantTransfer === "boolean"
                      ? group.inventory.instantTransfer
                      : false,
                  files_available:
                    typeof group.inventory.filesAvailable === "boolean"
                      ? group.inventory.filesAvailable
                      : false,
                  customSplit:
                    group.inventory.customSplit ||
                    `${Math.ceil(group.inventory.quantity / 2)},${
                      group.inventory.quantity
                    }`,
                  stock_type: group.inventory.stockType || "MOBILE_TRANSFER",
                  zone: group.inventory.zone,
                  shown_quantity: group.inventory.shownQuantity,
                  passthrough: group.inventory.passthrough,
                  mapping_id,
                  event_name: event_name,
                  venue_name: venue_name,
                  event_date: eventDateObj.toISOString(),
                  eventId: eventId,
                  tickets: group.inventory.tickets.map((ticket) => ({
                    id: ticket.id,
                    seatNumber: ticket.seatNumber,
                    notes: ticket.notes,
                    cost: ticket.cost,
                    faceValue: ticket.faceValue,
                    taxedCost: ticket.taxedCost,
                    sellPrice:
                      typeof ticket?.sellPrice === "number" &&
                      !isNaN(ticket?.sellPrice)
                        ? ticket.sellPrice
                        : parseFloat(
                            ticket?.cost || ticket?.faceValue || 0
                          ),
                    stockType: ticket.stockType,
                    eventId: ticket.eventId,
                    accountId: ticket.accountId,
                    status: ticket.status,
                    auditNote: ticket.auditNote,
                    mapping_id: mapping_id,
                  })),
                },
              };
            });

            // Insert new inventory items in batches
            const BATCH_SIZE = 100;
            for (let i = 0; i < newInventoryItems.length; i += BATCH_SIZE) {
              const batch = newInventoryItems.slice(i, i + BATCH_SIZE);
              try {
                await ConsecutiveGroup.insertMany(batch, { ordered: false, session: session });
              } catch (error) {
                console.error(
                  `[ERROR] Event ${eventId} - Failed to insert updated ConsecutiveGroup batch:`,
                  error.message
                );
              }
            }

            if (LOG_LEVEL >= 2) {
              this.logWithTime(
                `[Info SM ${eventId}] Updated ${rowsToUpdate.length} rows by delete-and-insert with new inventory IDs.`,
                "info"
              );
            }
            if (LOG_LEVEL >= 3) {
              this.logWithTime(
                `[Debug SM ${eventId}] UPDATE operation completed: ${rowsToUpdate.length} rows deleted and re-inserted with new inventory IDs`,
                "debug"
              );
            }
            // DB UPDATE log already covered by summary above
          }

          // Insert new/updated rows with new inventory IDs
          if (rowsToInsert.length > 0) {
            const groupsToInsert = rowsToInsert.map(({ data }) => {
              const group = data.groupData;
              // Convert event_date to Date object if it's a string and subtract one day
              const eventDateObj =
                typeof event_date === "string"
                  ? new Date(event_date)
                  : event_date;
              const inHandDateObj = moment(eventDateObj).subtract(1, "day");
              const formattedInHandDate = inHandDateObj.toISOString();

              const increasedPrice = data.price;
              return {
                eventId,
                mapping_id,
                event_name,
                venue_name,
                event_date: eventDateObj.toISOString(),
                inHandDate: formattedInHandDate,
                section: group.section,
                row: group.row,
                seatCount: group.inventory.quantity,
                seatRange: `${Math.min(...group.seats)}-${Math.max(
                  ...group.seats
                )}`,
                seats: group.seats.map((seatNumber) => ({
                  number: seatNumber.toString(),
                  inHandDate: formattedInHandDate,
                  price: increasedPrice,
                  mapping_id,
                })),
                inventory: {
                  inventoryId:
                    group.inventory.inventoryId || generateUniqueInventoryId(), // Use preserved ID if available, otherwise generate new one
                  quantity: group.inventory.quantity,
                  section: group.section,
                  hideSeatNumbers: group.inventory.hideSeatNumbers || true,
                  row: group.row,
                  cost: group.inventory.cost,
                  stockType: group.inventory.stockType || "MOBILE_TRANSFER",
                  lineType: group.inventory.lineType,
                  seatType: group.inventory.seatType,
                  inHandDate: formattedInHandDate,
                  notes: group.inventory.notes,
                  tags: group.inventory.tags,
                  offerId: group.inventory.offerId,
                  splitType: group.inventory.splitType || "CUSTOM",
                  publicNotes: group.inventory.publicNotes,
                  listPrice: increasedPrice,
                  face_price: group.inventory.faceValue,
                  taxed_cost: group.inventory.taxedCost,
                  cost: group.inventory.cost,
                  hide_seats: group.inventory.hideSeatNumbers || true,
                  in_hand:
                    typeof group.inventory.inHand === "boolean"
                      ? group.inventory.inHand
                      : true,
                  in_hand_date: formattedInHandDate,
                  instant_transfer:
                    typeof group.inventory.instantTransfer === "boolean"
                      ? group.inventory.instantTransfer
                      : false,
                  files_available:
                    typeof group.inventory.filesAvailable === "boolean"
                      ? group.inventory.filesAvailable
                      : false,
                  customSplit:
                    group.inventory.customSplit ||
                    `${Math.ceil(group.inventory.quantity / 2)},${
                      group.inventory.quantity
                    }`,
                  stock_type: group.inventory.stockType || "MOBILE_TRANSFER",
                  zone: group.inventory.zone,
                  shown_quantity: group.inventory.shownQuantity,
                  passthrough: group.inventory.passthrough,
                  mapping_id,
                  event_name: event_name,
                  venue_name: venue_name,
                  event_date: eventDateObj.toISOString(),
                  eventId: eventId,
                  tickets: group.inventory.tickets.map((ticket) => ({
                    id: ticket.id,
                    seatNumber: ticket.seatNumber,
                    notes: ticket.notes,
                    cost: ticket.cost,
                    faceValue: ticket.faceValue,
                    taxedCost: ticket.taxedCost,
                    sellPrice:
                      typeof ticket?.sellPrice === "number" &&
                      !isNaN(ticket?.sellPrice)
                        ? ticket.sellPrice
                        : parseFloat(ticket?.cost || ticket?.faceValue || 0),
                    stockType: ticket.stockType,
                    eventId: ticket.eventId,
                    accountId: ticket.accountId,
                    status: ticket.status,
                    auditNote: ticket.auditNote,
                    mapping_id: mapping_id,
                  })),
                },
              };
            });
            
            // Insert in batches for performance
            const BATCH_SIZE = 500;
            for (let i = 0; i < groupsToInsert.length; i += BATCH_SIZE) {
              const batch = groupsToInsert.slice(i, i + BATCH_SIZE);
              try {
                await ConsecutiveGroup.insertMany(batch, { ordered: false, session: session });
              } catch (error) {
                console.error(
                  `[ERROR] Event ${eventId} - Failed to insert ConsecutiveGroup batch:`,
                  error.message
                );
                // Log specific duplicate key errors for debugging
                // Duplicate key errors are expected during concurrent processing — skip verbose logging
                // Continue with next batch even if this one fails
              }
            }
 
            if (LOG_LEVEL >= 2) {
              this.logWithTime(
                `[Info SM ${eventId}] Inserted ${groupsToInsert.length} new/updated rows with new inventory IDs.`,
                "info"
              );
            }
            if (LOG_LEVEL >= 3) {
              this.logWithTime(
                `[Debug SM ${eventId}] INSERT operation completed: ${groupsToInsert.length} new rows added to database`,
                "debug"
              );
            }
            console.log(`[DB INSERT ${eventId}] Added ${groupsToInsert.length} new rows to database`);
          }
        }
      }

      // Update schedule
      this.eventUpdateSchedule.set(
        eventId,
        moment().add(MIN_TIME_BETWEEN_EVENT_SCRAPES, "milliseconds")
      );

      // Make sure to properly update the timestamp in memory as well
      this.eventUpdateTimestamps.set(eventId, moment());

      // Also update the last processed time to prevent immediate reprocessing
      this.eventLastProcessedTime.set(eventId, Date.now());

        if (LOG_LEVEL >= 3) {
          // Provide a final summary of all database operations performed
          const totalOperations = (rowsToDelete?.length || 0) + (rowsToUpdate?.length || 0) + (rowsToInsert?.length || 0);
          const operationSummary = totalOperations > 0 
            ? `${totalOperations} total database operations performed` 
            : 'no database changes needed';
          
          this.logWithTime(
            `[Debug SM ${eventId}] Event processing completed in ${(
              performance.now() - startTime
            ).toFixed(2)}ms - ${operationSummary}`,
            "debug"
          );
        }
        // Event completion - only log slow events (>5s) or events with DB ops
        const totalOps = (rowsToDelete?.length || 0) + (rowsToUpdate?.length || 0) + (rowsToInsert?.length || 0);
        const elapsed = (performance.now() - startTime).toFixed(0);
        if (totalOps > 0 || elapsed > 5000) {
          console.log(`[DONE ${eventId}] ${elapsed}ms - ${totalOps > 0 ? `${totalOps} ops` : 'slow'}`);
        }
        });
    } catch (error) {
      await this.logError(eventId, "DATABASE_ERROR", error);
      throw error;
    } finally {
      await session.endSession();
    }
  }

  // CSV generation method removed

  /**
   * Get a random event ID for session/cookie management
   * This ensures we never use the actual event ID for cookies
   */
  async getRandomEventId(originalEventId) {
    try {
      // Try to get random events from database
      const randomEvents = await Event.aggregate([
        {
          $match: {
            Skip_Scraping: { $ne: true },
            url: { $exists: true, $ne: "" },
            Event_ID: { $ne: originalEventId }, // Explicitly exclude the original event ID
          },
        },
        { $sample: { size: 3 } },
        { $project: { Event_ID: 1 } },
      ]);

      if (randomEvents && randomEvents.length > 0) {
        const randomIndex = Math.floor(Math.random() * randomEvents.length);
        return randomEvents[randomIndex].Event_ID;
      }

      // Fallback options if database query fails
      if (this.failedEvents.size > 0) {
        const failedEventsArray = Array.from(this.failedEvents);
        const filtered = failedEventsArray.filter(
          (id) => id !== originalEventId
        );
        if (filtered.length > 0) {
          return filtered[Math.floor(Math.random() * filtered.length)];
        }
      }

      if (this.activeJobs.size > 0) {
        const activeJobsArray = Array.from(this.activeJobs.keys());
        const filtered = activeJobsArray.filter((id) => id !== originalEventId);
        if (filtered.length > 0) {
          return filtered[Math.floor(Math.random() * filtered.length)];
        }
      }

      // Last resort: use a previously successful event ID from the cache or retry database query
      if (this.headerRefreshTimestamps.size > 0) {
        // Use any existing event ID that has a valid timestamp
        const cachedEvents = Array.from(this.headerRefreshTimestamps.keys());
        const validCachedEvents = cachedEvents.filter(
          (id) => id !== originalEventId
        );
        if (validCachedEvents.length > 0) {
          return validCachedEvents[
            Math.floor(Math.random() * validCachedEvents.length)
          ];
        }
      }

      // If all else fails, retry the database query with broader criteria
      try {
        const fallbackEvents = await Event.aggregate([
          { $match: { url: { $exists: true } } },
          { $sample: { size: 5 } },
          { $project: { Event_ID: 1 } },
        ]);

        if (fallbackEvents && fallbackEvents.length > 0) {
          return fallbackEvents[
            Math.floor(Math.random() * fallbackEvents.length)
          ].Event_ID;
        }
      } catch (retryError) {
        this.logWithTime(
          `Retry database query failed: ${retryError.message}`,
          "warning"
        );
      }

      // Absolute last resort: return the original event ID
      return originalEventId;
    } catch (error) {
      this.logWithTime(
        `Error getting random event ID: ${error.message}`,
        "warning"
      );
      return originalEventId;
    }
  }

  // Removed duplicate scrapeEvent function - using optimized version below

  /**
   * Calculate adaptive pause time for sequential processing
   * @returns {number} Pause time in milliseconds
   */
  getAdaptivePauseTime() {
    // Minimal pause for high-performance processing
    let pauseTime = 10; // Reduced from 200ms to 10ms

    // Only add significant pause if system is overloaded
    const activeJobCount = this.activeJobs.size;
    const failedEventCount = this.failedEvents.size;

    // Only throttle if we have many active jobs
    if (activeJobCount > config.CONCURRENT_LIMIT * 0.8) {
      pauseTime += 50;
    }

    // Add small pause for failed events
    if (failedEventCount > 100) {
      pauseTime += 20;
    }

    // Circuit breaker logic removed

    return Math.min(pauseTime, 200); // Cap at 200ms max
  }

  // Add handleApiError method to fix the reported error
  async handleApiError(eventId, error, headers) {
    // Check if this is a status code error that needs special handling
    const is403Error =
      error.message.includes("403") || error.message.includes("Forbidden");
    const is429Error =
      error.message.includes("429") ||
      error.message.includes("Too Many Requests");
    const is400Error =
      error.message.includes("400") || error.message.includes("Bad Request");

    // Handle rate limiting and access denied errors
    if (is403Error || is429Error || is400Error) {
      // API circuit breaker logic removed

      // Try rotating proxy (just get a new one, no blocking)
      if (this.proxyManager.getAvailableProxyCount() > 1) {
        if (LOG_LEVEL >= 2) {
          this.logWithTime(
            `Getting new proxy for event ${eventId} due to ${
              is403Error ? "403" : "429"
            } error`,
            "info"
          );
        }

        // Just release the proxy to get a new one next time
        this.proxyManager.releaseProxy(eventId, false);
        return true; // Error handled by proxy rotation
      }
    }

    return false; // Error not handled
  }

  /**
   * Asynchronously upload all_events_combined.csv file to Sync service (OPTIMIZED)
   * This runs every 6 minutes while continuous scraping is active
   * and doesn't block the main scraping process
   */

  /**
   * Stop the continuous scraping process and clean up resources
   * @returns {Promise<void>}
   */
  async stopContinuousScraping() {
    // Set the isRunning flag to false to stop the main scraping loop
    this.isRunning = false;

    this.logWithTime("Stopping continuous scraping process...", "info");

    // Sequential processing - no workers to wait for

    // Clear the cookie rotation interval if it exists
    if (this.cookieRotationIntervalId) {
      clearInterval(this.cookieRotationIntervalId);
      this.cookieRotationIntervalId = null;
      this.logWithTime("Cookie rotation cycle stopped", "info");
    }

    // CSV upload interval cleanup removed

    // Release any active proxies
    this.proxyManager.releaseAllProxies();

    // Close all open browser instances
    try {
      this.logWithTime("Closing browser instances...", "info");
      await cleanupBrowsers();
      this.logWithTime("Browser instances closed", "success");
    } catch (error) {
      this.logWithTime(`Error closing browsers: ${error.message}`, "error");
    }

    // Clear all processing queues
    this.eventProcessingQueue = [];
    this.processingEvents.clear();
    // No batch processing to clear

    this.logWithTime("Continuous scraping process stopped", "success");

    // Return runtime statistics
    const runTime = moment.duration(moment().diff(this.startTime));
    return {
      runtime: {
        hours: Math.floor(runTime.asHours()),
        minutes: runTime.minutes(),
        seconds: runTime.seconds(),
      },
      successCount: this.successCount,
      failedCount: this.failedEvents.size,
      totalEventsProcessed: this.eventLastProcessedTime.size,
    };
  }

  /**
   * Get recent failure count for an event
   * @param {string} eventId - The event ID
   * @returns {number} Number of recent failures
   */
  getRecentFailureCount(eventId) {
    const failures = this.eventFailureCounts.get(eventId) || [];
    const now = Date.now();
    const recentFailures = failures.filter(
      (failure) => now - failure.timestamp < 10 * 60 * 1000 // Last 10 minutes
    );
    return recentFailures.length;
  }

  /**
   * Increment failure count for an event
   * @param {string} eventId - The event ID
   */
  incrementFailureCount(eventId) {
    if (!this.eventFailureCounts.has(eventId)) {
      this.eventFailureCounts.set(eventId, []);
    }

    const failures = this.eventFailureCounts.get(eventId);
    failures.push({
      timestamp: Date.now(),
      count: failures.length + 1,
    });

    // Keep only recent failures (last 20)
    if (failures.length > 20) {
      failures.shift();
    }
  }

  /**
   * Clear failure count for an event
   * @param {string} eventId - The event ID
   */
  clearFailureCount(eventId) {
    this.eventFailureCounts.delete(eventId);
    this.eventFailureTimes.delete(eventId);

    // Clear from error tracker if available
    if (this.errorTracker && this.errorTracker.clearFailureCount) {
      this.errorTracker.clearFailureCount(eventId);
    }

    // Remove from processing locks if stuck
    this.processingLocks.delete(eventId);
    this.processingEvents.delete(eventId);
  }

  /**
   * Perform health check to monitor scraper performance and identify issues
   */
  performHealthCheck() {
    const now = Date.now();
    const fiveMinutesAgo = now - 300000;

    // Count stuck events
    const stuckEvents = Array.from(this.processingLocks.entries()).filter(
      ([_, lockTime]) => lockTime < fiveMinutesAgo
    ).length;

    // Count failed events
    const failedEventsCount = this.failedEvents.size;

    // Count processing queue size
    const processingQueueSize = this.eventProcessingQueue.length;

    // Calculate success rate
    const totalAttempts = this.successCount + failedEventsCount;
    const successRate =
      totalAttempts > 0
        ? ((this.successCount / totalAttempts) * 100).toFixed(1)
        : 0;

    // Log health status if there are issues
    if (stuckEvents > 0 || failedEventsCount > 10) {
      this.logWithTime(
        `🏥 Health Check: ${stuckEvents} stuck events, ${failedEventsCount} failed, ${processingQueueSize} processing, ${successRate}% success rate`,
        "warning"
      );
    } else {
      // Periodic positive health report
      if (now % 300000 < 60000) {
        // Every 5 minutes
        this.logWithTime(
          `✅ Health Check: System healthy - ${successRate}% success rate, ${processingQueueSize} events processing`,
          "info"
        );
      }
    }
  }

  /**
   * Categorize error type for grouping
   * @param {Error} error - The error object
   * @returns {string} Error category
   */
  categorizeError(error) {
    const message = error.message.toLowerCase();

    if (message.includes("403") || message.includes("forbidden")) {
      return "FORBIDDEN";
    } else if (message.includes("429") || message.includes("rate limit")) {
      return "RATE_LIMIT";
    } else if (message.includes("400") || message.includes("bad request")) {
      return "BAD_REQUEST";
    } else if (message.includes("timeout")) {
      return "TIMEOUT";
    } else if (message.includes("network") || message.includes("connection")) {
      return "NETWORK";
    } else if (message.includes("empty") || message.includes("null")) {
      return "EMPTY_RESULT";
    } else {
      return "OTHER";
    }
  }

  /**
   * Force periodic cookie and session rotation
   * Schedules automatic cookie and session refresh every 20 minutes
   */
  forcePeriodicCookieRotation() {
    // NO-OP: Cookie rotation removed. Browser page pool handles cookies
    // automatically by navigating to real event pages.
    return null;
  }

  /**
   * Rotates all cookies and sessions to ensure freshness
   */
  async rotateAllCookiesAndSessions() {
    // NO-OP: Cookie/session rotation removed. Browser page pool handles cookies.
    return true;
  }

  async _rotateAllCookiesAndSessions_DISABLED() {
    return new Promise(async (resolve) => {
      const rotationTimeout = global.setTimeout(() => {
        resolve(false);
      }, 120000);

      try {
        this.headersCache.clear();
        this.headerRefreshTimestamps.clear();

        // Rotate sessions via session manager with timeout
        try {
          const sessionPromise = this.sessionManager.forceSessionRotation();
          const sessionResult = await Promise.race([
            sessionPromise,
            setTimeout(30000).then(() => {
              throw new Error("Session rotation timed out after 30 seconds");
            }),
          ]);
          this.logWithTime("Successfully rotated all sessions", "success");
        } catch (sessionError) {
          this.logWithTime(
            `Error rotating sessions: ${sessionError.message}`,
            "error"
          );
          // Continue execution even after session error
        }

        // Force cookie reset with timeout
        try {
          const cookiePromise = this.resetCookiesAndHeaders();
          const cookieResult = await Promise.race([
            cookiePromise,
            setTimeout(30000).then(() => {
              throw new Error("Cookie reset timed out after 30 seconds");
            }),
          ]);
          this.logWithTime(
            "Successfully reset all cookies and headers",
            "success"
          );
        } catch (cookieError) {
          this.logWithTime(
            `Error resetting cookies: ${cookieError.message}`,
            "error"
          );
          // Continue execution even after cookie error
        }

        // Create multiple fresh test sessions to prime the cache
        try {
          // Get multiple random event IDs from the database with timeout
          const randomEventsPromise = Event.aggregate([
            {
              $match: {
                Skip_Scraping: { $ne: true },
                url: { $exists: true, $ne: "" },
              },
            },
            { $sample: { size: 5 } }, // Get 5 random events to create diversity
            { $project: { Event_ID: 1 } },
          ]);

          const randomEvents = await Promise.race([
            randomEventsPromise,
            setTimeout(10000).then(() => {
              throw new Error("Database query timed out after 10 seconds");
            }),
          ]);

          if (randomEvents && randomEvents.length > 0) {
            this.logWithTime(
              `Creating ${randomEvents.length} fresh test sessions with random events`,
              "info"
            );

            // Process each random event to create multiple fresh sessions
            const sessionPromises = [];
            for (const randomEvent of randomEvents) {
              const eventId = randomEvent.Event_ID;
              // Push each refresh promise to array but don't await
              sessionPromises.push(
                Promise.race([
                  this.refreshEventHeaders(eventId, true),
                  setTimeout(15000).then(() => {
                    throw new Error(`Header refresh timed out for ${eventId}`);
                  }),
                ])
                  .then(() =>
                    this.logWithTime(
                      `Created fresh test session using random event ${eventId}`,
                      "info"
                    )
                  )
                  .catch((err) =>
                    this.logWithTime(
                      `Error creating session for ${eventId}: ${err.message}`,
                      "warning"
                    )
                  )
              );

              // Small delay between starting refreshes
              await setTimeout(100);
            }

            // Wait for all session promises with overall timeout
            await Promise.race([
              Promise.allSettled(sessionPromises),
              setTimeout(60000).then(() => {
                throw new Error("Session creation timed out after 60 seconds");
              }),
            ]);
          } else {
            // Fallback to using cached event IDs if available
            if (this.headerRefreshTimestamps.size > 0) {
              const cachedEvents = Array.from(
                this.headerRefreshTimestamps.keys()
              );
              this.logWithTime(
                `No database events found, using ${Math.min(
                  3,
                  cachedEvents.length
                )} cached event IDs`,
                "warning"
              );

              // Use up to 3 cached event IDs with timeouts
              const fallbackPromises = [];
              const eventsToUse = cachedEvents.slice(0, 3);
              for (const cachedId of eventsToUse) {
                fallbackPromises.push(
                  Promise.race([
                    this.refreshEventHeaders(cachedId, true),
                    setTimeout(15000).then(() => {
                      throw new Error(
                        `Header refresh timed out for ${cachedId}`
                      );
                    }),
                  ])
                    .then(() =>
                      this.logWithTime(
                        `Created fresh test session using cached event ID ${cachedId}`,
                        "info"
                      )
                    )
                    .catch((err) =>
                      this.logWithTime(
                        `Error creating session for ${cachedId}: ${err.message}`,
                        "warning"
                      )
                    )
                );
                await setTimeout(100);
              }

              // Wait for all fallback promises with timeout
              await Promise.race([
                Promise.allSettled(fallbackPromises),
                setTimeout(45000).then(() => {
                  throw new Error(
                    "Fallback session creation timed out after 45 seconds"
                  );
                }),
              ]);
            } else {
              this.logWithTime(
                `No database events or cached events found, skipping test session creation`,
                "warning"
              );
            }
          }
        } catch (testError) {
          this.logWithTime(
            `Error creating test sessions: ${testError.message}`,
            "warning"
          );

          // Even on error, try with any available event ID from cache (with timeout)
          try {
            if (this.headerRefreshTimestamps.size > 0) {
              // Get any event ID from the cache
              const cachedEvents = Array.from(
                this.headerRefreshTimestamps.keys()
              );
              const fallbackId =
                cachedEvents[Math.floor(Math.random() * cachedEvents.length)];

              await Promise.race([
                this.refreshEventHeaders(fallbackId, true),
                setTimeout(15000).then(() => {
                  throw new Error(
                    `Final header refresh timed out for ${fallbackId}`
                  );
                }),
              ]);
              this.logWithTime(
                `Created fallback session after error using cached event ID ${fallbackId}`,
                "info"
              );
            } else {
              // Try a direct database query as last resort (with timeout)
              try {
                const fallbackEventPromise = Event.findOne()
                  .sort({ Last_Updated: 1 })
                  .limit(1)
                  .lean();
                const fallbackEvent = await Promise.race([
                  fallbackEventPromise,
                  setTimeout(10000).then(() => {
                    throw new Error(
                      "Final database query timed out after 10 seconds"
                    );
                  }),
                ]);

                if (fallbackEvent) {
                  await Promise.race([
                    this.refreshEventHeaders(fallbackEvent.Event_ID, true),
                    setTimeout(15000).then(() => {
                      throw new Error(
                        `Final header refresh timed out for ${fallbackEvent.Event_ID}`
                      );
                    }),
                  ]);
                  this.logWithTime(
                    `Created fallback session using database event ID ${fallbackEvent.Event_ID}`,
                    "info"
                  );
                } else {
                  this.logWithTime(
                    `No fallback events available, skipping session creation`,
                    "error"
                  );
                }
              } catch (dbError) {
                this.logWithTime(
                  `Final database fallback failed: ${dbError.message}`,
                  "error"
                );
              }
            }
          } catch (fallbackError) {
            this.logWithTime(
              `Failed to create fallback sessions: ${fallbackError.message}`,
              "error"
            );
          }
        }

        this.logWithTime("Cookie and session rotation complete", "success");
        clearTimeout(rotationTimeout);
        resolve(true);
      } catch (error) {
        this.logWithTime(`Error in cookie rotation: ${error.message}`, "error");
        clearTimeout(rotationTimeout);
        resolve(false);
      }
    });
  }

  /**
   * Start retry queue cleanup that runs every minute
   * Removes stale retry entries and expired cooldown events
   */
  // Retry queue cleanup methods removed

  // Helper method for retry events removed

  /**
   * Start parallel processing of events to update all within 3 minutes
   */
  async startConcurrentProcessing() {
    let consecutiveFailures = 0;
    let circuitBreakerOpen = false;
    let circuitBreakerOpenTime = 0;
    const CIRCUIT_BREAKER_THRESHOLD = 15; // Higher threshold for parallel mode
    const CIRCUIT_BREAKER_TIMEOUT = 10000; // 10 seconds before trying again

    while (this.isRunning) {
      try {
        // Circuit breaker logic - prevent cascading failures
        if (circuitBreakerOpen) {
          if (Date.now() - circuitBreakerOpenTime > CIRCUIT_BREAKER_TIMEOUT) {
            circuitBreakerOpen = false;
            consecutiveFailures = 0;
            this.logWithTime("Circuit breaker reset - resuming processing", "success");
          } else {
            await setTimeout(2000);
            continue;
          }
        }

        // Check if we should open circuit breaker
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !circuitBreakerOpen) {
          circuitBreakerOpen = true;
          circuitBreakerOpenTime = Date.now();
          this.logWithTime(
            `Circuit breaker opened due to ${consecutiveFailures} consecutive failures - pausing for ${CIRCUIT_BREAKER_TIMEOUT/1000}s`,
            "warning"
          );
          continue;
        }

        // Get events that need processing
        const eventsToProcess = await this.getEvents();

        if (eventsToProcess.length > 0) {
          // Filter out already-processing events
          const availableEvents = eventsToProcess.filter(
            (id) => !this.processingEvents.has(id)
          );

          if (availableEvents.length > 0) {
            // Split into batches of BATCH_SIZE for parallel processing
            const batchSize = config.BATCH_SIZE;
            const batches = [];
            for (let i = 0; i < availableEvents.length; i += batchSize) {
              batches.push(availableEvents.slice(i, i + batchSize));
            }

            this.logWithTime(
              `Processing ${availableEvents.length} events in ${batches.length} batches of ${batchSize} (parallel)`,
              "info"
            );

            // Process batches - run each batch in parallel, batches sequentially
            for (const batch of batches) {
              if (!this.isRunning) break;

              const batchResults = await Promise.allSettled(
                batch.map(async (eventId) => {
                  if (this.processingEvents.has(eventId)) return null;
                  this.processingEvents.add(eventId);

                  try {
                    const processingTimeout = config.SCRAPE_TIMEOUT + 10000;
                    const result = await Promise.race([
                      this.scrapeEventWithNaturalBehavior(eventId),
                      setTimeout(processingTimeout).then(() => {
                        throw new Error(`Processing timeout after ${processingTimeout}ms`);
                      }),
                    ]);
                    return { eventId, success: !!result, result };
                  } catch (error) {
                    return { eventId, success: false, error: error.message };
                  } finally {
                    this.processingEvents.delete(eventId);
                  }
                })
              );

              // Process results
              for (const settledResult of batchResults) {
                if (settledResult.status === "fulfilled" && settledResult.value) {
                  const { eventId, success, error } = settledResult.value;
                  if (success) {
                    this.eventLastProcessedTime.set(eventId, Date.now());
                    this.resetEventFailureTracking(eventId);
                    consecutiveFailures = 0;
                  } else {
                    if (error) {
                      this.logWithTime(`❌ Error processing event ${eventId}: ${error}`, "error");
                    }
                    await this.handleEventFailureGracefully(eventId);
                    consecutiveFailures++;
                  }
                } else if (settledResult.status === "rejected") {
                  consecutiveFailures++;
                }
              }

              // Small stagger delay between batches
              if (batches.indexOf(batch) < batches.length - 1) {
                await setTimeout(100 + Math.random() * 100);
              }

              // Break if circuit breaker should open
              if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                this.logWithTime(
                  `Too many failures (${consecutiveFailures}), opening circuit breaker`,
                  "warning"
                );
                break;
              }
            }
          }

          // Adaptive delay between processing cycles
          let nextCycleDelay = config.PROCESSING_INTERVAL;

          if (consecutiveFailures > 3) {
            nextCycleDelay = config.PROCESSING_INTERVAL * 2;
            this.logWithTime(
              `Slowing down due to ${consecutiveFailures} failures`,
              "warning"
            );
          } else if (consecutiveFailures === 0) {
            nextCycleDelay = Math.max(50, config.PROCESSING_INTERVAL * 0.5);
          }

          nextCycleDelay += Math.random() * 50;
          await setTimeout(nextCycleDelay);
        } else {
          // No events to process, wait before checking again
          await setTimeout(
            config.PROCESSING_INTERVAL * 2 + Math.random() * 1000
          );
        }

        // Emergency slowdown removed - multiple instances handle redundancy
      } catch (error) {
        this.logWithTime(
          `Concurrent processing error: ${error.message}`,
          "error"
        );
        consecutiveFailures++;

        // Exponential backoff on errors
        const errorDelay = Math.min(
          30000,
          config.PROCESSING_INTERVAL *
            Math.pow(2, Math.min(consecutiveFailures, 5))
        );
        await setTimeout(errorDelay);
      }
    }
  }

  /**
   * Handle event failure with graceful backoff and natural behavior
   */
  async handleEventFailureGracefully(eventId) {
    try {
      // Track failure count and timing
      const currentFailures = this.eventFailureCount.get(eventId) || 0;
      const newFailureCount = currentFailures + 1;
      const now = Date.now();

      this.eventFailureCount.set(eventId, newFailureCount);
      this.eventLastFailureTime.set(eventId, now);

      // FAST FAILURE RECOVERY - Minimal delays for scraping failures
      const baseDelay = 500; // Start with 0.5 seconds (was 2s)
      const maxDelay = 5000; // Max 5 seconds (was 2 minutes)

      // Minimal exponential backoff - fail fast, retry fast
      let backoffDelay = Math.min(
        maxDelay,
        baseDelay * Math.pow(1.2, newFailureCount) // Reduced multiplier from 1.4 to 1.2
      );

      // Minimal jitter (±10%) to prevent synchronized retries
      const jitter = backoffDelay * 0.1 * (Math.random() - 0.5); // Reduced from 30% to 10%
      backoffDelay = Math.max(200, backoffDelay + jitter); // Minimum 200ms (was 1000ms)

      // Reset failure count if it's been a while since last failure
      const lastFailureTime = this.eventLastFailureTime.get(eventId) || 0;
      if (now - lastFailureTime > 900000) {
        // 15 minutes
        this.eventFailureCount.set(eventId, 1);
        backoffDelay = baseDelay;
        this.logWithTime(
          `Resetting failure count for event ${eventId} due to time gap`,
          "info"
        );
      }

      // Don't give up - allow more retries with longer delays
      if (newFailureCount >= 20) {
        this.logWithTime(
          `Event ${eventId} has failed ${newFailureCount} times, using maximum delay but continuing`,
          "warning"
        );
        backoffDelay = maxDelay;
      }

      this.logWithTime(
        `⚠️ Event ${eventId} failed (${newFailureCount} failures), backing off for ${Math.round(
          backoffDelay / 1000
        )}s`,
        "warning"
      );

      // Add to cooldown with natural timing
      this.cooldownEvents.set(eventId, now + backoffDelay);
      this.incrementFailureCount(eventId);

      // Invalidate the session for this event to force a new session on retry
      if (this.sessionManager) {
        this.sessionManager.invalidateSessionForEvent(eventId);
      }
    } catch (error) {
      this.logWithTime(
        `Error in graceful failure handling for ${eventId}: ${error.message}`,
        "error"
      );
    }
  }

  /**
   * Handle event failure with intelligent backoff system (legacy compatibility)
   */
  async handleEventFailure(eventId, retryCount) {
    return this.handleEventFailureGracefully(eventId);
  }

  /**
   * Reset failure tracking when an event succeeds
   */
  resetEventFailureTracking(eventId) {
    this.eventFailureCount.delete(eventId);
    this.eventLastFailureTime.delete(eventId);
  }

  /**
   * Clean up old failure tracking data
   */
  cleanupFailureTracking() {
    const now = Date.now();
    const oneHourAgo = now - 3600000; // 1 hour

    // Clean up old failure times (reset after 1 hour)
    for (const [
      eventId,
      lastFailureTime,
    ] of this.eventLastFailureTime.entries()) {
      if (lastFailureTime < oneHourAgo) {
        this.eventFailureCount.delete(eventId);
        this.eventLastFailureTime.delete(eventId);
      }
    }

    // Circuit breaker cleanup removed
  }

  /**
   * Update system circuit breaker based on recent failures
   */
  // updateSystemCircuitBreaker method removed

  /**
   * Refresh the event queue with new events
   */
  async refreshEventQueue() {
    try {
      const events = await this.getEvents();

      // Add new events to queue
      for (const eventId of events) {
        if (
          !this.eventProcessingQueue.some(
            (item) =>
              (typeof item === "string" ? item : item.eventId) === eventId
          ) &&
          !this.processingEvents.has(eventId)
        ) {
          this.eventProcessingQueue.push(eventId);
        }
      }

      // Retry queue processing removed
    } catch (error) {
      this.logWithTime(
        `Error refreshing event queue: ${error.message}`,
        "error"
      );
    }
  }

  // processEventBatch method removed - using parallel batch processing

  /**
   * Process multiple batches of events in parallel for maximum throughput
   */
  async processMultipleBatches(allEvents, maxParallelBatches = 3) {
    if (!allEvents || allEvents.length === 0) {
      return null;
    }

    const batchSize = config.BATCH_SIZE;
    const batches = [];
    for (let i = 0; i < allEvents.length; i += batchSize) {
      batches.push(allEvents.slice(i, i + batchSize));
    }

    this.logWithTime(
      `Processing ${allEvents.length} events in ${batches.length} parallel batches of ${batchSize}`,
      "info"
    );

    let totalSuccessful = 0;
    let totalProcessed = 0;
    const startTime = Date.now();

    // Process up to maxParallelBatches batches at a time
    for (let i = 0; i < batches.length; i += maxParallelBatches) {
      if (!this.isRunning) break;

      const currentBatches = batches.slice(i, i + maxParallelBatches);
      const batchPromises = currentBatches.map((batch, idx) =>
        this.processSingleBatch(batch, i + idx)
      );

      const batchResults = await Promise.allSettled(batchPromises);

      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value) {
          totalSuccessful += result.value.successful;
          totalProcessed += result.value.processed;
        }
      }

      // Small stagger between batch groups
      if (i + maxParallelBatches < batches.length) {
        await setTimeout(50 + Math.random() * 100);
      }
    }

    const processingTime = Date.now() - startTime;
    const overallSuccessRate = totalProcessed > 0 ? totalSuccessful / totalProcessed : 0;

    this.logWithTime(
      `Parallel processing completed: ${totalSuccessful}/${totalProcessed} successful (${Math.round(overallSuccessRate * 100)}%) in ${processingTime}ms`,
      overallSuccessRate > 0.7 ? "success" : "warning"
    );

    return {
      successful: totalSuccessful,
      processed: totalProcessed,
      successRate: overallSuccessRate,
      remainingEvents: [],
    };
  }

  /**
   * Process a single batch of events in parallel using Promise.allSettled
   */
  async processSingleBatch(batch, batchIndex = 0) {
    const startTime = Date.now();
    let successful = 0;
    let processed = 0;

    const results = await Promise.allSettled(
      batch.map(async (eventId) => {
        if (this.processingEvents.has(eventId)) {
          return { eventId, skipped: true };
        }

        this.processingEvents.add(eventId);
        processed++;

        try {
          const result = await Promise.race([
            this.scrapeEventWithNaturalBehavior(eventId),
            setTimeout(config.SCRAPE_TIMEOUT + 5000).then(() => {
              throw new Error(`Batch processing timeout`);
            }),
          ]);

          if (result) {
            this.eventLastProcessedTime.set(eventId, Date.now());
            this.resetEventFailureTracking(eventId);
            successful++;
            return { eventId, success: true };
          } else {
            await this.handleEventFailureGracefully(eventId);
            return { eventId, success: false };
          }
        } catch (error) {
          await this.handleEventFailureGracefully(eventId);
          return { eventId, success: false, error: error.message };
        } finally {
          this.processingEvents.delete(eventId);
        }
      })
    );

    const processingTime = Date.now() - startTime;

    this.logWithTime(
      `Batch ${batchIndex + 1} completed: ${successful}/${processed} successful in ${processingTime}ms`,
      successful === processed ? "success" : "warning"
    );

    return { successful, processed, processingTime };
  }

  /**
   * Enhanced scrape event method with natural behavior patterns
   */
  async scrapeEventWithNaturalBehavior(eventId) {
    const startTime = Date.now();
    let proxyAgent = null;
    let proxy = null;

    try {
      // Check if we should skip due to recent processing
      const lastProcessed = this.eventLastProcessedTime.get(eventId);
      const minInterval = 3000 + Math.random() * 2000; // 3-5 seconds
      if (lastProcessed && Date.now() - lastProcessed < minInterval) {
        this.logWithTime(
          `Skipping event ${eventId} - processed recently`,
          "info"
        );
        return true;
      }

      // Check cooldown with some tolerance
      const cooldownEnd = this.cooldownEvents.get(eventId);
      if (cooldownEnd && Date.now() < cooldownEnd) {
        const remainingCooldown = Math.round((cooldownEnd - Date.now()) / 1000);
        this.logWithTime(
          `Event ${eventId} still in cooldown for ${remainingCooldown}s`,
          "info"
        );
        return false;
      }

      // Get proxy with retry logic
      let proxyAttempts = 0;
      const maxProxyAttempts = 3;

      while (proxyAttempts < maxProxyAttempts && !proxy) {
        try {
          const proxyData = this.proxyManager.getProxyForEvent(eventId);
          if (proxyData) {
            const proxyAgentData =
              this.proxyManager.createProxyAgent(proxyData);
            proxyAgent = proxyAgentData.proxyAgent;
            proxy = proxyAgentData.proxy;
            this.proxyManager.assignProxyToEvent(eventId, proxy.proxy);
            break;
          }
        } catch (proxyError) {
          proxyAttempts++;
          this.logWithTime(
            `Proxy attempt ${proxyAttempts} failed for ${eventId}: ${proxyError.message}`,
            "warning"
          );
          if (proxyAttempts < maxProxyAttempts) {
            await setTimeout(300 * proxyAttempts); // Quick progressive delay
          }
        }
      }

      if (!proxy) {
        throw new Error("Failed to obtain proxy after multiple attempts");
      }

      // No header/cookie refresh needed — browser page pool has authentic cookies.
      // Just pass the event directly to ScrapeEvent.
      const eventWithNaturalSession = {
        eventId: eventId,
        headers: null, // Not needed — browser pool handles cookies & headers
        sessionId: `pool-${eventId}-${Date.now()}`,
        proxyId: proxy?.proxy || "default",
        processingStart: startTime,
        naturalBehavior: true,
      };

      // Perform scrape with timeout
      const extendedTimeout = (config.SCRAPE_TIMEOUT || 30000) + 5000; // Extra 5s

      const result = await Promise.race([
        this.throttledScrapeEvent(eventWithNaturalSession, proxyAgent, proxy),
        setTimeout(extendedTimeout).then(() => {
          throw new Error(`Natural scrape timeout after ${extendedTimeout}ms`);
        }),
      ]);

      // Validate result with more lenient criteria
      if (!result) {
        throw new Error("No result returned from scrape");
      }

      if (Array.isArray(result) && result.length === 0) {
        // Empty results should be treated as failures
        throw new Error("Event returned empty results - treating as failed");
      }

      // Update metadata and tracking (sets eventUpdateTimestamps + eventLastProcessedTime internally)
      await this.updateEventMetadataAsync(eventId, result);

      // Success tracking
      this.successCount++;
      this.lastSuccessTime = moment();
      this.resetEventFailureTracking(eventId);
      this.failedEvents.delete(eventId);
      this.clearFailureCount(eventId);

      // Release proxy with success flag
      if (proxy) {
        this.proxyManager.releaseProxy(eventId, true);
      }

      const processingTime = Date.now() - startTime;
      this.logWithTime(
        `✅ Natural processing completed for ${eventId} in ${processingTime}ms`,
        "success"
      );

      return result;
    } catch (error) {
      // Enhanced error handling with context
      const processingTime = Date.now() - startTime;
      
      // Check if this is a seat count fluctuation error
      if (error.isFluctuationError) {
        const trendInfo = error.trendCheck ? ` (${error.trendCheck})` : '';
        this.logWithTime(
          `⚠️ Seat count fluctuation detected for ${eventId}: ${error.previousCount} → ${error.seatCount} seats${trendInfo}. Delaying for 30s`,
          "warning"
        );
        
        // Add event to cooldown with the delay time
        const delayUntil = error.delayUntil || (Date.now() + 30000);
        this.cooldownEvents.set(eventId, delayUntil);
        
        // Release proxy but don't mark as failed
        if (proxy) {
          this.proxyManager.releaseProxy(eventId, true); // Mark as success to not penalize proxy
        }
        
        // Return false to retry later, but don't count as a failure
        return false;
      }
      
      this.logWithTime(
        `❌ Natural processing failed for ${eventId} after ${processingTime}ms: ${error.message}`,
        "error"
      );

      // Release proxy on failure
      if (proxy) {
        this.proxyManager.releaseProxy(eventId, false);
      }

      // Don't immediately fail - let the graceful handler decide
      return false;
    }
  }

  /**
   * Get a random user agent for natural behavior
   */
  getRandomUserAgent() {
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  /**
   * Optimized scrape event method for parallel processing (legacy compatibility)
   */
  async scrapeEvent(eventId, retryCount = 0, sharedHeaders = null) {
    // Check if we should skip
    const lastProcessed = this.eventLastProcessedTime.get(eventId);
    if (lastProcessed && Date.now() - lastProcessed < 30000) {
      return true; // Skip if processed in last 30 seconds
    }

    let proxyAgent = null;
    let proxy = null;

    try {
      // Retry logic removed

      // Get a unique proxy for this specific event
      try {
        const proxyData = this.proxyManager.getProxyForEvent(eventId);
        if (proxyData) {
          const proxyAgentData = this.proxyManager.createProxyAgent(proxyData);
          proxyAgent = proxyAgentData.proxyAgent;
          proxy = proxyAgentData.proxy;

          // Track proxy assignment
          this.proxyManager.assignProxyToEvent(eventId, proxy.proxy);
        }
      } catch (proxyError) {
        this.logWithTime(
          `Error getting proxy for ${eventId}: ${proxyError.message}`,
          "warning"
        );
      }

      // No header/cookie refresh needed — browser page pool has authentic cookies.\n      const eventWithUniqueSession = {\n        eventId: eventId,\n        headers: null,\n        sessionId: `pool-${eventId}-${Date.now()}-retry${retryCount}`,\n        proxyId: proxy?.proxy || \"default\",\n        retryCount: retryCount,\n      };

      // Quick scrape with shorter timeout and unique session using throttled function
      const result = await Promise.race([
        this.throttledScrapeEvent(eventWithUniqueSession, proxyAgent, proxy),
        setTimeout(SCRAPE_TIMEOUT).then(() => {
          throw new Error("Scrape timeout");
        }),
      ]);

      if (!result || !Array.isArray(result) || result.length === 0) {
        throw new Error("Invalid scrape result");
      }

      // Update metadata asynchronously
      this.updateEventMetadataAsync(eventId, result);

      // CSV generation removed

      // Success tracking
      this.successCount++;
      this.lastSuccessTime = moment();

      // Reset failure tracking on success
      this.resetEventFailureTracking(eventId);

      // FIX: Always update eventUpdateTimestamps with moment object (not Date)
      this.eventUpdateTimestamps.set(eventId, moment());

      // FIX: Also update Last_Updated in database to ensure getEvents() stops returning this event
      try {
        await Event.updateOne(
          { Event_ID: eventId },
          { $set: { Last_Updated: new Date() } }
        );
      } catch (dbError) {
        this.logWithTime(
          `Error updating Last_Updated for ${eventId}: ${dbError.message}`,
          "warning"
        );
      }

      // Update processed time to prevent immediate reprocessing
      this.eventLastProcessedTime.set(eventId, Date.now());

      this.failedEvents.delete(eventId);
      this.clearFailureCount(eventId);

      // Release proxy after successful use
      if (proxy) {
        this.proxyManager.releaseProxy(eventId, true);
      }

      return true;
    } catch (error) {
      // Release proxy on error
      if (proxy) {
        this.proxyManager.releaseProxy(eventId, false, error);
      }

      // Quick failure handling
      this.failedEvents.add(eventId);
      this.incrementFailureCount(eventId);

      // Get last update time to check 10-minute threshold
      const lastUpdate = this.eventUpdateTimestamps.get(eventId);
      const timeSinceUpdate = lastUpdate ? moment().diff(lastUpdate) : Infinity;

      if (timeSinceUpdate >= STALE_EVENT_THRESHOLD) {
        this.logWithTime(
          `Event ${eventId} exceeded staleness threshold (${Math.floor(
            timeSinceUpdate / 1000
          )}s) in optimized path. Retry count: ${retryCount}. Marking for auto-stop.`,
          "error"
        );
        await this.setEventSkipScraping(
          eventId,
          "exceeded_staleness_threshold_optimized",
          retryCount,
          STALE_EVENT_THRESHOLD
        );
      } else if (retryCount >= MAX_RETRIES) {
        // Log the failure without scheduling recovery
        this.logWithTime(
          `❌ Event ${eventId} exceeded MAX_RETRIES (${MAX_RETRIES}). No recovery scheduled. Time since update: ${Math.floor(
            timeSinceUpdate / 1000
          )}s.`,
          "warning"
        );
      } else {
        // Log the failure without retry
        this.logWithTime(
          `❌ Event ${eventId} failed. No retry scheduled. Time since update: ${Math.floor(
            timeSinceUpdate / 1000
          )}s.`,
          "info"
        );
      }

      return false;
    }
  }

  /**
   * Async metadata update to avoid blocking
   */
  async updateEventMetadataAsync(eventId, scrapeResult) {
    try {
      // Immediately update tracking before processing in background
      this.eventUpdateTimestamps.set(eventId, moment());
      this.eventLastProcessedTime.set(eventId, Date.now());

      // Process full metadata update in background (includes Last_Updated write)
      setImmediate(async () => {
        try {
          await this.updateEventMetadata(eventId, scrapeResult);
        } catch (error) {
          console.error(
            `Async metadata update error for ${eventId}: ${error.message}`
          );
        }
      });
    } catch (error) {
      console.error(
        `Error scheduling metadata update for ${eventId}: ${error.message}`
      );
    }
  }

  async captureCookies(page, fingerprint) {
    let retryCount = 0;
    const MAX_RETRIES = 5;

    while (retryCount < MAX_RETRIES) {
      try {
        const challengePresent = await page
          .evaluate(() => {
            return document.body.textContent.includes(
              "Your Browsing Activity Has Been Paused"
            );
          })
          .catch(() => false);

        if (challengePresent) {
          console.log(
            `Attempt ${
              retryCount + 1
            }: Challenge detected during cookie capture`
          );

          const challengeResolved = await this.handleTicketmasterChallenge(
            page
          );
          if (!challengeResolved) {
            if (retryCount === MAX_RETRIES - 1) {
              console.log("Max retries reached during challenge resolution");
              return { cookies: null, fingerprint };
            }
            await page.waitForTimeout(CONFIG.RETRY_DELAY);
            retryCount++;
            continue;
          }
        }

        // Get context from page's browser context
        const context = page.context();
        if (!context) {
          throw new Error("Cannot access browser context from page");
        }

        let cookies = await context.cookies().catch(() => []);

        if (!cookies?.length) {
          console.log(`Attempt ${retryCount + 1}: No cookies captured`);
          if (retryCount === MAX_RETRIES - 1) {
            return { cookies: null, fingerprint };
          }
          await page.waitForTimeout(CONFIG.RETRY_DELAY);
          retryCount++;
          continue;
        }

        // Filter out reCAPTCHA Google cookies
        cookies = cookies.filter(
          (cookie) =>
            !cookie.name.includes("_grecaptcha") &&
            !cookie.domain.includes("google.com")
        );

        // Check if we have enough cookies from ticketmaster.com
        const ticketmasterCookies = cookies.filter(
          (cookie) =>
            cookie.domain.includes("ticketmaster.com") ||
            cookie.domain.includes(".ticketmaster.com")
        );

        if (ticketmasterCookies.length < 3) {
          console.log(
            `Attempt ${retryCount + 1}: Not enough Ticketmaster cookies`
          );
          if (retryCount === MAX_RETRIES - 1) {
            return { cookies: null, fingerprint };
          }
          await page.waitForTimeout(CONFIG.RETRY_DELAY);
          retryCount++;
          continue;
        }

        // Check JSON size
        const cookiesJson = JSON.stringify(cookies, null, 2);
        const lineCount = cookiesJson.split("\n").length;

        if (lineCount < 200) {
          console.log(
            `Attempt ${
              retryCount + 1
            }: Cookie JSON too small (${lineCount} lines)`
          );
          if (retryCount === MAX_RETRIES - 1) {
            return { cookies: null, fingerprint };
          }
          await page.waitForTimeout(CONFIG.RETRY_DELAY);
          retryCount++;
          continue;
        }

        const oneHourFromNow = Date.now() + CONFIG.COOKIE_REFRESH_INTERVAL;
        cookies = cookies.map((cookie) => ({
          ...cookie,
          expires: oneHourFromNow / 1000,
          expiry: oneHourFromNow / 1000,
        }));

        // Add cookies one at a time with error handling
        for (const cookie of cookies) {
          try {
            await context.addCookies([cookie]);
          } catch (error) {
            console.warn(`Error adding cookie ${cookie.name}:`, error.message);
          }
        }

        fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
        console.log(
          `Successfully captured cookies on attempt ${retryCount + 1}`
        );
        return { cookies, fingerprint };
      } catch (error) {
        console.error(
          `Error capturing cookies on attempt ${retryCount + 1}:`,
          error
        );
        if (retryCount === MAX_RETRIES - 1) {
          return { cookies: null, fingerprint };
        }
        await page.waitForTimeout(CONFIG.RETRY_DELAY);
        retryCount++;
      }
    }
  }

  // Recovery methods removed - multiple instances handle redundancy
  // getStaleEventStats, handleStaleEvents, handleCriticalStaleEvents,
  // handleStandardStaleEvents, attemptAggressiveRecovery, attemptIntensiveRecovery,
  // performEmergencyRecovery all removed

  /**
   * Force immediate cleanup of all tracking Maps (manual cleanup)
   */
  async forceCleanupAllTracking() {
    try {
      const beforeCount = this.eventUpdateTimestamps.size;

      // Get currently active events from database
      const activeEvents = await Event.find({
        Skip_Scraping: { $ne: true },
      })
        .select("Event_ID")
        .lean();

      const activeEventIds = new Set(
        activeEvents.map((event) => event.Event_ID)
      );

      // Clear all tracking Maps and rebuild only with active events
      const activeCounts = {
        eventUpdateTimestamps: 0,
        eventLastProcessedTime: 0,
        eventFailureCounts: 0,
        eventFailureTimes: 0,
        processingEvents: 0,
        failedEvents: 0,
        cooldownEvents: 0,
      };

      // Clean eventUpdateTimestamps
      for (const eventId of [...this.eventUpdateTimestamps.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.eventUpdateTimestamps++;
        } else {
          this.eventUpdateTimestamps.delete(eventId);
        }
      }

      // Clean other tracking Maps
      for (const eventId of [...this.eventLastProcessedTime.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.eventLastProcessedTime++;
        } else {
          this.eventLastProcessedTime.delete(eventId);
        }
      }

      for (const eventId of [...this.eventFailureCounts.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.eventFailureCounts++;
        } else {
          this.eventFailureCounts.delete(eventId);
        }
      }

      for (const eventId of [...this.eventFailureTimes.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.eventFailureTimes++;
        } else {
          this.eventFailureTimes.delete(eventId);
        }
      }

      for (const eventId of [...this.processingEvents.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.processingEvents++;
        } else {
          this.processingEvents.delete(eventId);
        }
      }

      for (const eventId of [...this.failedEvents.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.failedEvents++;
        } else {
          this.failedEvents.delete(eventId);
        }
      }

      for (const eventId of [...this.cooldownEvents.keys()]) {
        if (activeEventIds.has(eventId)) {
          activeCounts.cooldownEvents++;
        } else {
          this.cooldownEvents.delete(eventId);
        }
      }

      // CRITICAL FIX: Clean up processing locks to prevent stuck events
      for (const eventId of [...this.processingLocks.keys()]) {
        if (!activeEventIds.has(eventId)) {
          this.processingLocks.delete(eventId);
        }
      }

      // AGGRESSIVE FIX: Clear all processing locks older than 5 minutes
      const fiveMinutesAgo = Date.now() - 300000;
      for (const [eventId, lockTime] of this.processingLocks.entries()) {
        if (lockTime < fiveMinutesAgo) {
          this.processingLocks.delete(eventId);
          this.logWithTime(
            `🔓 Released stuck processing lock for event ${eventId} (locked for ${Math.floor(
              (Date.now() - lockTime) / 1000
            )}s)`,
            "warning"
          );
        }
      }

      const cleanedCount = beforeCount - this.eventUpdateTimestamps.size;

      this.logWithTime(
        `🧽 FORCE CLEANUP: Removed ${cleanedCount} stale events | ` +
          `Active events in DB: ${activeEventIds.size} | Now tracking: ${this.eventUpdateTimestamps.size} | ` +
          `Active tracking: ${JSON.stringify(activeCounts)}`,
        "info"
      );

      return {
        cleaned: cleanedCount,
        activeInDB: activeEventIds.size,
        nowTracking: this.eventUpdateTimestamps.size,
        activeCounts,
      };
    } catch (error) {
      this.logWithTime(`Error in force cleanup: ${error.message}`, "error");
      return { error: error.message };
    }
  }

  /**
   * Clean up inactive events from tracking Maps
   */
  async cleanupInactiveEvents() {
    try {
      // Get currently active events from database
      const activeEvents = await Event.find({
        Skip_Scraping: { $ne: true },
      })
        .select("Event_ID")
        .lean();

      const activeEventIds = new Set(
        activeEvents.map((event) => event.Event_ID)
      );

      // Clean up eventUpdateTimestamps
      let cleanedEvents = 0;
      for (const eventId of this.eventUpdateTimestamps.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.eventUpdateTimestamps.delete(eventId);
          cleanedEvents++;
        }
      }

      // Clean up other tracking Maps
      for (const eventId of this.eventLastProcessedTime.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.eventLastProcessedTime.delete(eventId);
        }
      }

      for (const eventId of this.eventFailureCounts.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.eventFailureCounts.delete(eventId);
        }
      }

      for (const eventId of this.eventFailureTimes.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.eventFailureTimes.delete(eventId);
        }
      }

      for (const eventId of this.processingEvents.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.processingEvents.delete(eventId);
        }
      }

      for (const eventId of this.failedEvents.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.failedEvents.delete(eventId);
        }
      }

      for (const eventId of this.cooldownEvents.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.cooldownEvents.delete(eventId);
        }
      }

      // Clean up processing locks for inactive events
      for (const eventId of this.processingLocks.keys()) {
        if (!activeEventIds.has(eventId)) {
          this.processingLocks.delete(eventId);
        }
      }

      if (cleanedEvents > 0) {
        this.logWithTime(
          `🧹 Cleaned up ${cleanedEvents} inactive events from tracking Maps | ` +
            `Active in DB: ${activeEventIds.size} | Still tracking: ${this.eventUpdateTimestamps.size}`,
          "info"
        );
      } else if (this.eventUpdateTimestamps.size > activeEventIds.size * 2) {
        this.logWithTime(
          `⚠️ Tracking accumulation detected: tracking ${this.eventUpdateTimestamps.size} events but only ${activeEventIds.size} active in DB`,
          "warning"
        );
      }

      return cleanedEvents;
    } catch (error) {
      this.logWithTime(
        `Error cleaning up inactive events: ${error.message}`,
        "error"
      );
      return 0;
    }
  }

  /**
   * Get performance statistics for monitoring (FAST - non-blocking)
   */
  async getPerformanceStats() {
    const now = Date.now();
    const stats = {
      totalEvents: 0,
      eventsUpdatedLast3Min: 0,
      eventsUpdatedLast2Min: 0,
      eventsUpdatedLast1Min: 0,
      criticalEvents: [],
      processingEvents: this.processingEvents.size,
      queueLength: this.eventProcessingQueue.length,
      processingCount: this.processingEvents.size,
      failedCount: this.failedEvents.size,
      successRate:
        (this.successCount + this.failedEvents.size) > 0
          ? (this.successCount / (this.successCount + this.failedEvents.size)) * 100
          : 0,
      memoryUsage: process.memoryUsage(),
    };

    // Get currently active events from database to filter tracking
    let activeEventIds = new Set();
    try {
      const activeEvents = await Event.find({
        Skip_Scraping: { $ne: true },
      })
        .select("Event_ID")
        .lean();

      activeEventIds = new Set(activeEvents.map((event) => event.Event_ID));
    } catch (error) {
      // Fallback: if database query fails, use all tracked events
      console.warn(
        `Failed to get active events for performance stats: ${error.message}`
      );
      activeEventIds = new Set(this.eventUpdateTimestamps.keys());
    }

    // Analyze event update times (fast loop) - only for ACTIVE events
    for (const [eventId, lastUpdate] of this.eventUpdateTimestamps) {
      // Skip events that are no longer active for scraping
      if (!activeEventIds.has(eventId)) {
        continue;
      }

      stats.totalEvents++;
      const timeSinceUpdate = now - lastUpdate.valueOf();

      if (timeSinceUpdate < 60000) {
        stats.eventsUpdatedLast1Min++;
      }
      if (timeSinceUpdate < 120000) {
        stats.eventsUpdatedLast2Min++;
      }
      if (timeSinceUpdate < 180000) {
        stats.eventsUpdatedLast3Min++;
      } else {
        stats.criticalEvents.push({
          eventId,
          minutesSinceUpdate: Math.floor(timeSinceUpdate / 60000),
        });
      }
    }

    return stats;
  }

  /**
   * Start performance monitoring (logs stats every 30 seconds) - ENHANCED
   */
  startPerformanceMonitoring() {
    let monitoringCycleCount = 0;

    setInterval(async () => {
      monitoringCycleCount++;

      // Run cleanup every 4 cycles (2 minutes)
      if (monitoringCycleCount % 4 === 0) {
        await this.cleanupInactiveEvents();
      }

      const stats = await this.getPerformanceStats();
      const eventsPerMinute = stats.eventsUpdatedLast1Min;
      const memoryMB = Math.round(stats.memoryUsage.heapUsed / 1024 / 1024);

      let csvInfo = "";

      this.logWithTime(
        `Performance: ${stats.eventsUpdatedLast3Min}/${stats.totalEvents} events updated in 3min | ` +
          `Queue: ${stats.queueLength} | Processing: ${stats.processingCount} | ` +
          `Success: ${stats.successRate.toFixed(1)}% | ` +
          `Rate: ${eventsPerMinute}/min | ` +
          `Tracked: ${this.eventUpdateTimestamps.size} events | ` +
          `Memory: ${memoryMB}MB${csvInfo}`,
        "info"
      );

      // CSV processing status removed

      // Memory warning
      if (memoryMB > 1024) {
        // Over 1GB
        this.logWithTime(
          `HIGH MEMORY USAGE: ${memoryMB}MB - consider cleanup`,
          "warning"
        );

        // inventoryController cleanup removed
      }

      if (stats.criticalEvents.length > 0) {
        this.logWithTime(
          `WARNING: ${stats.criticalEvents.length} events not updated for >3 minutes`,
          "warning"
        );
      }

      // Log capacity info (parallel mode)
      const projected3Min = eventsPerMinute * 3;
      const totalTracked = this.eventUpdateTimestamps.size || stats.totalEvents;
      if (totalTracked > 0) {
        const canMeet3Min = projected3Min >= totalTracked;
        this.logWithTime(
          `Parallel rate: ${eventsPerMinute} events/min (~${projected3Min}/3min) | Target: ${totalTracked} events`,
          canMeet3Min ? "success" : "warning"
        );
      }
    }, 30000);
  }

  // performEmergencyRecovery removed - multiple instances handle redundancy

  /**
   * Start session health monitoring to detect and handle session failures
   */
  startSessionHealthMonitoring() {
    // NO-OP: Session health monitoring removed. Browser page pool handles sessions.
  }

  /**
   * Add event completion marking system and update batch processing logic
   */
  async _markEventCompleted(eventId) {
    try {
      await Event.updateOne(
        { _id: eventId },
        {
          $set: {
            lastUpdated: new Date(),
            processingStatus: "completed",
          },
          $unset: { needsUpdate: "" },
        }
      );
      this.processingLocks.delete(eventId);
    } catch (error) {
      this.logWithTime(
        `Failed to mark event ${eventId} as completed: ${error.message}`,
        "error"
      );
    }
  }

  async processEventBatch(batch) {
    const now = Date.now();
    const processable = batch.filter((event) => {
      const lockTime = this.processingLocks.get(event.id);
      return !lockTime || now - lockTime > LOCK_TIMEOUT;
    });

    if (processable.length === 0) return [];

    // Apply new locks
    processable.forEach((event) => {
      this.processingLocks.set(event.id, now);
    });

    try {
      const results = await this.throttledScrapeEvent(processable, this);

      // Mark successfully processed events
      await Promise.all(
        results
          .filter((r) => r.success)
          .map((r) => this._markEventCompleted(r.event._id))
      );

      return results;
    } catch (error) {
      this.logWithTime(`Batch processing error: ${error.message}`, "error");
      return [];
    } finally {
      // Cleanup locks for failed events after timeout
      setTimeout(() => {
        processable.forEach((event) => {
          if (this.processingLocks.get(event.id) === now) {
            this.processingLocks.delete(event.id);
          }
        });
      }, LOCK_TIMEOUT);
    }
  }

  async getEventsNeedingUpdate() {
    return Event.find({
      $or: [
        { lastUpdated: { $lt: new Date(Date.now() - MAX_UPDATE_INTERVAL) } },
        { needsUpdate: { $exists: true } },
      ],
      processingStatus: { $ne: "completed" },
    }).limit(100);
  }

  /**
   * Clean up all tracking data for an event
   * @param {string} eventId - The event ID to clean up
   */
  cleanupEventTracking(eventId) {
    // Remove from all tracking maps and sets
    this.eventUpdateTimestamps.delete(eventId);
    this.eventLastProcessedTime.delete(eventId);
    this.eventFailureCounts.delete(eventId);
    this.eventFailureTimes.delete(eventId);
    this.processingEvents.delete(eventId);
    this.failedEvents.delete(eventId);
    this.cooldownEvents.delete(eventId);
    this.processingLocks.delete(eventId);
    this.eventPriorityScores.delete(eventId);
    this.eventUpdateSchedule.delete(eventId);
    this.headersCache.delete(eventId);
    this.headerRefreshTimestamps.delete(eventId);

    // Remove from processing queue
    this.eventProcessingQueue = this.eventProcessingQueue.filter(
      (item) => (typeof item === "string" ? item : item.eventId) !== eventId
    );

    // Remove from active jobs
    this.activeJobs.delete(eventId);

    // Release any associated proxies
    this.proxyManager.releaseProxy(eventId, false);

    if (LOG_LEVEL >= 3) {
      this.logWithTime(
        `🧹 Cleaned up all tracking data for event ${eventId}`,
        "debug"
      );
    }
  }

  /**
   * Set Skip_Scraping = true for an event and clean up tracking
   * @param {string} eventId - The event ID
   * @param {string} reason - Reason for skipping
   * @param {number} retryCount - Current retry count
   * @param {number} retryLimit - Retry limit
   */
  async setEventSkipScraping(eventId, reason, retryCount, retryLimit) {
    if (DISABLE_AUTO_STOP) {
      this.logWithTime(
        `Skipping setting Skip_Scraping for event ${eventId} due to DISABLE_AUTO_STOP.`,
        "info"
      );
      return false;
    }
    try {
      // Only stop if 10-minute threshold is exceeded
      const lastUpdate = this.eventUpdateTimestamps.get(eventId);
      const timeSinceUpdate = lastUpdate ? moment().diff(lastUpdate) : Infinity;

      if (timeSinceUpdate < 600000 && reason !== "exceeded_10min_threshold") {
        this.logWithTime(
          `Prevented premature stopping of event ${eventId}: only ${Math.floor(
            timeSinceUpdate / 1000
          )}s since last update (10-minute threshold not reached)`,
          "warning"
        );
        return false; // Don't stop yet - continue retrying
      }

      // Update event in database to stop scraping
      await Event.updateOne(
        { Event_ID: eventId },
        {
          $set: {
            Skip_Scraping: true,
            skip_timestamp: new Date(),
            time_since_update: timeSinceUpdate,
          },
        }
      );

      this.logWithTime(
        `🚫 STOPPED event ${eventId}: Skip_Scraping = true (Reason: ${reason}, Retries: ${retryCount}/${retryLimit}, Time since update: ${Math.floor(
          timeSinceUpdate / 1000
        )}s) - excluded from future scraping`,
        "warning"
      );

      // Clean up all tracking data for this event
      this.cleanupEventTracking(eventId);

      // Log to error log for audit trail
      await this.logError(
        eventId,
        "EVENT_STOPPED",
        new Error(`Event scraping stopped: ${reason}`),
        {
          reason,
          retryCount,
          retryLimit,
          timeSinceUpdate: Math.floor(timeSinceUpdate / 1000),
          timestamp: new Date().toISOString(),
          skipScrapingSet: true,
        }
      );

      return true; // Successfully stopped
    } catch (error) {
      this.logWithTime(
        `Error setting Skip_Scraping for event ${eventId}: ${error.message}`,
        "error"
      );
      return false;
    }
  }

  /**
   * Get events to process in priority order with intelligent failure handling
   * @returns {Promise<string[]>} Array of event IDs to process
   */
  async getEvents() {
    try {
      const now = moment();

      // Find ALL active events - $ne: true covers false, null, and missing fields
      const events = await Event.find({
        Skip_Scraping: { $ne: true },
      })
        .select("Event_ID Last_Updated")
        .lean();

      if (!events.length) {
        return [];
      }

      // Get current time
      const currentTime = now.valueOf();

      // Process up to 100 events normally
      let maxEventsToProcess = 100;

      // Calculate priority for each event and filter those needing updates
      const eventsNeedingUpdate = [];

      for (const event of events) {
        const eventId = event.Event_ID;

        // CRITICAL FIX: First check if this event was recently processed in memory
        // This prevents returning events that have been processed but DB hasn't been updated yet
        const lastProcessedTime = this.eventLastProcessedTime.get(eventId);
        if (lastProcessedTime && Date.now() - lastProcessedTime < 120000) {
          // Skip events processed in the last 30 seconds regardless of database state
          continue;
        }

        // Also check processing lock to avoid duplicate processing
        if (this.processingEvents.has(eventId)) {
          continue;
        }

        // INTELLIGENT FAILURE HANDLING: Apply exponential backoff for failed events
        const failureCount = this.eventFailureCount.get(eventId) || 0;
        const lastFailureTime = this.eventLastFailureTime.get(eventId) || 0;
        const timeSinceLastFailure = Date.now() - lastFailureTime;

        // Apply exponential backoff for failed events
        if (failureCount > 0 && timeSinceLastFailure < failureCount * 60000) {
          continue; // Skip events in backoff period
        }

        const lastUpdated = event.Last_Updated
          ? moment(event.Last_Updated).valueOf()
          : 0;
        const timeSinceLastUpdate = currentTime - lastUpdated;

        // Skip if updated too recently (unless critical)
        if (timeSinceLastUpdate < 30000 && lastUpdated > 0) {
          continue; // Skip events updated in last 30 seconds
        }

        // Calculate priority score
        let priorityScore = timeSinceLastUpdate / 1000;

        // Critical events approaching 3-minute threshold
        if (timeSinceLastUpdate > 150000) {
          // 2.5 minutes
          priorityScore = priorityScore * 1000;
        }
        // Very urgent - approaching 2 minutes
        else if (timeSinceLastUpdate > 110000) {
          priorityScore = priorityScore * 500;
        }
        // Urgent - over 1.5 minutes
        else if (timeSinceLastUpdate > 90000) {
          priorityScore = priorityScore * 100;
        }
        // High - over 1 minute
        else if (timeSinceLastUpdate > 60000) {
          priorityScore = priorityScore * 50;
        }
        // Medium - over 45 seconds
        else if (timeSinceLastUpdate > 45000) {
          priorityScore = priorityScore * 10;
        }

        eventsNeedingUpdate.push({
          eventId: event.Event_ID,
          priorityScore,
          timeSinceLastUpdate,
          isCritical: timeSinceLastUpdate > 150000,
        });

        // Cache the priority score
        this.eventPriorityScores.set(event.Event_ID, priorityScore);
      }

      // Sort by priority (highest first)
      eventsNeedingUpdate.sort((a, b) => b.priorityScore - a.priorityScore);

      // Return events that need updating, limited to maxEventsToProcess
      const eventsToReturn = eventsNeedingUpdate.map((event) => event.eventId);

      if (eventsToReturn.length > maxEventsToProcess) {
        return eventsToReturn.slice(0, maxEventsToProcess);
      }

      return eventsToReturn;
    } catch (error) {
      console.error("Error getting events to process:", error);
      return [];
    }
  }
}

const scraperManager = new ScraperManager();
export default scraperManager;

// Add a function to export that allows checking logs
export function checkScraperLogs() {
  return scraperManager.checkLogs();
}

// Export cleanup function for manual cleanup
export function forceCleanupTracking() {
  return scraperManager.forceCleanupAllTracking();
}
