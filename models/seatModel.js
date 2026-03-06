import mongoose from "mongoose";

// Individual Seat Schema (as a subdocument)
const seatSchema = new mongoose.Schema({
  number: {
    type: String,
    required: true,
  },
  price: {
    type: Number,
    required: true,
  },
});

// Ticket Schema (as a subdocument)
const ticketSchema = new mongoose.Schema({
  id: {
    type: Number,
    required: true,
  },
  seatNumber: {
    type: Number,
    required: true,
  },
  notes: {
    type: String,
  },
  cost: {
    type: Number,
    required: true,
  },
  faceValue: {
    type: Number,
    required: true,
  },
  taxedCost: {
    type: Number,
    required: true,
  },
  sellPrice: {
    type: Number,
    required: true,
  },
  stockType: {
    type: String,
    required: true,
  },
  eventId: {
    type: Number,
    required: true,
  },
  accountId: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    required: true,
  },
  auditNote: {
    type: String,
  },
});

// Consecutive Group Schema
const consecutiveGroupSchema = new mongoose.Schema(
  {
    inHandDate: {
      type: Date,
      required: true,
    },
    eventId: {
      type: String,
      required: true,
    },
    mapping_id: {
      type: String,
      required: true,
    },
    event_name: {
      type: String,
    },
    venue_name: {
      type: String,
    },
    event_date: {
      type: Date,
    },
    section: {
      type: String,
      required: true,
    },
    row: {
      type: String,
      required: true,
    },
    seatCount: {
      type: Number,
      required: true,
    },
    seatRange: {
      type: String,
      required: true,
    },
    seats: [seatSchema],
    inventory: {
      quantity: {
        type: Number,
        required: true,
      },
      section: {
        type: String,
        required: true,
      },
      hideSeatNumbers: {
        type: Boolean,
        required: true,
      },
      row: {
        type: String,
        required: true,
      },
      cost: {
        type: Number,
        required: true,
      },
      stockType: {
        type: String,
        required: true,
      },
      lineType: {
        type: String,
        required: true,
      },
      seatType: {
        type: String,
        required: true,
      },
      inHandDate: {
        type: Date,
        required: true,
      },
      notes: {
        type: String,
      },
      tags: {
        type: String,
      },
      inventoryId: {
        type: Number,
        required: true,
      },
      offerId: {
        type: String,
        required: true,
      },
      splitType: {
        type: String,
        required: true,
      },
      publicNotes: {
        type: String,
      },
      listPrice: {
        type: Number,
        required: true,
      },
      originalFaceValue: {
        type: Number,
      },
      totalFees: {
        type: Number,
      },
      customSplit: {
        type: String,
      },
      face_price: {
        type: Number,
      },
      taxed_cost: {
        type: Number,
      },
      in_hand: {
        type: Boolean,
      },
      instant_transfer: {
        type: Boolean,
      },
      files_available: {
        type: Boolean,
      },
      zone: {
        type: String,
      },
      shown_quantity: {
        type: String,
      },
      passthrough: {
        type: String,
      },
      event_name: {
        type: String,
      },
      venue_name: {
        type: String,
      },
      event_date: {
        type: Date,
      },
      eventId: {
        type: String,
      },
      mapping_id: {
        type: String,
      },
      tickets: [ticketSchema],
    },
  },
  {
    timestamps: true,
  }
);

// Add compound unique index to prevent duplicate seat groups
consecutiveGroupSchema.index(
  {
    eventId: 1,
    mapping_id: 1,
    section: 1,
    row: 1,
    seatRange: 1,
    seatCount: 1,
    "inventory.quantity": 1
  },
  {
    unique: true,
    name: "unique_seat_group"
  }
);

export const ConsecutiveGroup = mongoose.model(
  "ConsecutiveGroup",
  consecutiveGroupSchema
);
