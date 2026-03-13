
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import got from 'got';
const { HttpsProxyAgent } = require("https-proxy-agent");
const fs = require("fs");
import { devices } from "patchright";
import proxyArray from "./helpers/proxy.js";
import { AttachRowSection } from "./helpers/seatBatch.js";
import GenerateNanoPlaces from "./helpers/seats.js";
import crypto from "crypto";
import { BrowserFingerprint } from "./browserFingerprint.js";
import pThrottle from 'p-throttle';
import randomUseragent from 'random-useragent';
import delay from 'delay-async';

import { CookieManager } from './helpers/CookieManager.js';
import scraperManager from './scraperManager.js';
import CookieRefreshTracker from './helpers/CookieRefreshTracker.js';
import seatValidator from './helpers/SeatCountValidator.js';
import { classifyResaleListings, getClassificationSummary } from './helpers/resaleClassifier.js';
// Import functions from browser-cookies.js
import {
  refreshCookies,
  loadCookiesFromFile,
  getRealisticIphoneUserAgent,
  browserApiRequest,
  initApiBrowserContext,
  isApiBrowserAvailable,
  cleanupApiBrowser,
  browserPagePool
} from './browser-cookies.js';

// Flag to control whether to use browser-based API requests (bypasses TLS fingerprinting)
const USE_BROWSER_API = true;

// Circuit breaker for cookie refresh operations
class CookieRefreshCircuitBreaker {
  constructor(failureThreshold = 5, resetTimeout = 300000) { // 5 failures, 5 minute reset
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.failures = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        console.log('Cookie refresh circuit breaker: Attempting to reset (HALF_OPEN)');
      } else {
        throw new Error('Cookie refresh circuit breaker is OPEN - too many recent failures');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
    if (this.lastFailureTime) {
      console.log('Cookie refresh circuit breaker: Reset to CLOSED after successful operation');
      this.lastFailureTime = null;
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      console.log(`Cookie refresh circuit breaker: OPENED after ${this.failures} failures`);
    } else {
      console.log(`Cookie refresh circuit breaker: Failure ${this.failures}/${this.failureThreshold}`);
    }
  }

  getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      timeUntilReset: this.state === 'OPEN' ? 
        Math.max(0, this.resetTimeout - (Date.now() - this.lastFailureTime)) : 0
    };
  }
}

// Initialize circuit breaker
const cookieRefreshCircuitBreaker = new CookieRefreshCircuitBreaker();

// Initialize CookieManager instance
const cookieManager = new CookieManager();
cookieManager.persistedPage = null;
cookieManager.persistedContext = null;

const iphone13 = devices["iPhone 13"];

const COOKIES_FILE = "cookies.json";
const CONFIG = {
  COOKIE_REFRESH_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  PAGE_TIMEOUT: 90000, // 90 seconds for page operations (aligned with browser-cookies.js)
  CHALLENGE_TIMEOUT: 15000, // 15 seconds for challenge handling
};

let browser = null;
let context = null;
let capturedState = {
  cookies: null,
  fingerprint: null,
  lastRefresh: null,
  proxy: null,
};
// Flag to track if we're currently refreshing cookies
let isRefreshingCookies = false;
// Queue for pending cookie refresh requests
let cookieRefreshQueue = [];
// Flag to track if periodic refresh has been started
let isPeriodicRefreshStarted = false;

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
  MAX_COOKIE_LENGTH: 8000, // Increased from 4000 for more robust storage
  COOKIE_REFRESH_INTERVAL: 20 * 60 * 1000, // 20 minutes (standardized timing)
  MAX_COOKIE_AGE: 7 * 24 * 60 * 60 * 1000, // 7 days maximum cookie lifetime
  COOKIE_ROTATION: {
    ENABLED: true,
    MAX_STORED_COOKIES: 100, // Keep multiple cookie sets
    ROTATION_INTERVAL: 4 * 60 * 60 * 1000, // 4 hours between rotations
    LAST_ROTATION: Date.now(),
  },
};

// Enhanced cookie handling
const handleCookies = {
  // Extract and validate essential cookies
  extractEssentialCookies: (cookies) => {
    if (!cookies) return "";

    const cookieMap = new Map();
    cookies.split(";").forEach((cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name && value) {
        cookieMap.set(name, value);
      }
    });

    // Prioritize auth cookies
    const essentialCookies = [];
    COOKIE_MANAGEMENT.AUTH_COOKIES.forEach((name) => {
      if (cookieMap.has(name)) {
        essentialCookies.push(`${name}=${cookieMap.get(name)}`);
        cookieMap.delete(name);
      }
    });

    // Add other essential cookies if we have space
    COOKIE_MANAGEMENT.ESSENTIAL_COOKIES.forEach((name) => {
      if (cookieMap.has(name) && essentialCookies.length < 20) {
        // Increased from 10
        essentialCookies.push(`${name}=${cookieMap.get(name)}`);
        cookieMap.delete(name);
      }
    });

    // Add any remaining cookies if they fit
    if (
      essentialCookies.join("; ").length < COOKIE_MANAGEMENT.MAX_COOKIE_LENGTH
    ) {
      for (const [name, value] of cookieMap.entries()) {
        const potentialCookie = `${name}=${value}`;
        if (
          essentialCookies.join("; ").length + potentialCookie.length + 2 <
          COOKIE_MANAGEMENT.MAX_COOKIE_LENGTH
        ) {
          essentialCookies.push(potentialCookie);
        }
      }
    }

    return essentialCookies.join("; ");
  },

  // Validate cookie freshness with improved logic
  areCookiesFresh: (cookies) => {
    if (!cookies) return false;

    const cookieMap = new Map();
    cookies.split(";").forEach((cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name && value) {
        cookieMap.set(name, value);
      }
    });

    // More lenient check: require at least 3 auth cookies
    const authCookiesPresent = COOKIE_MANAGEMENT.AUTH_COOKIES.filter(
      (name) => cookieMap.has(name) && cookieMap.get(name).length > 0
    );

    return authCookiesPresent.length >= 3; // Need at least 3 auth cookies
  },

  // Merge cookies from different sources
  mergeCookies: (existingCookies, newCookies) => {
    if (!existingCookies) return newCookies;
    if (!newCookies) return existingCookies;

    const cookieMap = new Map();

    // Add existing cookies first
    existingCookies.split(";").forEach((cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name && value) {
        cookieMap.set(name, value);
      }
    });

    // Update with new cookies
    newCookies.split(";").forEach((cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name && value) {
        cookieMap.set(name, value);
      }
    });

    // Convert back to string
    return Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  },
};

function generateCorrelationId() {
  return crypto.randomUUID();
}

async function getCapturedData(eventId, proxy, forceRefresh = false) {
  const currentTime = Date.now();

  // If we don't have cookies, try to load them from file first
  if (!cookieManager.capturedState.cookies) {
    try {
      const cookiesFromFile = await loadCookiesFromFile();
      if (cookiesFromFile) {
        const cookieAge = cookiesFromFile[0]?.expiry ? 
                        (cookiesFromFile[0].expiry * 1000 - currentTime) : 
                        CookieManager.CONFIG.MAX_COOKIE_AGE;
        
        if (cookieAge > 0 && cookieAge < CookieManager.CONFIG.MAX_COOKIE_AGE) {
          cookieManager.capturedState.cookies = cookiesFromFile;
          cookieManager.capturedState.lastRefresh = currentTime - (CookieManager.CONFIG.MAX_COOKIE_AGE - cookieAge);
          if (!cookieManager.capturedState.fingerprint) {
            cookieManager.capturedState.fingerprint = BrowserFingerprint.generate();
          }
          if (!cookieManager.capturedState.proxy) {
            cookieManager.capturedState.proxy = proxy;
          }
        }
      }
    } catch (error) {
      console.error("Error loading cookies from file:", error.message);
    }
  }

  // Check if we need to refresh cookies
  const needsRefresh =
    !cookieManager.capturedState.cookies ||
    !cookieManager.capturedState.fingerprint ||
    !cookieManager.capturedState.lastRefresh ||
    !cookieManager.capturedState.proxy ||
    currentTime - cookieManager.capturedState.lastRefresh > CookieManager.CONFIG.COOKIE_REFRESH_INTERVAL ||
    forceRefresh;

  if (needsRefresh) {
    // Validate that we have a proxy before attempting cookie refresh
    if (!proxy || !proxy.proxy) {
      throw new Error("Cannot refresh cookies without a valid proxy");
    }

    const jitter = Math.random() * 20000 + 10000; // 10s to 30s

    const effectiveInterval = CookieManager.CONFIG.COOKIE_REFRESH_INTERVAL + jitter;
    
    const needsRefreshWithJitter = 
      !cookieManager.capturedState.cookies ||
      !cookieManager.capturedState.fingerprint ||
      !cookieManager.capturedState.lastRefresh ||
      !cookieManager.capturedState.proxy ||
      currentTime - cookieManager.capturedState.lastRefresh > effectiveInterval ||
      forceRefresh;
    
    if (needsRefreshWithJitter) {
      console.log(`Refreshing cookies with jitter of ${Math.round(jitter/60000)}min for event ${eventId}`);
      return await refreshHeaders(eventId, proxy);
    }
  }

  return cookieManager.capturedState;
}

