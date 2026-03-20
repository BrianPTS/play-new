import mongoose from "mongoose";

/**
 * Sale Snapshot Model
 * Records each StubHub sale along with a point-in-time inventory snapshot
 * so we can later analyze at what inventory % levels events sell.
 */
const saleSnapshotSchema = new mongoose.Schema(
  {
    // ── Automatiq Sync order identifiers ──
    orderId: {
      type: Number,
      required: true,
      unique: true,
    },

    // ── Event info ──
    eventId: {
      type: String,
      required: true,
      index: true,
    },
    mapping_id: {
      type: String,
      index: true,
    },
    eventName: String,
    venue: String,
    eventDateTime: Date,

    // ── Sale details ──
    section: {
      type: String,
      required: true,
    },
    row: String,
    seatFrom: String,
    seatTo: String,
    quantity: {
      type: Number,
      required: true,
    },
    pricePerTicket: Number,
    totalProceeds: Number,
    currencyCode: {
      type: String,
      default: "USD",
    },
    saleCreatedAt: Date,

    // ── Inventory snapshot at time of sale ──
    snapshot: {
      // Event-level
      eventAvailableSeats: Number,
      eventVenueCapacity: Number,
      eventAvailabilityPct: Number, // overall venue availability %

      // Per-type counts
      eventStandardSeats: Number,
      eventResaleSeats: Number,
      eventStandardRows: Number,
      eventResaleRows: Number,

      // Section-level (the section the sale was in)
      sectionTotalSeats: Number,     // total seats listed in this section at time of sale
      sectionTotalGroups: Number,    // number of listing groups in this section

      // Derived
      sectionPctOfVenue: Number,     // this section's seats as % of venue capacity
    },
  },
  {
    timestamps: true, // createdAt = when we recorded it, saleCreatedAt = StubHub's timestamp
  }
);

// Indexes for reporting queries
saleSnapshotSchema.index({ eventId: 1, saleCreatedAt: -1 });
saleSnapshotSchema.index({ "snapshot.eventAvailabilityPct": 1 });
saleSnapshotSchema.index({ saleCreatedAt: -1 });

export const SaleSnapshot =
  mongoose.models.SaleSnapshot ||
  mongoose.model("SaleSnapshot", saleSnapshotSchema);
