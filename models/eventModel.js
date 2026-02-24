import mongoose from "mongoose";

const eventSchema = new mongoose.Schema(
  {
    mapping_id: {
      type: String,
      required: true,
      unique: true,
    },
    Event_ID: {
      type: String,
      required: true,
      unique: true,
    },
    Event_Name: {
      type: String,
      required: true,
    },
    Event_DateTime: {
      type: Date,
      required: true,
    },
    Venue: String,
    URL: {
      type: String,
      required: true,
    },
    Zone: {
      type: String,
      default: "none",
    },
    Available_Seats: {
      type: Number,
      default: 0,
    },
    Standard_Seats: {
      type: Number,
      default: 0,
    },
    Resale_Seats: {
      type: Number,
      default: 0,
    },
    Standard_Rows: {
      type: Number,
      default: 0,
    },
    Resale_Rows: {
      type: Number,
      default: 0,
    },
    Skip_Scraping: {
      type: Boolean,
      default: true,
    },
    inHandDate: {
      type: Date,
      default: Date.now,
    },
    priceIncreasePercentage: {
      type: Number,
      default: 35, // Default 25% markup
    },
    Last_Updated: {
      type: Date,
      default: Date.now,
    },
    metadata: {
      lastUpdate: String,
      iterationNumber: Number,
      scrapeStartTime: Date,
      scrapeEndTime: Date,
      inHandDate: Date,
      scrapeDurationSeconds: Number,
      totalRunningTimeMinutes: Number,
      ticketStats: {
        totalTickets: Number,
        ticketCountChange: Number,
        previousTicketCount: Number,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
eventSchema.index({ URL: 1 }, { unique: true });

export const Event = mongoose.model("Event", eventSchema);