async function refreshHeaders(eventId, proxy, existingCookies = null) {
  // If cookies are already being refreshed, add this request to the queue with a timeout
  if (cookieManager.isRefreshingCookies) {
    console.log(
      `Cookies are already being refreshed, queueing request for event ${eventId}`
    );
    return new Promise((resolve, reject) => {
      // Add a timeout to prevent requests from getting stuck in the queue forever
      const timeoutId = setTimeout(async () => {
        // Find and remove this request from the queue
        const index = cookieManager.cookieRefreshQueue.findIndex(item => item.timeoutId === timeoutId);
        if (index !== -1) {
          cookieManager.cookieRefreshQueue.splice(index, 1);
        }
        
        // Try to load existing cookies from file as fallback
        let fallbackCookies = null;
        try {
          const existingCookies = await loadCookiesFromFile();
          if (existingCookies && existingCookies.length > 0) {
            // Check if cookies are not too old (within 2 hours)
            const cookieAge = existingCookies[0]?.expiry ? 
              (Date.now() - (existingCookies[0].expiry * 1000 - 7 * 24 * 60 * 60 * 1000)) : 
              Date.now();
            
            if (cookieAge < 2 * 60 * 60 * 1000) { // Less than 2 hours old
              fallbackCookies = existingCookies;
              console.log(`Using ${fallbackCookies.length} existing cookies as fallback for ${eventId}`);
            }
          }
        } catch (error) {
          console.warn(`Failed to load fallback cookies: ${error.message}`);
        }
        
        // Generate fallback headers since we timed out waiting
        console.log(`Queue timeout for event ${eventId}, using fallback headers`);
        const fallbackHeaders = generateFallbackHeaders();
        resolve({
          cookies: fallbackCookies,
          fingerprint: BrowserFingerprint.generate(),
          lastRefresh: Date.now(),
          headers: fallbackHeaders,
          proxy: proxy
        });
      }, 20000); // Reduced to 20s to fail faster
      
      // Limit queue size to prevent memory issues
      if (cookieManager.cookieRefreshQueue.length >= 100) {
        console.warn(`Cookie refresh queue is full (${cookieManager.cookieRefreshQueue.length}), dropping oldest request`);
        const oldest = cookieManager.cookieRefreshQueue.shift();
        clearTimeout(oldest.timeoutId);
        oldest.reject(new Error('Cookie refresh queue overflow'));
      }
      
      cookieManager.cookieRefreshQueue.push({ resolve, reject, eventId, timeoutId });
    });
  }

  let proxyToUse = proxy;
  let eventIdToUse = eventId;

  let globalTimeoutId = null;
  
  try {
    cookieManager.isRefreshingCookies = true;
    
    // Add a global timeout for the entire refresh process
    globalTimeoutId = setTimeout(() => {
      console.error(`Global timeout reached when refreshing cookies for event ${eventIdToUse}`);
      cookieManager.isRefreshingCookies = false;
      
      // Reject all queued requests on timeout
      while (cookieManager.cookieRefreshQueue.length > 0) {
        const { reject, timeoutId } = cookieManager.cookieRefreshQueue.shift();
        clearTimeout(timeoutId);
        reject(new Error("Global timeout for cookie refresh"));
      }
    }, 90000); // 90 second timeout for the entire process

    // Check if we have valid cookies in memory first
    if (
      cookieManager.capturedState.cookies?.length &&
      cookieManager.capturedState.lastRefresh &&
      Date.now() - cookieManager.capturedState.lastRefresh <= COOKIE_MANAGEMENT.COOKIE_REFRESH_INTERVAL
    ) {
      console.log("Using existing cookies from memory");
      return cookieManager.capturedState;
    }

    // If specific cookies are provided, use them
    if (existingCookies !== null) {
      console.log(`Using provided cookies for event ${eventIdToUse}`);

      if (!cookieManager.capturedState.fingerprint) {
        cookieManager.capturedState.fingerprint = BrowserFingerprint.generate();
      }

      cookieManager.capturedState = {
        cookies: existingCookies,
        fingerprint: cookieManager.capturedState.fingerprint,
        lastRefresh: Date.now(),
        proxy: cookieManager.capturedState.proxy || proxyToUse,
      };
      
      return cookieManager.capturedState;
    }

    // Use our new module to refresh cookies with circuit breaker protection
    try {
      const result = await cookieRefreshCircuitBreaker.execute(async () => {
        return await refreshCookies(eventIdToUse, proxyToUse);
      });
      
      if (result && result.cookies) {
        // Update captured state with the new cookies and fingerprint
        cookieManager.capturedState = {
          cookies: result.cookies,
          fingerprint: result.fingerprint,
          lastRefresh: Date.now(),
          proxy: cookieManager.capturedState.proxy || proxyToUse,
        };
        
        return cookieManager.capturedState;
      } else {
        console.error("Failed to get cookies from refreshCookies");
        throw new Error("Failed to get cookies");
      }
    } catch (error) {
      console.error("Error refreshing cookies:", error.message);
      
      // Generate fallback headers since we couldn't get cookies
      const fallbackHeaders = generateFallbackHeaders();
      cookieManager.capturedState = {
        cookies: null,
        fingerprint: BrowserFingerprint.generate(),
        lastRefresh: Date.now(),
        headers: fallbackHeaders,
        proxy: cookieManager.capturedState.proxy || proxyToUse
      };
      
      return cookieManager.capturedState;
    }
  } catch (error) {
    console.error("Error in refreshHeaders:", error);
    throw error;
  } finally {
    // ALWAYS reset the flag and clear timeout, no matter what happens
    if (globalTimeoutId) {
      clearTimeout(globalTimeoutId);
    }
    
    cookieManager.isRefreshingCookies = false;
    
    // Process any queued refresh requests
    while (cookieManager.cookieRefreshQueue.length > 0) {
      const { resolve, reject, timeoutId } = cookieManager.cookieRefreshQueue.shift();
      clearTimeout(timeoutId);
      
      // Resolve with current state or reject if we have no cookies
      if (cookieManager.capturedState.cookies || cookieManager.capturedState.headers) {
        resolve(cookieManager.capturedState);
      } else {
        const fallbackHeaders = generateFallbackHeaders();
        resolve({
          cookies: null,
          fingerprint: BrowserFingerprint.generate(),
          lastRefresh: Date.now(),
          headers: fallbackHeaders,
          proxy: proxyToUse
        });
      }
    }
  }
}


const throttle = pThrottle({
  limit: 50, // Increased from 50 for even higher volume
  interval: 2000 // Keep at 1 second for good balance
});

const throttledRequest = throttle(async (options) => {
  // Minimal delay for maximum throughput
  const humanDelay = Math.floor(Math.random() * 50) + 25; // Reduced delay
  await delay(humanDelay);
  return got(options);
});

