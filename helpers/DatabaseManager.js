import moment from "moment";
import { Event, ConsecutiveGroup } from "../models/index.js";
import config from "../config/scraperConfig.js";

/**
 * Handles database operations for the scraper
 */
class DatabaseManager {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Fetch an event by ID with specified fields
   */
  async getEventById(eventId, fields = ["Skip_Scraping", "inHandDate", "url"]) {
    try {
      return await Event.findOne({ Event_ID: eventId })
        .select(fields.join(" "))
        .lean();
    } catch (error) {
      this.logger.logWithTime(
        `Error fetching event ${eventId}: ${error.message}`,
        "error"
      );
      return null;
    }
  }

  /**
   * Update event metadata and ticket info
   */
  async updateEventMetadata(eventId, scrapeResult, scheduler) {
    const LOG_LEVEL =
      config && typeof config.LOG_LEVEL !== "undefined"
        ? config.LOG_LEVEL
        : process.env.LOG_LEVEL || 2;
    const CHUNK_SIZE = config && config.CHUNK_SIZE ? config.CHUNK_SIZE : 100;
    const startTime = performance.now();
    const session = await Event.startSession();

    try {
      await session.withTransaction(async () => {
        const event = await Event.findOne({ Event_ID: eventId }).session(
          session
        );
        if (!event) {
          throw new Error(
            `Event ${eventId} not found in database for metadata update`
          );
        }

        const previousTicketCount = event.Available_Seats || 0;
        const currentTicketCount = scrapeResult.reduce(
          (sum, group) => sum + (group.inventory?.quantity || 0), 0
        );

        const metadata = {
          lastUpdate: moment().format("YYYY-MM-DD HH:mm:ss"),
          iterationNumber: (event.metadata?.iterationNumber || 0) + 1,
          scrapeDurationMs: performance.now() - startTime,
          ticketStats: {
            totalTickets: currentTicketCount,
            ticketCountChange: currentTicketCount - previousTicketCount,
            previousTicketCount,
          },
        };

        // First update the basic event info
        await Event.updateOne(
          { Event_ID: eventId },
          {
            $set: {
              Available_Seats: currentTicketCount,
              Last_Updated: new Date(),
              "metadata.basic": metadata,
            },
          }
        ).session(session);

        if (scrapeResult?.length > 0) {
          // Optimized seat comparison
          const existingGroups = await ConsecutiveGroup.find(
            { eventId },
            { section: 1, row: 1, seats: 1, "inventory.listPrice": 1 }
          )
            .lean()
            .session(session);

          const existingSeats = new Set(
            existingGroups.flatMap((g) =>
              g.seats.map((s) => `${g.section}-${g.row}-${s.number}-${s.price}`)
            )
          );

          const newSeats = new Set(
            scrapeResult.flatMap((g) =>
              g.seats.map(
                (s) => `${g.section}-${g.row}-${s}-${g.inventory.listPrice}`
              )
            )
          );

          // ADD DIAGNOSTIC LOGGING
          if (LOG_LEVEL >= 3) {
            // Assuming 3 is a debug level
            this.logger.logWithTime(
              `[Debug ${eventId}] Existing Seats Count: ${existingSeats.size}`,
              "debug"
            );
            if (existingSeats.size > 0)
              this.logger.logWithTime(
                `[Debug ${eventId}] Sample Existing Seats: ${Array.from(
                  existingSeats
                )
                  .slice(0, 3)
                  .join(", ")}`,
                "debug"
              );
            this.logger.logWithTime(
              `[Debug ${eventId}] New Seats Count: ${newSeats.size}`,
              "debug"
            );
            if (newSeats.size > 0)
              this.logger.logWithTime(
                `[Debug ${eventId}] Sample New Seats: ${Array.from(newSeats)
                  .slice(0, 3)
                  .join(", ")}`,
                "debug"
              );
          }

          // ROBUST CHANGE DETECTION LOGIC
          const hasChanges =
            existingSeats.size !== newSeats.size ||
            [...existingSeats].some((s) => !newSeats.has(s)) ||
            [...newSeats].some((s) => !existingSeats.has(s));

          if (LOG_LEVEL >= 3) {
            // Assuming 3 is a debug level
            this.logger.logWithTime(
              `[Debug ${eventId}] Change Detected for ConsecutiveGroup: ${hasChanges}`,
              "debug"
            );
          }

          if (hasChanges) {
            // Bulk delete and insert for better performance
            await ConsecutiveGroup.deleteMany({ eventId }).session(session);

            const groupsToInsert = scrapeResult.map((group) => ({
              eventId,
              section: group.section,
              row: group.row,
              seatCount: group.inventory.quantity,
              seatRange: `${Math.min(...group.seats)}-${Math.max(
                ...group.seats
              )}`,
              seats: group.seats.map((seatNumber) => ({
                number: seatNumber.toString(),
                inHandDate: event.inHandDate,
                price: group.inventory.listPrice,
              })),
              inventory: {
                ...group.inventory,
                tickets: group.inventory.tickets.map((ticket) => ({
                  ...ticket,
                  sellPrice:
                    typeof ticket.sellPrice === "number" &&
                    !isNaN(ticket.sellPrice)
                      ? ticket.sellPrice * 1.25 // Apply 1.25 markup as in original
                      : parseFloat(ticket.cost || ticket.faceValue || 0) * 1.25, // Fallback to cost or faceValue if sellPrice is invalid
                })),
              },
            }));

            // Use fewer documents in a single batch insert
            if (LOG_LEVEL >= 2 && groupsToInsert.length > 0) {
              // Assuming 2 is info level
              this.logger.logWithTime(
                `[Info ${eventId}] Inserting ${
                  groupsToInsert.length
                } groups in chunks. First group sample: ${JSON.stringify(
                  groupsToInsert[0],
                  null,
                  2
                )}`,
                "info"
              );
            }
            for (let i = 0; i < groupsToInsert.length; i += CHUNK_SIZE) {
              // Using CHUNK_SIZE defined at the top
              const chunk = groupsToInsert.slice(i, i + CHUNK_SIZE);
              await ConsecutiveGroup.insertMany(chunk, { session });
            }
            if (LOG_LEVEL >= 2) {
              // Assuming 2 is info level
              this.logger.logWithTime(
                `[Info ${eventId}] Successfully updated ${groupsToInsert.length} consecutive groups.`,
                "info"
              );
            }
          } else {
            if (LOG_LEVEL >= 3) {
              // Assuming 3 is a debug level
              this.logger.logWithTime(
                `[Debug ${eventId}] No change detected for ConsecutiveGroup. Skipping update.`,
                "debug"
              );
            }
          }
        }

        // Final metadata update
        await Event.updateOne(
          { Event_ID: eventId },
          { $set: { "metadata.full": metadata } }
        ).session(session);
      });

      // Schedule next update time
      const nextUpdate = scheduler.scheduleNextUpdate(eventId);

      this.logger.logWithTime(
        `Updated event ${eventId} in ${(performance.now() - startTime).toFixed(
          2
        )}ms, next update by ${nextUpdate.format("HH:mm:ss")}`,
        "success"
      );

      return true;
    } catch (error) {
      this.logger.logError(eventId, "DATABASE_ERROR", error);
      throw error;
    } finally {
      session.endSession();
    }
  }
}

export default DatabaseManager;
