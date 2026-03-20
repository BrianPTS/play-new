import dotenv from "dotenv";
import { Event, ConsecutiveGroup, SaleSnapshot } from "../models/index.js";

dotenv.config();

/**
 * Automatiq Sync API — Sales / Orders Poller
 *
 * Periodically polls the Automatiq Sync API for new/updated orders.
 * When a sale is detected, captures a point-in-time inventory snapshot
 * (event-level availability % and section-level seat counts) and stores it
 * so we can later report on what inventory % levels events sell at.
 *
 * Automatiq API reference: https://docs.automatiq.com/
 * Auth: X-Company-Id + X-Api-Token headers
 * Base URL: https://app.sync.automatiq.com/sync/api
 */
class SalesPoller {
  constructor() {
    this.baseUrl = "https://app.sync.automatiq.com/sync/api";
    this.companyId = process.env.SYNC_COMPANY_ID;
    this.apiToken = process.env.SYNC_API_TOKEN;
    this.requestTimeout = 30000;
    this.maxRetries = 3;
    this.pollIntervalMs = 2 * 60 * 1000; // poll every 2 minutes
    this.timer = null;
    this.isRunning = false;
    this.lastPollTime = null; // ISO string — fetch orders updated since this time
  }

  // ── HTTP helper (mirrors SyncService auth pattern) ──

  async request(method, path) {
    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.requestTimeout
        );