// Replace the GetData function with this improved version
const GetData = async (headers, proxyAgent, url, eventId) => {
  let abortController = new AbortController();

  try {
    const timeout = setTimeout(() => {
      abortController.abort();
    }, CONFIG.PAGE_TIMEOUT);

    try {
      // Add subtle variations to headers to look more human
      const modifiedHeaders = { ...headers };
      
      // Occasionally modify accept-language with slight variations
      if (Math.random() > 0.7 && modifiedHeaders['Accept-Language']) {
        const languages = ['en-US', 'en-GB', 'en-CA', 'en'];
        const weights = [0.8, 0.9, 0.7, 0.6];
        const baseLanguage = languages[Math.floor(Math.random() * languages.length)];
        const weight = weights[Math.floor(Math.random() * weights.length)];
        modifiedHeaders['Accept-Language'] = `${baseLanguage},en;q=${weight}`;
      }
      
      // Use an unpredictable order for cache directives
      if (Math.random() > 0.5) {
        modifiedHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      } else {
        modifiedHeaders['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      }
      
      // Prefer keep-alive for better proxy performance
      modifiedHeaders['Connection'] = Math.random() > 0.9 ? 'close' : 'keep-alive';
      
      const response = await throttledRequest({
        url,
        agent: {
          https: proxyAgent
        },
        headers: modifiedHeaders,
        timeout: {
          request: CONFIG.PAGE_TIMEOUT
        },
        retry: {
          limit: 2, // Allow 2 retries for network issues
          methods: ['GET', 'POST'],
          statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524]
        },
        throwHttpErrors: false,
        signal: abortController.signal
      });

      clearTimeout(timeout);
      
      if (response.statusCode !== 200) {
        // Log specific error types for better debugging
        if (response.statusCode === 407) {
          console.log(`❌ Proxy Authentication Failed (407) for ${eventId} - proxy credentials may be invalid`);
        } else if (response.statusCode === 403) {
          console.log(`❌ Forbidden (403) for ${eventId} - possible rate limiting or IP blocked`);
        } else if (response.statusCode === 400) {
          console.log(`❌ Bad Request (400) for ${eventId} - request format issue`);
        } else {
          console.log(`❌ Request failed with status code ${response.statusCode} for ${eventId}`);
        }
        return false;
      }
      
      return JSON.parse(response.body);
    } catch (error) {
      clearTimeout(timeout);
      console.log(`Request failed: ${error.message}`);
      return false;
    }
  } catch (error) {
    return false;
  }
};

const GetProxy = async () => {
  try {
    // Use ProxyManager global instance if available
    if (global.proxyManager) {
      // Add diagnostic information about proxy count
      const availableCount = global.proxyManager.getAvailableProxyCount();
      
      try {
        const proxyData = global.proxyManager.getProxyForEvent('random');
        if (proxyData) {
          const proxyUrl = new URL(`http://${proxyData.proxy}`);
          const testUrl = `http://${proxyData.username}:${proxyData.password}@${proxyUrl.hostname}:${proxyUrl.port || 80}`;
          const proxyAgent = new HttpsProxyAgent(testUrl, {
            timeout: 30000,        // 30s connection timeout
            keepAlive: true,       // Reuse connections
            keepAliveMsecs: 1000,  // Keep alive interval
            maxSockets: 256,       // Allow more concurrent connections
            maxFreeSockets: 256    // Keep more connections open
          });
          return { proxyAgent, proxy: proxyData };
        }
      } catch (error) {
        console.warn(`Failed to get proxy: ${error.message}`);
      }
    }
    
    // Fallback to old method without health checks
    let _proxy = [...proxyArray?.proxies];
    
    try {
      const randomProxy = Math.floor(Math.random() * _proxy.length);
      const selectedProxy = _proxy[randomProxy];

      if (!selectedProxy?.proxy || !selectedProxy?.username || !selectedProxy?.password) {
        throw new Error("Invalid proxy configuration");
      }

      const proxyUrl = new URL(`http://${selectedProxy.proxy}`);
      const proxyURl = `http://${selectedProxy.username}:${selectedProxy.password}@${proxyUrl.hostname}:${proxyUrl.port || 80}`;
      
      const proxyAgent = new HttpsProxyAgent(proxyURl, {
        timeout: 30000,        // 30s connection timeout
        keepAlive: true,       // Reuse connections
        keepAliveMsecs: 1000,  // Keep alive interval
        maxSockets: 256,       // Allow more concurrent connections
        maxFreeSockets: 256    // Keep more connections open
      });
      return { proxyAgent, proxy: selectedProxy };
    } catch (error) {
      console.warn(`Failed to get proxy: ${error.message}`);
    }

    // Last resort fallback
    console.warn("Using fallback proxy");
    const fallbackProxy = proxyArray.proxies[0];
    const proxyUrl = new URL(`http://${fallbackProxy.proxy}`);
    const proxyURl = `http://${fallbackProxy.username}:${fallbackProxy.password}@${proxyUrl.hostname}:${proxyUrl.port || 80}`;
    const proxyAgent = new HttpsProxyAgent(proxyURl, {
      timeout: 30000,        // 30s connection timeout
      keepAlive: true,       // Reuse connections
      keepAliveMsecs: 1000,  // Keep alive interval
      maxSockets: 256,       // Allow more concurrent connections
      maxFreeSockets: 256    // Keep more connections open
    });
    return { proxyAgent, proxy: fallbackProxy };
  } catch (error) {
    console.error("Critical error in GetProxy:", error);
    throw new Error(`Failed to get any working proxy: ${error.message}`);
  }
};

const ScrapeEvent = async (
  event,
  externalProxyAgent = null,
  externalProxy = null
) => {
  // Declare proxy variables at function level so they're accessible in catch block
  let proxyAgent = externalProxyAgent;
  let proxy = externalProxy;

  try {
    // Throttled memory check — log at most every 30s to reduce noise
    const memUsage = process.memoryUsage();
    const now = Date.now();
    if (memUsage.heapUsed > 1024 * 1024 * 1024 && (!ScrapeEvent._lastMemWarn || now - ScrapeEvent._lastMemWarn > 30000)) {
      ScrapeEvent._lastMemWarn = now;
      console.warn(`High memory usage (${Math.round(memUsage.heapUsed / 1024 / 1024)}MB)`);
    }

    // Determine event ID from either object or simple ID
    const eventId = event?.eventId || event;
    const startTime = Date.now();
    const correlationId = generateCorrelationId();
    let cookieString, userAgent, fingerprint;
    let capturedCookies = []; // Store raw cookies for browser-based API requests
    let useProvidedHeaders = false;

    // Ensure we have a valid event ID
    if (!eventId) {
      console.error("Missing event ID in ScrapeEvent call");
      return false;
    }

    // Lightweight rate limiting — just track hourly count
    if (!ScrapeEvent.rateLimits) {
      ScrapeEvent.rateLimits = { hourlyCount: 0, lastHour: new Date().getHours(), maxPerHour: 10000, blockedUntil: 0 };
    }
    const currentHour = new Date().getHours();
    if (currentHour !== ScrapeEvent.rateLimits.lastHour) {
      ScrapeEvent.rateLimits.hourlyCount = 0;
      ScrapeEvent.rateLimits.lastHour = currentHour;
    }
    if (ScrapeEvent.rateLimits.blockedUntil > Date.now()) {
      throw new Error('Service temporarily unavailable');
    }
    ScrapeEvent.rateLimits.hourlyCount++;

    // Use provided proxy if available, otherwise get a new one
    if (!proxyAgent || !proxy) {
      const proxyData = await GetProxy();
      proxyAgent = proxyData.proxyAgent;
      proxy = proxyData.proxy;
    }

    // Cookie refresh not needed — browser pool handles cookies

    // Skip the entire cookie refresh flow.
    // The browser page pool already visited ticketmaster.com/event/...
    // so the browser context has authentic cookies. fetch() inside
    // page.evaluate uses those cookies automatically via credentials:'include'.
    fingerprint = generateEnhancedFingerprint();
    userAgent =
      fingerprint.browser?.userAgent ||
      randomUseragent.getRandom(
        (ua) => ua.browserName === fingerprint.browser?.name
      ) ||
      getRealisticIphoneUserAgent();
    cookieString = ''; // Not needed — browser handles cookies
    capturedCookies = []; // Not needed — browser handles cookies

    // Define API URLs for header optimization
    const mapUrl = `https://mapsapi.tmol.io/maps/geometry/3/event/${eventId}/placeDetailNoKeys?useHostGrids=true&app=CCP&sectionLevel=true&systemId=HOST`;
    const facetUrl = `https://services.ticketmaster.com/api/ismds/event/${eventId}/facets?by=section+shape+attributes+available+accessibility+offer+inventoryTypes+offerTypes+description&show=places+inventoryTypes+offerTypes&embed=offer&embed=description&q=available&compress=places&resaleChannelId=internal.ecommerce.consumer.desktop.web.browser.ticketmaster.us&apikey=b462oi7fic6pehcdkzony5bxhe&apisecret=pquzpfrfz7zd2ylvtz3w5dtyse`;

    // Generate API-specific headers using our improved rotation system
    const mapHeaders = HeaderRotation.getRotatedHeaders(fingerprint, cookieString, mapUrl);
    const facetHeaders = HeaderRotation.getRotatedHeaders(fingerprint, cookieString, facetUrl);

    // Validate and fix headers
    const validatedMapHeaders = HeaderValidator.fixHeaders(mapHeaders, mapUrl);
    const validatedFacetHeaders = HeaderValidator.fixHeaders(facetHeaders, facetUrl);

    // Create safe header objects that match the expected format
    const MapHeader = {
      ...validatedMapHeaders,
      "X-Request-ID": generateCorrelationId() + `-${Date.now()}`,
      "X-Correlation-ID": correlationId,
    };

    const FacetHeader = {
      ...validatedFacetHeaders,
      "tmps-correlation-id": correlationId,
      "X-Api-Key": "b462oi7fic6pehcdkzony5bxhe",
      "X-Request-ID": generateCorrelationId() + `-${Date.now()}`,
      "X-Correlation-ID": correlationId,
    };

    // Headers ready — proceeding to API call

    // Measure API call time for performance monitoring
    const apiStartTime = Date.now();
    const result = await callTicketmasterAPI(
      FacetHeader,
      proxyAgent,
      eventId,
      event,
      MapHeader,
      startTime,
      proxy, // Pass proxy data for browser-based requests
      capturedCookies // Pass raw cookies for browser-based requests
    );
    const apiDuration = Date.now() - apiStartTime;

    if (apiDuration > 60000) {
      console.log(`Event ${eventId} slow API: ${apiDuration}ms`);
    }

    // If API call was too fast, it might be suspicious (rate limited or blocked)
    if (apiDuration < 100 && !result) {
      console.warn(
        `Suspiciously fast API failure for event ${eventId} (${apiDuration}ms). Possible rate limiting detected.`
      );
      // Implement a temporary rate limiting backoff (1 minute)
      ScrapeEvent.rateLimits.blockedUntil = Date.now() + 60 * 1000;
    }

    return result;
  } catch (error) {
    console.error(
      `Scraping error for event ${event?.eventId || event}:`,
      error.message
    );

    // Record failed event for monitoring
    const eventId = event?.eventId || event;
    const timestamp = new Date().toISOString();
    
    // Log to console for immediate visibility
    console.log(`[FAILED EVENT] ${eventId} at ${timestamp}: ${error.message}`);
    
    // Track in a simple failed events collection
    if (!ScrapeEvent.failedEvents) {
      ScrapeEvent.failedEvents = [];
    }
    
    ScrapeEvent.failedEvents.push({
      eventId: eventId,
      timestamp: timestamp,
      error: error.message,
      proxy: proxy?.proxy || 'unknown'
    });
    
    // Keep only last 1000 failed events to prevent memory issues
    if (ScrapeEvent.failedEvents.length > 1000) {
      ScrapeEvent.failedEvents = ScrapeEvent.failedEvents.slice(-1000);
    }

    // Release proxy with error if we have a proxy manager
    if (global.proxyManager && proxy && proxy.proxy) {
      global.proxyManager.releaseProxy(event?.eventId || event, false, error);
    }

    return false;
  }
};

// Simplified API call without retry logic
async function callTicketmasterAPI(facetHeader, proxyAgent, eventId, event, mapHeader = null, startTime, proxyData = null, cookiesArray = null) {
  startTime = startTime || Date.now();
  
  // Browser-based request function (bypasses TLS fingerprinting) — LEGACY, kept as fallback
  const makeBrowserRequest = async (url, headers, proxy, cookies) => {
    try {
      
      // Filter headers for browser fetch compatibility
      const browserHeaders = {};
      const allowedHeaders = [
        'Accept', 'Accept-Language', 'Cache-Control', 'Pragma', 
        'X-Api-Key', 'X-Request-ID', 'X-Correlation-ID', 'tmps-correlation-id'
      ];
      
      for (const [key, value] of Object.entries(headers)) {
        // Skip headers that browsers handle automatically or that cause issues
        if (key.toLowerCase().startsWith('sec-') || 
            key.toLowerCase() === 'user-agent' ||
            key.toLowerCase() === 'cookie' ||
            key.toLowerCase() === 'connection' ||
            key.toLowerCase() === 'host') {
          continue;
        }
        if (typeof value === 'string' && allowedHeaders.some(h => h.toLowerCase() === key.toLowerCase())) {
          browserHeaders[key] = value;
        }
      }
      
      const result = await browserApiRequest(url, browserHeaders, proxy, cookies);
      return { body: result };
      
    } catch (error) {
      // Re-throw with status code for consistent error handling
      const newError = new Error(`Response code ${error.statusCode || 0} (${error.message})`);
      newError.response = { statusCode: error.statusCode || 0 };
      throw newError;
    }
  };
  
  // Simple request function without retries (fallback using got)
  const makeGotRequest = async (url, headers, agent) => {
    try {
      
      // Construct a safe copy of headers without any possible circular references
      const safeHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          safeHeaders[key] = value;
        }
      }
      
      // Use throttled request
      return await throttledRequest({
        url,
        agent: {
          https: agent
        },
        headers: safeHeaders,
        timeout: {
          request: 15000 // Increased to 25s to prevent incomplete responses
        },
        responseType: 'json',
        retry: {
          limit: 0 // No retries, fail fast
        }
      });
    } catch (error) {
      // Just throw the error, no retry logic
      throw error;
    }
  };
  
  // Unified request function - uses browser API only, no got fallback
  const makeRequest = async (url, headers, agent, proxy = null, cookies = null) => {
    return await makeBrowserRequest(url, headers, proxy, cookies);
  };
  
  try {
    const mapUrl = `https://mapsapi.tmol.io/maps/geometry/3/event/${eventId}/placeDetailNoKeys?useHostGrids=true&app=CCP&sectionLevel=true&systemId=HOST`;
    const facetUrl = `https://services.ticketmaster.com/api/ismds/event/${eventId}/facets?by=section+shape+attributes+available+accessibility+offer+inventoryTypes+offerTypes+description&show=places+inventoryTypes+offerTypes&embed=offer&embed=description&q=available&compress=places&resaleChannelId=internal.ecommerce.consumer.desktop.web.browser.ticketmaster.us&apikey=b462oi7fic6pehcdkzony5bxhe&apisecret=pquzpfrfz7zd2ylvtz3w5dtyse`;
    
    // Add unique query parameters to bust cache and appear more like a browser
    const cacheBuster = Date.now();
    const randomId = Math.floor(Math.random() * 1000000);
    
    // Append cache busting differently for each URL
    const mapUrlWithParams = `${mapUrl}${mapUrl.includes('?') ? '&' : '?'}_=${cacheBuster}`;
    const facetUrlWithParams = `${facetUrl}${facetUrl.includes('?') ? '&' : '?'}_=${cacheBuster+1}&t=${randomId}`;
    
    // Ensure no circular references in headers by creating new objects with primitive values only
    let safeMapHeader = null;
    if (mapHeader) {
      safeMapHeader = {};
      for (const [key, value] of Object.entries(mapHeader)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          safeMapHeader[key] = value;
        }
      }
    }
    
    let safeFacetHeader = {};
    for (const [key, value] of Object.entries(facetHeader)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        safeFacetHeader[key] = value;
      }
    }
    
    // Make single attempts at both API calls
    let DataMap, DataFacets;
    
    // Parse cookies from header for browser-based requests
    const cookies = cookiesArray || [];
    
    // Filter headers for browser fetch compatibility (browser handles sec-*, user-agent, cookie automatically)
    const filterForBrowser = (headers) => {
      const filtered = {};
      const allowed = ['accept', 'accept-language', 'cache-control', 'pragma',
        'x-api-key', 'x-request-id', 'x-correlation-id', 'tmps-correlation-id'];
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase().startsWith('sec-') ||
            ['user-agent', 'cookie', 'connection', 'host'].includes(key.toLowerCase())) continue;
        if (typeof value === 'string' && allowed.includes(key.toLowerCase())) {
          filtered[key] = value;
        }
      }
      return filtered;
    };

    // Initialize page pool if needed — pass eventId so seed page visits a real event
    if (!browserPagePool.initialized) {
      try {
        await browserPagePool.init(proxyData, cookies, eventId);
      } catch (poolInitError) {
        console.warn(`[PagePool] Init failed, falling back to single-page: ${poolInitError.message}`);
      }
    }

    // Submit this event's 2 requests to the batcher.
    // The batcher auto-groups ~20 events into one page.evaluate(Promise.all(...))
    // call, so 10 pages × 20 events = 200 events processed per cycle.
    if (browserPagePool.initialized) {
      try {
        const batchResults = await browserPagePool.submitRequests([
          { url: mapUrlWithParams, headers: filterForBrowser(safeMapHeader || safeFacetHeader) },
          { url: facetUrlWithParams, headers: filterForBrowser(safeFacetHeader) }
        ]);

        DataMap = batchResults[0]?.success ? batchResults[0].data : null;
        DataFacets = batchResults[1]?.success ? batchResults[1].data : null;

        if (!batchResults[0]?.success) console.log(`Map API failed for event ${eventId}: ${batchResults[0]?.error}`);
        if (!batchResults[1]?.success) console.log(`Facet API failed for event ${eventId}: ${batchResults[1]?.error}`);
      } catch (batchError) {
        console.log(`Batch request failed for event ${eventId}: ${batchError.message}`);
        if (batchError.message?.includes('not initialized') ||
            batchError.message?.includes('disconnected') ||
            batchError.message?.includes('Target closed')) {
          // Trigger browser restart — requests during restart are queued automatically
          browserPagePool._restartBrowser('error-recovery').catch(() => {});
        }
        DataMap = null;
        DataFacets = null;
      }
    } else {
      // Fallback: single-page browser requests (sequential but still uses real TLS)
      try {
        const mapResult = await browserApiRequest(mapUrlWithParams,
          filterForBrowser(safeMapHeader || safeFacetHeader), proxyData, cookies);
        DataMap = mapResult;
      } catch (e) {
        console.log(`Map API failed for event ${eventId}: ${e.message}`);
        DataMap = null;
      }
      try {
        const facetResult = await browserApiRequest(facetUrlWithParams,
          filterForBrowser(safeFacetHeader), proxyData, cookies);
        DataFacets = facetResult;
      } catch (e) {
        console.log(`Facet API failed for event ${eventId}: ${e.message}`);
        DataFacets = null;
      }
    }
    
    // Both APIs must succeed to ensure data consistency
    if (!DataFacets || !DataMap) {
      const failedApis = [];
      if (!DataFacets) failedApis.push('Facet API');
      if (!DataMap) failedApis.push('Map API');
      
      throw new Error(`Event scraping failed - ${failedApis.join(' and ')} call(s) failed. Both APIs are required for data consistency.`);
    }
    
    // Both APIs successful — proceed with data processing

    // Debug: dump raw offer objects to see exactly what TM sends
    // Writes once per event to debug/offers_{eventId}.json
    try {
      const debugDir = './debug';
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      const offerDebugPath = `${debugDir}/offers_${eventId}.json`;
      if (!fs.existsSync(offerDebugPath)) {
        const rawOffers = DataFacets?._embedded?.offer || [];
        const debugPayload = {
          eventId,
          capturedAt: new Date().toISOString(),
          offerCount: rawOffers.length,
          offers: rawOffers.map((o, idx) => ({
            _index: idx,
            offerId: o.offerId,
            name: o.name,
            description: o.description,
            inventoryType: o.inventoryType,
            faceValue: o.faceValue,
            totalPrice: o.totalPrice,
            listPrice: o.listPrice,
            charges: o.charges,
            currency: o.currency,
            protected: o.protected,
            ticketTypeUnsoldQualifier: o.ticketTypeUnsoldQualifier,
            // Capture ALL top-level keys so we can see what else TM sends
            _allKeys: Object.keys(o),
          })),
          // Also capture a sample of the raw facets to see offer references
          sampleFacet: DataFacets?.facets?.[0] ? {
            section: DataFacets.facets[0].section,
            row: DataFacets.facets[0].row,
            offers: DataFacets.facets[0].offers,
            inventoryTypes: DataFacets.facets[0].inventoryTypes,
            offerTypes: DataFacets.facets[0].offerTypes,
            _allKeys: Object.keys(DataFacets.facets[0]),
          } : null,
        };
        fs.writeFileSync(offerDebugPath, JSON.stringify(debugPayload, null, 2));
        console.log(`[Debug] Raw offer data written to ${offerDebugPath} (${rawOffers.length} offers)`);
      }
    } catch (debugErr) {
      // Never let debug logging break the scrape
      console.warn(`[Debug] Failed to write offer debug file: ${debugErr.message}`);
    }

    // Classify resale listings as fan (verified_resale) vs broker (3rd_party_resale)
    const resaleClassification = DataFacets?.facets
      ? classifyResaleListings(DataFacets.facets)
      : new Map();

    if (resaleClassification.size > 0) {
      const summary = getClassificationSummary(resaleClassification);
      console.log(`[ResaleClassifier] Event ${eventId}: ${summary.fan} fan, ${summary.broker} broker, ${summary.total} total resale listings`);
    }

    // Handle the case where we have partial data
    try {
      const result = AttachRowSection(
        DataFacets ? GenerateNanoPlaces(DataFacets?.facets) : [],
        DataMap || {},
        DataFacets?._embedded?.offer || [],
        { eventId, inHandDate: event?.inHandDate },
        DataFacets?._embedded?.description || {},
        resaleClassification
      );
      
      // Validate result - null or empty results should not be considered successful scrape
      if (!result || !Array.isArray(result) || result.length === 0) {
        throw new Error(`Event ${eventId} scrape validation failed - no valid seats found. Result: ${result ? 'empty array' : 'null/undefined'}`);
      }
      
      // SEAT COUNT VALIDATION - Check for suspicious fluctuations
      const seatCount = result.length;
      const validation = await seatValidator.validateSeatCount(eventId, seatCount);
      
      if (!validation.isValid && validation.shouldDelay) {
        console.warn(
          `[SeatValidator] ⚠️ ${validation.message} - Event ${eventId} will be delayed`
        );
        
        // Throw a special error that scraperManager can catch and handle
        const delayError = new Error(`SEAT_COUNT_FLUCTUATION: ${validation.message}`);
        delayError.isFluctuationError = true;
        delayError.delayUntil = validation.delayUntil;
        delayError.seatCount = seatCount;
        delayError.previousCount = validation.previousCount;
        delayError.trendCheck = validation.trendCheck || null;
        throw delayError;
      }
      
      // Success is the normal case — only log anomalies
      
      return result;
    } catch (processError) {
      console.error(`Error processing API response for event ${eventId}:`, processError.message);
      throw processError; // Re-throw to ensure scrape is marked as failed
    }
  } catch (error) {
    console.error(`API error for event ${eventId}:`, error.message);
    throw error; // Re-throw to ensure scrape is marked as failed instead of returning null
  }
}

// Enhanced browser fingerprinting
const generateEnhancedFingerprint = () => {
  const baseFingerprint = BrowserFingerprint.generate();
  
  // Device types for realistic fingerprinting
  const devices = [
    // Windows devices
    {
      platform: 'Win32',
      os: 'Windows',
      osVersion: ['10.0', '11.0'],
      browserNames: ['Chrome', 'Firefox', 'Edge'],
      screenResolutions: [
        {width: 1920, height: 1080},
        {width: 1366, height: 768},
        {width: 2560, height: 1440},
        {width: 1280, height: 720}
      ],
      languages: ['en-US', 'en-GB', 'en'],
      timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London'],
      colorDepths: [24, 30],
      pixelRatios: [1, 1.25, 1.5, 2],
      vendors: ['Google Inc.', 'Microsoft Corporation', 'Intel Inc.'],
      renderers: [
        'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      ]
    },
    // Mac devices
    {
      platform: 'MacIntel',
      os: 'Mac OS X',
      osVersion: ['10.15.7', '11.6.8', '12.5.1', '13.4.1'],
      browserNames: ['Chrome', 'Firefox', 'Safari'],
      screenResolutions: [
        {width: 1440, height: 900},
        {width: 2560, height: 1600},
        {width: 2880, height: 1800},
        {width: 1280, height: 800}
      ],
      languages: ['en-US', 'en-GB', 'en-CA', 'en'],
      timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London'],
      colorDepths: [24, 30],
      pixelRatios: [1, 2],
      vendors: ['Apple Inc.', 'Google Inc.', 'Intel Inc.'],
      renderers: [
        'Apple GPU',
        'Intel(R) Iris(TM) Plus Graphics',
        'AMD Radeon Pro 5500M OpenGL Engine'
      ]
    }
  ];
  
  // Get random values for consistency across the fingerprint
  const randomIndex = Math.floor(Math.random() * devices.length);
  const device = devices[randomIndex];
  
  // Choose a browser
  const browserIndex = Math.floor(Math.random() * device.browserNames.length);
  const browserName = device.browserNames[browserIndex];
  
  // Choose random values for other properties
  const screenRes = device.screenResolutions[Math.floor(Math.random() * device.screenResolutions.length)];
  const language = device.languages[Math.floor(Math.random() * device.languages.length)];
  const timezone = device.timezones[Math.floor(Math.random() * device.timezones.length)];
  const colorDepth = device.colorDepths[Math.floor(Math.random() * device.colorDepths.length)];
  const pixelRatio = device.pixelRatios[Math.floor(Math.random() * device.pixelRatios.length)];
  const vendor = device.vendors[Math.floor(Math.random() * device.vendors.length)];
  const renderer = device.renderers[Math.floor(Math.random() * device.renderers.length)];
  const osVersion = device.osVersion[Math.floor(Math.random() * device.osVersion.length)];
  
  // Random hardware values that make sense for the device
  const memoryOptions = [4, 8, 16, 32];
  const cpuOptions = [2, 4, 6, 8, 10, 12];
  const memory = memoryOptions[Math.floor(Math.random() * memoryOptions.length)];
  const cpuCount = cpuOptions[Math.floor(Math.random() * cpuOptions.length)];
  
  // Generate a realistic timestamp for browser cookies
  const browserCookieCreated = Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000); // 0-30 days ago
  
  // Random browser capabilities - not all browsers support all features
  const supportsSpeechSynthesis = browserName !== 'Safari' && Math.random() > 0.1;
  const supportsPaymentRequest = browserName === 'Chrome' || (browserName === 'Edge' && Math.random() > 0.3);
  const supportsWebGL2 = browserName !== 'Safari' || Math.random() > 0.4;
  
  // Enhanced fingerprint object
  return {
    ...baseFingerprint, // Keep base fingerprint as fallback
    // Browser identification
    browser: {
      name: browserName,
      version: getRandomBrowserVersion(browserName),
      userAgent: randomUseragent.getRandom(ua => ua.browserName === browserName) || baseFingerprint.userAgent,
      language: language,
      cookies: true,
      localStorage: true,
      sessionStorage: true,
      cookiesCreatedAt: browserCookieCreated,
    },
    // Operating system
    platform: {
      name: device.os,
      version: osVersion,
      type: 'desktop',
      architecture: Math.random() > 0.5 ? 'x86_64' : 'arm64', 
    },
    // Screen and display
    screen: {
      width: screenRes.width,
      height: screenRes.height,
      colorDepth: colorDepth,
      pixelRatio: pixelRatio,
      orientation: 'landscape'
    },
    // Connection info
    connection: {
      type: Math.random() > 0.3 ? 'wifi' : 'ethernet',
      downlink: 5 + Math.floor(Math.random() * 95), // 5-100 Mbps
      rtt: 5 + Math.floor(Math.random() * 95), // 5-100ms
    },
    // Hardware
    hardware: {
      deviceMemory: memory,
      hardwareConcurrency: cpuCount,
    },
    // Graphics
    graphics: {
      vendor: vendor,
      renderer: renderer,
      webGLVendor: vendor,
      webGLRenderer: renderer,
      supportsWebGL: true,
      supportsWebGL2: supportsWebGL2,
    },
    // Capabilities
    capabilities: {
      audio: true,
      video: true,
      webRTC: Math.random() > 0.2,
      geolocation: Math.random() > 0.4,
      speechSynthesis: supportsSpeechSynthesis,
      paymentRequest: supportsPaymentRequest,
    },
    language: language,
    timezone: timezone,
  };
};