        const response = await fetch(url, {
          method,
          headers: {
            "X-Company-Id": this.companyId,
            "X-Api-Token": this.apiToken,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `HTTP ${response.status}: ${text || response.statusText}`
          );
        }

        return await response.json();
      } catch (error) {
        lastError = error;
        console.error(
          `[SalesPoller] ${method} ${path} attempt ${attempt + 1}/${this.maxRetries} failed:`,
          error.message
        );
        if (attempt < this.maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  // ── Fetch recent orders from Automatiq Sync API ──

  async fetchRecentOrders() {
    let path = "/orders";
    const params = [];

    if (this.lastPollTime) {
      params.push(`updated_since=${encodeURIComponent(this.lastPollTime)}`);
    } else {
      // On first run, look back 24 hours
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      params.push(`updated_since=${encodeURIComponent(since)}`);
    }

    if (params.length > 0) {
      path += `?${params.join("&")}`;
    }

    const data = await this.request("GET", path);
    // Automatiq may return { orders: [...] } or an array directly
    return data.orders || data.items || (Array.isArray(data) ? data : []);
  }

  // ── Build inventory snapshot for an event + section ──

  async buildSnapshot(eventId, section) {
    // Event-level data
    const event = await Event.findOne({ Event_ID: eventId })
      .select(
        "Available_Seats Venue_Capacity Availability_Percentage Standard_Seats Resale_Seats Standard_Rows Resale_Rows"
      )
      .lean();

    if (!event) return null;

    // Section-level data from ConsecutiveGroups
    const sectionGroups = await ConsecutiveGroup.find({ eventId, section })
      .select("inventory.quantity")
      .lean();

    const sectionTotalSeats = sectionGroups.reduce(
      (sum, g) => sum + (g.inventory?.quantity || 0),
      0
    );
    const sectionTotalGroups = sectionGroups.length;

    const venueCapacity = event.Venue_Capacity || 0;

    return {
      eventAvailableSeats: event.Available_Seats || 0,
      eventVenueCapacity: venueCapacity,
      eventAvailabilityPct: event.Availability_Percentage ?? null,
      eventStandardSeats: event.Standard_Seats || 0,
      eventResaleSeats: event.Resale_Seats || 0,
      eventStandardRows: event.Standard_Rows || 0,
      eventResaleRows: event.Resale_Rows || 0,
      sectionTotalSeats,
      sectionTotalGroups,
      sectionPctOfVenue:
        venueCapacity > 0
          ? Math.round((sectionTotalSeats / venueCapacity) * 100)
          : null,
    };
  }

  // ── Resolve an Automatiq order to our internal event ──

  async resolveEvent(order) {
    // Automatiq orders typically include event_id or event_mapping_id
    // Try multiple field names the API might use
    const mappingId =
      order.event_mapping_id ||
      order.mapping_id ||
      order.eventMappingId ||
      null;
    const eventId =
      order.event_id || order.eventId || order.EventId || null;

    let event = null;

    if (mappingId) {
      event = await Event.findOne({ mapping_id: String(mappingId) })
        .select("Event_ID mapping_id Event_Name Venue Event_DateTime")
        .lean();
    }

    if (!event && eventId) {
      event = await Event.findOne({ Event_ID: String(eventId) })
        .select("Event_ID mapping_id Event_Name Venue Event_DateTime")
        .lean();
    }

    return event;
  }

  // ── Process a single order ──

  async processOrder(order) {
    // Automatiq order ID
    const orderId = order.id || order.order_id || order.orderId;
    if (!orderId) return;

    // Skip if we already recorded this order
    const existing = await SaleSnapshot.findOne({ orderId: orderId })
      .select("_id")
      .lean();
    if (existing) return;

    // Resolve our internal event
    const event = await this.resolveEvent(order);
    if (!event) {
      console.log(
        `[SalesPoller] Could not resolve event for order ${orderId}, skipping`
      );
      return;
    }

    // Extract section/row/seat info from order
    // Automatiq orders may use different field names
    const section =
      order.section || order.Section || order.seat_section || "Unknown";
    const row = order.row || order.Row || order.seat_row || null;
    const seatFrom =
      order.seat_from || order.low_seat || order.seatFrom || null;
    const seatTo = order.seat_to || order.high_seat || order.seatTo || null;
    const quantity =
      order.quantity || order.num_tickets || order.numberOfTickets || 1;

    // Build snapshot of current inventory state
    const snapshot = await this.buildSnapshot(event.Event_ID, section);

    if (!snapshot) {
      console.log(
        `[SalesPoller] No event data for ${event.Event_ID}, recording order without snapshot`
      );
    }

    // Extract price info
    const pricePerTicket =
      order.price_per_ticket ||
      order.unit_price ||
      order.pricePerTicket ||
      order.price ||
      null;
    const totalProceeds =
      order.total_price ||
      order.total ||
      order.totalPrice ||
      (pricePerTicket && quantity ? pricePerTicket * quantity : null);

    await SaleSnapshot.create({
      orderId: orderId, // reusing field name for Automatiq order ID
      eventId: event.Event_ID,
      mapping_id: event.mapping_id,
      eventName: event.Event_Name,
      venue: event.Venue,
      eventDateTime: event.Event_DateTime,
      section,
      row,
      seatFrom: seatFrom ? String(seatFrom) : null,
      seatTo: seatTo ? String(seatTo) : null,
      quantity,
      pricePerTicket,
      totalProceeds,
      currencyCode: order.currency || order.currency_code || "USD",
      saleCreatedAt: order.created_at || order.createdAt
        ? new Date(order.created_at || order.createdAt)
        : new Date(),
      snapshot: snapshot || {},
    });

    const pct = snapshot?.eventAvailabilityPct;
    console.log(
      `[SalesPoller] Recorded order #${orderId} — ${event.Event_Name} | ` +
        `${section} Row ${row || "?"} | ${quantity} tix | ` +
        `Event availability: ${pct !== null && pct !== undefined ? pct + "%" : "N/A"}`
    );
  }

  // ── Poll cycle ──

  async poll() {
    if (!this.companyId || !this.apiToken) {
      console.warn(
        "[SalesPoller] SYNC_COMPANY_ID or SYNC_API_TOKEN not set, skipping poll"
      );
      return;
    }

    try {
      const orders = await this.fetchRecentOrders();
      if (orders.length > 0) {
        console.log(`[SalesPoller] Found ${orders.length} recent order(s)`);
        for (const order of orders) {
          try {
            await this.processOrder(order);
          } catch (err) {
            // Duplicate key = already recorded, skip silently
            if (err.code === 11000) continue;
            console.error(
              `[SalesPoller] Error processing order ${order.id || order.order_id}:`,
              err.message
            );
          }
        }
      }
      this.lastPollTime = new Date().toISOString();
    } catch (err) {
      console.error("[SalesPoller] Poll cycle error:", err.message);
    }
  }

  // ── Lifecycle ──

  start() {
    if (this.isRunning) {
      console.log("[SalesPoller] Already running");
      return;
    }
    this.isRunning = true;
    console.log(
      `[SalesPoller] Starting — polling every ${this.pollIntervalMs / 1000}s`
    );

    // Immediate first poll
    this.poll();

    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log("[SalesPoller] Stopped");
  }
}

// Singleton
const salesPoller = new SalesPoller();
export default salesPoller;