// Helper function to generate realistic browser versions
function getRandomBrowserVersion(browserName) {
  const browserVersions = {
    'Chrome': ['111.0.5563.111', '112.0.5615.50', '113.0.5672.92', '114.0.5735.106', '115.0.5790.98', '116.0.5845.97'],
    'Firefox': ['111.0', '112.0.2', '113.0.1', '114.0.2', '115.0', '116.0'],
    'Edge': ['111.0.1661.51', '112.0.1722.48', '113.0.1774.42', '114.0.1823.51', '115.0.1901.183', '116.0.1938.62'],
    'Safari': ['16.3', '16.4', '16.5', '16.6', '17.0']
  };
  
  const versions = browserVersions[browserName] || browserVersions['Chrome'];
  return versions[Math.floor(Math.random() * versions.length)];
}

// Enhanced request headers with improved anti-detection
const generateEnhancedHeaders = (fingerprint, cookies, url = null) => {
  try {
    // Ensure we have valid inputs
    if (!fingerprint) {
      fingerprint = generateEnhancedFingerprint();
    }

    if (!cookies) {
      cookies = '';
    }
    
    // Trim cookies to maintain optimal length
    cookies = trimCookieString(cookies, 8000); // Increased for better auth

    // Get current timestamp for realistic headers
    const now = new Date();
    const timestamp = now.getTime();
    
    // Determine request type based on URL
    const isMapAPI = url && url.includes('mapsapi.tmol.io');
    const isFacetAPI = url && url.includes('services.ticketmaster.com');
    
    // Get appropriate user agent with version variations
    let userAgent;
    if (fingerprint.browser?.userAgent) {
      userAgent = fingerprint.browser.userAgent;
    } else if (fingerprint.browser?.name) {
      userAgent = generateRealisticUserAgent(fingerprint.browser.name, fingerprint.platform?.name);
    } else {
      userAgent = generateRealisticUserAgent('Chrome', 'Windows');
    }

    const browserName = fingerprint.browser?.name || 'Chrome';
    const browserVersion = fingerprint.browser?.version || getLatestBrowserVersion(browserName);
    const platformName = fingerprint.platform?.name || 'Windows';
    
    // Generate browser-specific sec-ch-ua headers with realistic versions
    let secChUa = generateSecChUaHeader(browserName, browserVersion);
    
    // Generate platform string with proper formatting
    const secChUaPlatform = generatePlatformHeader(platformName);

    // Mobile detection with proper mobile headers
    const isMobile = fingerprint.platform?.type === 'mobile' || userAgent.includes('Mobile');
    const secChUaMobile = isMobile ? '?1' : '?0';

    // Enhanced language preferences with realistic variations
    const language = fingerprint.language || 'en-US';
    const acceptLanguage = generateAcceptLanguageHeader(language);

    // Browser-specific accept encoding
    const acceptEncoding = generateAcceptEncodingHeader(browserName);

    // Dynamic cache control based on request type
    const cacheControl = generateCacheControlHeader(isMapAPI, isFacetAPI);

    // Generate realistic Accept header based on API type
    const acceptHeader = generateAcceptHeader(isMapAPI, isFacetAPI);

    // Generate referer based on realistic user flow
    const referer = generateRealisticReferer(url);

    // Build headers object with proper ordering
    const headers = {};
    
    // Core browser headers (order matters for fingerprinting)
    headers['User-Agent'] = userAgent;
    headers['Accept'] = acceptHeader;
    headers['Accept-Language'] = acceptLanguage;
    headers['Accept-Encoding'] = acceptEncoding;
    
    // Security and fetch headers for Chromium-based browsers
    if (browserName === 'Chrome' || browserName === 'Edge') {
      headers['sec-ch-ua'] = secChUa;
      headers['sec-ch-ua-mobile'] = secChUaMobile;
      headers['sec-ch-ua-platform'] = secChUaPlatform;
      
      // Add realistic sec-ch-ua-bitness for modern Chrome
      if (platformName === 'Windows' && Math.random() > 0.3) {
        headers['sec-ch-ua-bitness'] = '"64"';
      }
      
      // Add sec-ch-ua-full-version-list occasionally for newer Chrome versions
      if (parseInt(browserVersion.split('.')[0]) >= 98 && Math.random() > 0.7) {
        headers['sec-ch-ua-full-version-list'] = generateFullVersionList(browserName, browserVersion);
      }
    }
    
    // Fetch API headers
    headers['Sec-Fetch-Dest'] = isMapAPI ? 'empty' : 'empty';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['Sec-Fetch-Site'] = isMapAPI ? 'cross-site' : 'same-site';
    
    // Navigation and origin headers
    if (referer) {
      headers['Referer'] = referer;
    }
    
    if (!isMapAPI) {
      headers['Origin'] = 'https://www.ticketmaster.com';
    }
    
    // Connection management
    headers['Connection'] = Math.random() > 0.8 ? 'close' : 'keep-alive';
    
    // Cache and pragma headers
    headers['Cache-Control'] = cacheControl;
    headers['Pragma'] = 'no-cache';
    
    // Cookie handling
    if (cookies) {
      headers['Cookie'] = cookies;
    }
    
    // API-specific headers
    if (isFacetAPI || isMapAPI) {
      headers['X-Api-Key'] = 'b462oi7fic6pehcdkzony5bxhe';
    }
    
    // AJAX indicators
    if (Math.random() > 0.5) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    
    // Privacy headers (occasionally)
    if (Math.random() > 0.6) {
      headers['DNT'] = Math.random() > 0.5 ? '1' : '0';
    }
    
    // Add realistic request ID for tracking
    if (Math.random() > 0.7) {
      headers['X-Request-ID'] = generateRequestId();
    }
    
    // Add realistic client info occasionally
    if (Math.random() > 0.8) {
      headers['X-Client-Version'] = '2.0.0';
      headers['X-Client-Platform'] = 'web';
    }
    
    // Browser-specific additional headers
    if (browserName === 'Firefox') {
      // Firefox doesn't send sec-ch-ua headers
      delete headers['sec-ch-ua'];
      delete headers['sec-ch-ua-mobile'];
      delete headers['sec-ch-ua-platform'];
      delete headers['sec-ch-ua-bitness'];
      delete headers['sec-ch-ua-full-version-list'];
    } else if (browserName === 'Safari') {
      // Safari has different behavior
      delete headers['sec-ch-ua'];
      delete headers['sec-ch-ua-mobile'];
      delete headers['sec-ch-ua-platform'];
      delete headers['sec-ch-ua-bitness'];
      delete headers['sec-ch-ua-full-version-list'];
      
      // Safari-specific headers
      if (Math.random() > 0.7) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
      }
    }
    
    return headers;
  } catch (error) {
    console.error('Error generating enhanced headers:', error);
    // Return comprehensive fallback headers
    return generateFallbackHeaders(cookies);
  }
};

// Helper functions for header generation
function generateRealisticUserAgent(browserName, platformName) {
  const platform = platformName || 'Windows';
  const userAgents = {
    'Chrome': [
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
    ],
    'Firefox': [
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0`,
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0`,
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0`
    ],
    'Edge': [
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0`,
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0`
    ],
    'Safari': [
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15`,
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15`
    ]
  };
  
  const agents = userAgents[browserName] || userAgents['Chrome'];
  return agents[Math.floor(Math.random() * agents.length)];
}

function getLatestBrowserVersion(browserName) {
  const versions = {
    'Chrome': '133.0.6943.98',
    'Firefox': '134.0',
    'Edge': '133.0.3065.59',
    'Safari': '18.3'
  };
  return versions[browserName] || versions['Chrome'];
}

function generateSecChUaHeader(browserName, browserVersion) {
  const majorVersion = browserVersion.split('.')[0];
  
  switch (browserName) {
    case 'Chrome':
      return `"Not_A Brand";v="8", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`;
    case 'Edge':
      return `"Not_A Brand";v="8", "Chromium";v="${majorVersion}", "Microsoft Edge";v="${majorVersion}"`;
    case 'Firefox':
      return `"Firefox";v="${majorVersion}"`;
    default:
      return `"Not_A Brand";v="8", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`;
  }
}

function generatePlatformHeader(platformName) {
  const platformMap = {
    'Windows': 'Windows',
    'Mac OS X': 'macOS',
    'iPhone': 'iOS',
    'Android': 'Android',
    'Linux': 'Linux'
  };
  return `"${platformMap[platformName] || 'Windows'}"`;
}

function generateAcceptLanguageHeader(language) {
  const variations = {
    'en-US': [
      'en-US,en;q=0.9',
      'en-US,en;q=0.9,en-GB;q=0.8',
      'en-US,en;q=0.9,es;q=0.8,de;q=0.7',
      'en-US,en;q=0.9,fr;q=0.8'
    ],
    'en-GB': [
      'en-GB,en;q=0.9',
      'en-GB,en;q=0.9,en-US;q=0.8',
      'en-GB,en;q=0.9,fr;q=0.8,de;q=0.7'
    ]
  };
  
  const options = variations[language] || variations['en-US'];
  return options[Math.floor(Math.random() * options.length)];
}

function generateAcceptEncodingHeader(browserName) {
  switch (browserName) {
    case 'Firefox':
      return 'gzip, deflate, br';
    case 'Safari':
      return 'gzip, deflate, br';
    default:
      return 'gzip, deflate, br, zstd';
  }
}

function generateCacheControlHeader(isMapAPI, isFacetAPI) {
  const options = [
    'no-cache',
    'no-cache, no-store',
    'no-cache, no-store, must-revalidate',
    'max-age=0, no-cache'
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function generateAcceptHeader(isMapAPI, isFacetAPI) {
  if (isMapAPI) {
    return 'application/json, text/plain, */*';
  } else if (isFacetAPI) {
    const options = [
      'application/json, text/plain, */*',
      'application/json, text/javascript, */*; q=0.01',
      '*/*'
    ];
    return options[Math.floor(Math.random() * options.length)];
  }
  return '*/*';
}

function generateRealisticReferer(url) {
  const referers = [
    'https://www.ticketmaster.com/',
    'https://www.ticketmaster.com/search',
    'https://www.ticketmaster.com/browse',
    'https://concerts.ticketmaster.com/',
    null // Sometimes no referer
  ];
  
  // 80% chance of having a referer
  if (Math.random() > 0.2) {
    return referers[Math.floor(Math.random() * (referers.length - 1))];
  }
  return null;
}

function generateFullVersionList(browserName, browserVersion) {
  if (browserName === 'Chrome') {
    return `"Not_A Brand";v="8.0.0.0", "Chromium";v="${browserVersion}", "Google Chrome";v="${browserVersion}"`;
  } else if (browserName === 'Edge') {
    return `"Not_A Brand";v="8.0.0.0", "Chromium";v="${browserVersion}", "Microsoft Edge";v="${browserVersion}"`;
  }
  return '';
}

function generateRequestId() {
  return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateFallbackHeaders(cookies) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': 'https://www.ticketmaster.com/',
    'Origin': 'https://www.ticketmaster.com',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="133", "Google Chrome";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Api-Key': 'b462oi7fic6pehcdkzony5bxhe',
    'Cookie': trimCookieString(cookies || '', 8000),
  };
}

/**
 * Trims a cookie string to a specified maximum length while preserving complete cookies
 * @param {string} cookieString - The cookie string to trim
 * @param {number} maxLength - Maximum length for the cookie string
 * @returns {string} - Trimmed cookie string
 */
/**
 * Trims a cookie string to a specified maximum length while preserving complete cookies
 * Prioritizes essential authentication cookies
 * @param {string} cookieString - The cookie string to trim
 * @param {number} maxLength - Maximum length for the cookie string
 * @returns {string} - Trimmed cookie string
 */
function trimCookieString(cookieString, maxLength) {
  // If string is already shorter than max length, return it unchanged
  if (!cookieString || cookieString.length <= maxLength) {
    return cookieString;
  }
  
  // Essential cookies that should be prioritized
  const essentialCookies = [
    'TMUO', 'TMPS', 'TM_TKTS', 'SESSION', 'audit', // Auth cookies
    'CMPS', 'CMID', 'MUID', 'au_id', 'aud', // Identity cookies
    'tmTrackID', 'TapAd_DID', 'uid' // Tracking cookies
  ];
  
  // Split the cookie string into individual cookies
  const cookies = cookieString.split('; ');
  const cookieMap = new Map();
  
  // Parse cookies into a map
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name && value) {
      cookieMap.set(name.trim(), value.trim());
    }
  }
  
  const resultCookies = [];
  let currentLength = 0;
  
  // First, add essential cookies
  for (const essentialName of essentialCookies) {
    if (cookieMap.has(essentialName)) {
      const cookieStr = `${essentialName}=${cookieMap.get(essentialName)}`;
      const additionalLength = currentLength > 0 ? cookieStr.length + 2 : cookieStr.length; // +2 for "; "
      
      if (currentLength + additionalLength <= maxLength) {
        resultCookies.push(cookieStr);
        currentLength += additionalLength;
        cookieMap.delete(essentialName); // Remove from map so we don't add it again
      }
    }
  }
  
  // Then add remaining cookies if there's space
  for (const [name, value] of cookieMap.entries()) {
    const cookieStr = `${name}=${value}`;
    const additionalLength = currentLength > 0 ? cookieStr.length + 2 : cookieStr.length;
    
    if (currentLength + additionalLength <= maxLength) {
      resultCookies.push(cookieStr);
      currentLength += additionalLength;
    } else {
      break; // No more space
    }
  }
  
  return resultCookies.join('; ');
}


function resetCapturedState() {
  capturedState = {
    cookies: null,
    fingerprint: null,
    lastRefresh: null,
    proxy: null,
  };
}

// Header rotation system for better anti-detection
const HeaderRotation = {
  pools: new Map(),
  maxPoolSize: 20,
  rotationInterval: 5 * 60 * 1000, // 5 minutes
  
  // Get a rotated header set
  getRotatedHeaders(fingerprint, cookies, url) {
    const poolKey = this.getPoolKey(fingerprint);
    
    if (!this.pools.has(poolKey)) {
      this.pools.set(poolKey, {
        headers: [],
        lastRotation: Date.now(),
        index: 0
      });
    }
    
    const pool = this.pools.get(poolKey);
    
    // Rotate headers if enough time has passed or pool is empty
    if (Date.now() - pool.lastRotation > this.rotationInterval || pool.headers.length === 0) {
      this.generateHeaderPool(pool, fingerprint, cookies, url);
      pool.lastRotation = Date.now();
      pool.index = 0;
    }
    
    // Get next header set from pool
    const headers = pool.headers[pool.index % pool.headers.length];
    pool.index++;
    
    return headers;
  },
  
  // Generate a pool of header variations
  generateHeaderPool(pool, fingerprint, cookies, url) {
    pool.headers = [];
    
    for (let i = 0; i < this.maxPoolSize; i++) {
      // Create slight variations of the fingerprint
      const variantFingerprint = this.createFingerprintVariant(fingerprint);
      const headers = generateEnhancedHeaders(variantFingerprint, cookies, url);
      
      // Add slight header variations
      this.addHeaderVariations(headers);
      
      pool.headers.push(headers);
    }
  },
  
  // Create fingerprint variants
  createFingerprintVariant(baseFingerprint) {
    const variant = JSON.parse(JSON.stringify(baseFingerprint));
    
    // Vary browser version slightly
    if (variant.browser?.version) {
      const versionParts = variant.browser.version.split('.');
      if (versionParts.length > 2) {
        // Increment patch version randomly
        versionParts[2] = String(parseInt(versionParts[2]) + Math.floor(Math.random() * 5));
        variant.browser.version = versionParts.join('.');
      }
    }
    
    // Vary screen resolution slightly
    if (variant.screen) {
      const resolutions = [
        {width: 1920, height: 1080},
        {width: 1366, height: 768},
        {width: 2560, height: 1440},
        {width: 1280, height: 720},
        {width: 1440, height: 900}
      ];
      const randomRes = resolutions[Math.floor(Math.random() * resolutions.length)];
      variant.screen.width = randomRes.width;
      variant.screen.height = randomRes.height;
    }
    
    return variant;
  },
  
  // Add small variations to headers
  addHeaderVariations(headers) {
    // Vary connection type occasionally
    if (Math.random() > 0.7) {
      headers['Connection'] = Math.random() > 0.5 ? 'keep-alive' : 'close';
    }
    
    // Add or remove optional headers randomly
    if (Math.random() > 0.6) {
      headers['X-Client-Platform'] = 'web';
    }
    
    if (Math.random() > 0.8) {
      headers['X-Browser-ID'] = this.generateBrowserId();
    }
    
    // Vary cache control
    const cacheOptions = [
      'no-cache',
      'no-cache, no-store',
      'no-cache, no-store, must-revalidate',
      'max-age=0, no-cache'
    ];
    headers['Cache-Control'] = cacheOptions[Math.floor(Math.random() * cacheOptions.length)];
  },
  
  // Generate pool key based on fingerprint
  getPoolKey(fingerprint) {
    const browser = fingerprint.browser?.name || 'Chrome';
    const platform = fingerprint.platform?.name || 'Windows';
    return `${browser}-${platform}`;
  },
  
  // Generate realistic browser ID
  generateBrowserId() {
    return 'browser_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
};

// Header validation and optimization system
const HeaderValidator = {
  // Validate headers for common anti-detection issues
  validateHeaders(headers, url) {
    const issues = [];
    
    // Check for required headers
    if (!headers['User-Agent']) {
      issues.push('Missing User-Agent header');
    }
    
    if (!headers['Accept']) {
      issues.push('Missing Accept header');
    }
    
    // Check for inconsistent browser fingerprinting
    if (headers['sec-ch-ua'] && headers['User-Agent']) {
      const chromeInSecCh = headers['sec-ch-ua'].includes('Chrome');
      const chromeInUA = headers['User-Agent'].includes('Chrome');
      
      if (chromeInSecCh !== chromeInUA) {
        issues.push('Inconsistent Chrome detection between sec-ch-ua and User-Agent');
      }
    }
    
    // Check for suspicious header combinations
    if (headers['sec-ch-ua'] && headers['User-Agent'].includes('Firefox')) {
      issues.push('Firefox User-Agent with Chromium sec-ch-ua headers');
    }
    
    // Check for proper API key placement
    if (url && (url.includes('ticketmaster.com') || url.includes('tmol.io'))) {
      if (!headers['X-Api-Key'] && !url.includes('apikey=')) {
        issues.push('Missing API key for Ticketmaster API');
      }
    }
    
    // Check cookie length
    if (headers['Cookie'] && headers['Cookie'].length > 8000) {
      issues.push(`Cookie header too long: ${headers['Cookie'].length} characters`);
    }
    
    return {
      isValid: issues.length === 0,
      issues: issues
    };
  },
  
  // Fix common header issues
  fixHeaders(headers, url) {
    const fixed = { ...headers };
    
    // Ensure User-Agent exists
    if (!fixed['User-Agent']) {
      fixed['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    }
    
    // Ensure Accept header exists
    if (!fixed['Accept']) {
      fixed['Accept'] = '*/*';
    }
    
    // Fix Firefox with sec-ch-ua issue
    if (fixed['User-Agent'].includes('Firefox')) {
      delete fixed['sec-ch-ua'];
      delete fixed['sec-ch-ua-mobile'];
      delete fixed['sec-ch-ua-platform'];
      delete fixed['sec-ch-ua-bitness'];
      delete fixed['sec-ch-ua-full-version-list'];
    }
    
    // Ensure proper API key
    if (url && (url.includes('ticketmaster.com') || url.includes('tmol.io'))) {
      if (!fixed['X-Api-Key'] && !url.includes('apikey=')) {
        fixed['X-Api-Key'] = 'b462oi7fic6pehcdkzony5bxhe';
      }
    }
    
    // Trim cookies if too long
    if (fixed['Cookie'] && fixed['Cookie'].length > 8000) {
      fixed['Cookie'] = trimCookieString(fixed['Cookie'], 8000);
    }
    
    return fixed;
  },
  
  // Get header quality score (0-100)
  getQualityScore(headers, url) {
    let score = 100;
    const validation = this.validateHeaders(headers, url);
    
    // Deduct points for each issue
    score -= validation.issues.length * 10;
    
    // Bonus points for good practices
    if (headers['sec-ch-ua'] && !headers['User-Agent'].includes('Firefox')) {
      score += 5; // Modern browser headers
    }
    
    if (headers['Accept-Language'] && headers['Accept-Language'].includes('q=')) {
      score += 3; // Quality factors in language
    }
    
    if (headers['Accept-Encoding'] && headers['Accept-Encoding'].includes('br')) {
      score += 2; // Brotli compression support
    }
    
    if (headers['Cookie'] && headers['Cookie'].length > 100) {
      score += 5; // Has meaningful cookies
    }
    
    return Math.max(0, Math.min(100, score));
  }
};

// Function to periodically refresh cookies
async function startPeriodicCookieRefresh() {
  // Prevent multiple starts
  if (isPeriodicRefreshStarted) {
    console.log('Periodic cookie refresh already started, skipping...');
    return;
  }
  
  isPeriodicRefreshStarted = true;
  console.log('Starting periodic cookie refresh service...');
  
  // Initial refresh
  await refreshCookiesPeriodically();
  
  // Set up interval for periodic refresh with proper error handling
  const refreshInterval = setInterval(async () => {
    try {
      await refreshCookiesPeriodically();
    } catch (error) {
      console.error('Error in periodic cookie refresh:', error);
      // Don't retry immediately on error, let the interval handle the next attempt
    }
  }, COOKIE_MANAGEMENT.COOKIE_REFRESH_INTERVAL);
  
  // Store the interval ID so we can clear it if needed
  return refreshInterval;
}

async function refreshCookiesPeriodically() {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 30000; // 30 seconds
  
  let retryCount = 0;
  let lastError = null;
  let localContext = null;
  let refreshRecord = null;
  
  while (retryCount < MAX_RETRIES) {
    try {
      console.log("Starting periodic cookie refresh...");
      
      // Get a random active event ID from the database
      let eventId = null;
      
      try {
        // Import Event model to query the database
        const { Event } = await import('./models/index.js');
        
        // Get random active events from the database
        const randomEvents = await Event.aggregate([
          {
            $match: {
              Skip_Scraping: { $ne: true },
              url: { $exists: true, $ne: "" },
            },
          },
          { $sample: { size: 5 } }, // Get 5 random events
          { $project: { Event_ID: 1, url: 1 } },
        ]);

        if (randomEvents && randomEvents.length > 0) {
          // Select one random event from the results
          const selectedEvent = randomEvents[Math.floor(Math.random() * randomEvents.length)];
          eventId = selectedEvent.Event_ID;
          console.log(`Using random database event ${eventId} for cookie refresh`);
        } else {
          console.warn('No active events found in database for cookie refresh');
          // If no events found, we'll try ScraperManager as fallback
        }
      } catch (dbError) {
        console.warn(`Failed to get random event from database: ${dbError.message}`);
        // Continue to fallback approach
      }
      
      // Fallback 1: Try to find an active event ID from scraperManager directly
      if (!eventId && scraperManager) {
        try {
          // First try to get events from the eventUpdateTimestamps Map in scraperManager
          if (scraperManager.eventUpdateTimestamps && scraperManager.eventUpdateTimestamps.size > 0) {
            const eventIds = Array.from(scraperManager.eventUpdateTimestamps.keys());
            eventId = eventIds[Math.floor(Math.random() * eventIds.length)];
            console.log(`Using scraperManager cached event ${eventId} for cookie refresh (database fallback 1)`);
          }
          // If that doesn't work, try calling getEvents() method
          else if (typeof scraperManager.getEvents === 'function') {
            const events = await scraperManager.getEvents();
            if (events && events.length > 0) {
              eventId = events[Math.floor(Math.random() * events.length)];
              console.log(`Using scraperManager.getEvents() event ${eventId} for cookie refresh (database fallback 2)`);
            }
          }
        } catch (error) {
          console.warn('Failed to get active events from scraperManager:', error.message);
        }
      }
      
      // Fallback 2: Try direct database query with minimal conditions as last resort
      if (!eventId) {
        try {
          const anyEvent = await Event.findOne({
            Skip_Scraping: { $ne: true }
          }).select('Event_ID').lean();
          
          if (anyEvent) {
            eventId = anyEvent.Event_ID;
            console.log(`Using last resort database event ${eventId} for cookie refresh (minimal query fallback)`);
          }
        } catch (dbFallbackError) {
          console.warn(`Failed to get any event from database: ${dbFallbackError.message}`);
        }
      }
      
      // If still no event ID found, we cannot proceed
      if (!eventId) {
        throw new Error('No active events available for cookie refresh - cannot proceed without a valid event ID');
      }
      
      // Get the proxy to use for refresh
      const proxyData = await GetProxy();
      
      // Start tracking this refresh operation
      if (!refreshRecord) {
        refreshRecord = await CookieRefreshTracker.startRefresh(eventId, proxyData.proxy);
      }
      
      // Call refreshHeaders with the random event ID from database
      const newState = await refreshHeaders(eventId, proxyData.proxy);
      
      if (newState?.cookies?.length) {
        console.log(`Successfully refreshed cookies using event ${eventId} in periodic refresh`);
        
        // Update the captured state
        cookieManager.capturedState = {
          ...newState,
          lastRefresh: Date.now()
        };
        
        // Save to file
        await cookieManager.saveCookiesToFile(newState.cookies);
        
        // Track successful refresh in database
        await CookieRefreshTracker.markSuccess(
          refreshRecord.refreshId, 
          newState.cookies.length, 
          retryCount
        );
        
        return; // Success, exit the retry loop
      } else {
        console.warn(`Failed to refresh cookies using event ${eventId} - no cookies returned`);
        lastError = new Error(`No cookies returned from refresh for event ${eventId}`);
      }
    } catch (error) {
      console.error(`Error in periodic cookie refresh (attempt ${retryCount + 1}):`, error.message);
      lastError = error;
    }

    // If we get here, we need to retry
    retryCount++;
    if (retryCount < MAX_RETRIES) {
      console.log(`Waiting ${RETRY_DELAY/1000} seconds before retry...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }

  // If we've exhausted all retries, log the final error
  console.error('Failed to refresh cookies after all retries:', lastError?.message);
  
  // Track failed refresh in database
  if (refreshRecord) {
    await CookieRefreshTracker.markFailed(
      refreshRecord.refreshId, 
      lastError?.message || 'Unknown error', 
      retryCount
    );
  }
  
  throw lastError; // Re-throw to be handled by the interval
}

// Cookie refresh via module auto-start is DISABLED.\n// The browser page pool navigates to real event pages and gets cookies automatically.\n// startPeriodicCookieRefresh is kept but never auto-invoked.\n// startPeriodicCookieRefresh().catch(error => {\n//   console.error('Failed to start periodic cookie refresh:', error);\n//   isPeriodicRefreshStarted = false;\n// });

// Export functions that other modules need
export { 
  ScrapeEvent, 
  refreshHeaders, 
  generateEnhancedHeaders, 
  refreshCookiesPeriodically,
  getCapturedData,
  generateEnhancedFingerprint,
  HeaderRotation,
  HeaderValidator
};