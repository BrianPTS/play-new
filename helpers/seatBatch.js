import moment from "moment";
import * as fs from 'fs';
// Function to generate unique 10-digit inventory ID

// Global Filters
const GLOBAL_FILTERS = {
  inventoryType: ["Primary", "Official Platinum", "Aisle Seating","Standard","Standard Ticket","resale"], // e.g., ['primary', 'resale'] - empty means no filter, strings to check for (case-insensitive)


  inventoryStatus: ["Available"], // e.g., ['available', 'sold'] - empty means no filter, strings to check for (case-insensitive)


  description: [

    "Standard Ticket",
    "GA Lawn",
    "General Admission Standing",
    "Standard Admission",
    "Reserved",
    "Reserved Ticket"

  ], // e.g., ['obstructed view', 'aisle'] - empty means no filter, strings to check for (case-insensitive)
  accessibility: [
    // Empty array means exclude ALL accessibility seats
  ], // e.g., ['wheelchair', 'hearing'] - empty means no filter, strings to check for (case-insensitive)
  excludeAccessibility: true, // Set to true to exclude ALL accessibility seats
  excludeWheelchair: true, // Set to true to exclude wheelchair accessible seats (sections containing 'WC')

  // Section density filter: exclude sections where available listings are below this
  // percentage of total section capacity. Set to 0 to disable.
  // Example: 0.10 = exclude sections with less than 10% of seats available
  sectionDensityThreshold: 0.10,
  // Minimum total seats a section must have for the density filter to apply.
  // Small sections (e.g., boxes, suites) are skipped to avoid false exclusions.
  sectionDensityMinCapacity: 10,
};
//it will break map into seats
function GetMapSeats(data) {
  let seatArray = [];
  if (
    data &&
    data.pages &&
    data.pages.length > 0 &&
    data.pages[0] &&
    data.pages[0].segments
  ) {
    data.pages[0].segments.map((composit) => {
      if (composit?.segments) {
        composit.segments.map((SECTION) => {
          if (SECTION.segments && SECTION.segments.length > 0)
            SECTION.segments.map((ROW) => {
              ROW.placesNoKeys.map((seat) => {
                seatArray.push({
                  section: SECTION?.name,
                  row: ROW?.name,
                  seat: seat[1],
                  seatId: seat[0],
                });
              });
            });
          else {
            // GeneralAdmission seats - assuming they might be directly under SECTION or have a different structure
            // This is a placeholder and might need adjustment based on the actual GA data structure
            if (SECTION.placesNoKeys && Array.isArray(SECTION.placesNoKeys)) {
              SECTION.placesNoKeys.map((seat) => {
                seatArray.push({
                  section: SECTION?.name,
                  row: "GA", // General Admission typically doesn't have a specific row
                  seat: seat[1], // Assuming seat number is at index 1
                  seatId: seat[0], // Assuming seat ID is at index 0
                });
              });
            } else if (SECTION.name && SECTION.id) { // Fallback if placesNoKeys is not present but section has name and id
                seatArray.push({
                    section: SECTION?.name,
                    row: "GA",
                    seat: "GA", // Placeholder for seat number if not available
                    seatId: SECTION?.id, // Use section id as seatId if specific seatId is not available
                });
            }
            // console.log("Processing General Admission for SECTION:", SECTION);
          }
        });
      }
    });
  }

  return seatArray;
}
function breakArray(arr) {
  let result = [];
  let subarray = [arr[0]];

  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] + 1 !== arr[i + 1]) {
      result.push(subarray);
      subarray = [arr[i + 1]];
    } else {
      subarray.push(arr[i + 1]);
    }
  }

  result.push(subarray);
  return result;
}

function CreateConsicutiveSeats(data) {
  const mergedData = [];

  data.forEach((item) => {
    let merged = false;
    
    // Try to find an existing group that this item can be merged with
    for (let group of mergedData) {
      if (group.section === item.section &&
          group.row === item.row &&
          group.offerId === item.offerId) {
        
        // Check if seats are consecutive (either direction)
        const groupLastSeat = Math.max(...group.seats);
        const groupFirstSeat = Math.min(...group.seats);
        const itemFirstSeat = Math.min(...item.seats);
        const itemLastSeat = Math.max(...item.seats);
        
        // Check if they can be merged (consecutive) - fixed logic
        if (groupLastSeat + 1 === itemFirstSeat || itemLastSeat + 1 === groupFirstSeat) {
          group.seats.push(...item.seats);
          group.seats.sort((a, b) => a - b); // Keep seats sorted
          merged = true;
          break;
        }
      }
    }
    
    if (!merged) {
      mergedData.push({
        amount: item.amount,
        lineItemType: item.lineItemType,
        section: item.section,
        row: item.row,
        seats: [...item.seats].sort((a, b) => a - b), // Ensure seats are sorted
        offerId: item.offerId,
        accessibility: item?.accessibility,
        descriptionId: item?.descriptionId,
        attributes: item?.attributes,
      });
    }
  });

  // Second pass: try to merge any remaining consecutive groups
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < mergedData.length; i++) {
      for (let j = i + 1; j < mergedData.length; j++) {
        const group1 = mergedData[i];
        const group2 = mergedData[j];
        
        if (group1.section === group2.section &&
            group1.row === group2.row &&
            group1.offerId === group2.offerId) {
          
          const group1LastSeat = Math.max(...group1.seats);
          const group1FirstSeat = Math.min(...group1.seats);
          const group2FirstSeat = Math.min(...group2.seats);
          const group2LastSeat = Math.max(...group2.seats);
          
          // Check if they can be merged (consecutive)
          if (group1LastSeat + 1 === group2FirstSeat || group2LastSeat + 1 === group1FirstSeat) {
            group1.seats.push(...group2.seats);
            group1.seats.sort((a, b) => a - b);
            mergedData.splice(j, 1); // Remove the merged group
            changed = true;
            break;
          }
        }
      }
      if (changed) break;
    }
  }

  return mergedData;
}
function getSplitType(arr, offer) {
  var length = arr.length;

  if (
    offer &&
    offer?.ticketTypeUnsoldQualifier &&
    (offer?.ticketTypeUnsoldQualifier == "2PACKHOLD" ||
      offer?.ticketTypeUnsoldQualifier == "222PA1HOLD" ||
      offer?.ticketTypeUnsoldQualifier == "22BOGOHOLD")
  ) {
    if (length === 2) {
      return "2";
    } else if (length === 4) {
      return "2,4";
    } else if (length >= 6) {
      var numbers = Array.from(
        { length: length % 2 == 0 ? length : length - 1 },
        (_, i) => (i % 2 == 0 ? i + 2 : undefined)
      ).filter((x) => x != undefined);
      return numbers.join(",");
    } else return "2";
  } else {
    if (length === 2) {
      return "2";
    } else if (length === 3) {
      return "3";
    } else if (length === 4) {
      return "2,4";
    } else if (length >= 5) {
      var numbers = Array.from({ length: length }, (_, i) => i + 1).filter(
        (x) => x != 1
      );
      return numbers.join(",");
    } else return "1";
  }
}

function CreateInventoryAndLine(data, offer, event, descriptions, resaleClassification = new Map()) {

  let _descriptions = descriptions.find(
    (x) => x.descriptionId == data?.descriptionId
  );
  let allDescriptions = "";
  const tags = new Set(); // track what we already appended to avoid duplicates

  // Case-insensitive check on attributes array
  const attrsLower = (data.attributes || []).map((a) => a.toLowerCase());
  if (attrsLower.some((a) => a.includes("obstructed"))) {
    allDescriptions += ", Obstructed View";
    tags.add("obstructed");
  }

  if (
    data?.accessibility.includes("sight") ||
    data?.accessibility.includes("hearing")
  ) {
    allDescriptions += ", deaf/hard, blind/low";
    tags.add("accessibility");
  }

  // Check offer name (case-insensitive)
  const offerNameLower = offer?.name?.toLowerCase() || "";
  if (offerNameLower.includes("limited/obstructed")) {
    if (!tags.has("obstructed")) {
      allDescriptions += ", Limited/Obstructed View";
      tags.add("obstructed");
    }
    if (!tags.has("limited")) {
      allDescriptions += ", Limited View";
      tags.add("limited");
    }
  } else {
    if (offerNameLower.includes("obstructed") && !tags.has("obstructed")) {
      allDescriptions += ", Obstructed View";
      tags.add("obstructed");
    }
    if (offerNameLower.includes("limited view") && !tags.has("limited")) {
      allDescriptions += ", Limited View";
      tags.add("limited");
    }
  }

  // Always check descriptions for anything not yet tagged
  if (_descriptions) {
    _descriptions.descriptions.map((x) => {
      const xl = x.toLowerCase();
      if (xl.includes("obstructed") && !tags.has("obstructed")) {
        allDescriptions += ", Obstructed View";
        tags.add("obstructed");
      }
      if (xl.includes("limited") && !tags.has("limited")) {
        allDescriptions += ", Limited View";
        tags.add("limited");
      }
      if (xl.includes("side view") && !tags.has("side")) {
        allDescriptions += ", Side View";
        tags.add("side");
      }
      if (xl.includes("behind") && !tags.has("behind")) {
        allDescriptions += ", Behind The Stage";
        tags.add("behind");
      }
      if (xl.includes("rear") && !tags.has("rear")) {
        allDescriptions += ", Rear View Seating";
        tags.add("rear");
      }
      if (xl.includes("partial") && !tags.has("partial")) {
        allDescriptions += ", Partial View";
        tags.add("partial");
      }
      if ((xl.includes("deaf") || xl.includes("blind")) && !tags.has("accessibility")) {
        allDescriptions += ", deaf/hard, blind/low";
        tags.add("accessibility");
      }
    });
  }

  // Classify charges using TM's fee_type field when available, falling back to reason-based logic.
  // TM charge objects can include: { reason, type, amount, fee_type }
  //   fee_type: "PER ORDER" (split across seats) or "PER TICKET" (applied to each seat)
  //   Known reasons: order_processing, service, facility, delivery, service_tax, face_value_tax, service_tax_2
  const charges = offer?.charges || [];

  // Per-order fees: use fee_type if present, otherwise fall back to known per-order reasons
  let perOrderTotal = parseFloat(
    charges
      .filter((x) =>
        x?.fee_type
          ? x.fee_type === "PER ORDER"
          : x?.reason === "order_processing" || x?.reason === "delivery"
      )
      .reduce((total, item) => total + item.amount, 0)
  );
  let perOrderPerSeat = perOrderTotal / data?.seats.length;

  // Per-ticket fees: everything that is NOT per-order
  let perTicketTotal = parseFloat(
    charges
      .filter((x) =>
        x?.fee_type
          ? x.fee_type !== "PER ORDER"
          : x?.reason !== "order_processing" && x?.reason !== "delivery"
      )
      .reduce((total, item) => total + item.amount, 0)
  );

  // Face Value (true TM face value before any fees)
  let faceValue = offer?.faceValue;
  let totalFees = perOrderPerSeat + perTicketTotal;
  let totalCost = faceValue + totalFees;

  return {
    inventory: {
      quantity: data?.seats.length,
      section: data?.section,
      hideSeatNumbers: true,
      row: data?.row,
      cost: totalCost,
      seats: data?.seats,
      eventId: event.eventMappingId,
      stockType: "MOBILE_TRANSFER",
      lineType: "PURCHASE",
      seatType: "CONSECUTIVE",
      inHandDate: moment(event?.inHandDate).format("YYYY-MM-DD"), // Format: 2024-12-22
      // "notes": "+stub +geek +tnet +vivid +tevo +pick",
      notes: "-tnow -tmplus -stub",
      tags: "AWS",
      offerId: data?.offerId,
      splitType: offer?.inventoryType?.toLowerCase() === "resale" ? "DEFAULT": "NEVERLEAVEONE" ,
      resaleType: offer?.inventoryType?.toLowerCase() === "resale"
        ? (resaleClassification.get(data?.offerId) || "unknown")
        : null,
      publicNotes: "xfer" + allDescriptions,
      listPrice: totalCost,
      originalFaceValue: faceValue,
      totalFees: totalFees,
      customSplit: getSplitType(data?.seats, offer),
      tickets: data?.seats.map((y) => {
        return {
          id: 0,
          seatNumber: y,
          notes: "string",
          cost: totalCost,
          faceValue: faceValue,
          taxedCost: totalCost,
          sellPrice: totalCost,
          stockType: "HARD",
          eventId: 0,
          accountId: 0,
          status: "AVAILABLE",
          auditNote: "string",
        };
      }),
    },
    amount: 0,
    lineItemType: "INVENTORY",
    eventId: event?.eventMappingId,
    dbId: `${data?.seats.join("")}-${data?.row}-${data?.section}-${
      event?.eventMappingId
    }`,
    seats: data?.seats,
    row: data?.row,
    section: data?.section,
  };
}

export const AttachRowSection = (
  data,
  mapData,
  offers,
  event,
  descriptions,
  resaleClassification = new Map()
) => {
  let allAvailableSeats = GetMapSeats(mapData);
  let mapPlacesIndex = allAvailableSeats.map((x) => x.seatId);
  // fs.writeFileSync("debug/allAvailableSeats.json", JSON.stringify(allAvailableSeats));

  // ── Section density filter ───────────────────────────────────────────
  // Compare total capacity (map) vs available listings (facets) per section.
  // Sections below the threshold are excluded automatically.
  let excludedSectionsByDensity = new Set();

  if (GLOBAL_FILTERS.sectionDensityThreshold > 0) {
    // Total seats per section from venue map (full capacity)
    const totalSeatsBySection = new Map();
    for (const seat of allAvailableSeats) {
      const sec = seat.section;
      totalSeatsBySection.set(sec, (totalSeatsBySection.get(sec) || 0) + 1);
    }

    // Available seats per section from facets data
    const availableSeatsBySection = new Map();
    if (Array.isArray(data)) {
      for (const facet of data) {
        const sec = facet.section || '';
        if (!sec) continue;
        const placeCount = facet.places ? facet.places.length : 0;
        availableSeatsBySection.set(sec, (availableSeatsBySection.get(sec) || 0) + placeCount);
      }
    }

    // Evaluate each section
    for (const [section, totalSeats] of totalSeatsBySection) {
      // Skip small sections (boxes, suites, etc.) — too few seats for meaningful density
      if (totalSeats < GLOBAL_FILTERS.sectionDensityMinCapacity) continue;

      const availableSeats = availableSeatsBySection.get(section) || 0;
      const density = availableSeats / totalSeats;

      if (density < GLOBAL_FILTERS.sectionDensityThreshold) {
        excludedSectionsByDensity.add(section);
        console.log(
          `[DensityFilter ${event.eventId}] Excluding section "${section}": ` +
          `${availableSeats}/${totalSeats} available (${(density * 100).toFixed(1)}% < ${(GLOBAL_FILTERS.sectionDensityThreshold * 100).toFixed(0)}% threshold)`
        );
      }
    }

    if (excludedSectionsByDensity.size > 0) {
      console.log(
        `[DensityFilter ${event.eventId}] Excluded ${excludedSectionsByDensity.size} sparse sections out of ${totalSeatsBySection.size} total`
      );
    }
  }
  // ── End section density filter ───────────────────────────────────────

  let returnData = [];
  //get all seats number by seat id
  let customData = data
    .map((x) => {
      if (!x.places || x.places.length === 0) {
        return undefined;
      }

      // Verify all places belong to the same section
      const sectionMap = {};
      const allPlaces = x.places
        .map((placeId) => {
          const index = mapPlacesIndex.indexOf(placeId);
          if (index === -1) {
            return null;
          }
          
          const seatInfo = allAvailableSeats[index];
          if (!seatInfo) return null;
          
          // Track sections for verification
          sectionMap[seatInfo.section] = true;
          
          return { ...seatInfo, offerId: x.offerId };
        })
        .filter(Boolean);

      // Skip if no valid seats found
      if (allPlaces.length === 0) {
        return undefined;
      }

      // Verify all seats belong to same section
      const sections = Object.keys(sectionMap);
      // if (sections.length > 1) {
      //   console.warn('Mixed sections in seat group:', sections.join(', '));
      // }

      return {
        section: allPlaces[0].section,
        row: "",
        seats: allPlaces,
        eventId: event?.eventMappingId,
        offerId: x.offerId,
        accessibility: x?.accessibility,
        descriptionId: x?.descriptionId,
        attributes: x?.attributes,
      };
    })
    .filter(Boolean);

  //it will check if pair has same row as some events are giving pair of different row
  let groupedSeats = [];
  customData.forEach((seatGroup) => {
    const rows = [...new Set(seatGroup.seats.map((seat) => seat.row))];
    rows.forEach((row) => {
      const seatsInRow = seatGroup.seats.filter((seat) => seat.row === row);
      groupedSeats.push({
        section: seatGroup.section,
        seats: seatsInRow,
        eventId: seatGroup.eventId,
        offerId: seatGroup.offerId,
        accessibility: seatGroup.accessibility,
        descriptionId: seatGroup.descriptionId,
        attributes: seatGroup.attributes,
      });
    });
  });

  //add row and get seats in order
  groupedSeats
    .map((x) => {
      if (x?.seats.length > 0) {
        return {
          ...x,
          row: x?.seats[0]?.row,
          seats: x?.seats
            .map((y) => parseInt(y.seat))
            .sort((a, b) => {
              return a - b;
            }),
        };
      } else {
        return undefined;
      }
    })
    .filter((x) => x != undefined)

    //break seats if it is not consicutive ex [1,2,3,6,7] => [1,2,3],[6,7]
    .map((x) => {
      let breakOBJ = breakArray(x.seats);

      if (breakOBJ.length > 1) {
        breakOBJ.map((y) => {
          returnData.push({
            ...x,
            seats: y,
          });
        });
      } else {
        returnData.push(x);
      }
    });

  //it will make consicutive seats ex [2],[4],[3] => [2,3,4]
  returnData = CreateConsicutiveSeats(returnData);
  // fs.writeFileSync("debug/consicutive.json", JSON.stringify(returnData));

  //attach offer

  const finalData = returnData
      .map((x) => {
        // Section density exclusion — skip sections with too few available listings
        if (excludedSectionsByDensity.has(x.section)) {
          return undefined;
        }

        let offerGet = offers.find((e) => e.offerId == x.offerId);

        // Check accessibility exclusion filters first
        if (GLOBAL_FILTERS.excludeAccessibility) {
          // Check for any accessibility indicators in various fields
          const hasAccessibilityIndicators = (
            // Check section name for wheelchair/accessibility indicators
            (x.section && (
              x.section.toUpperCase().includes('WC') ||
              x.section.toUpperCase().includes('WHEELCHAIR') ||
              x.section.toUpperCase().includes('ACCESSIBLE') ||
              x.section.toUpperCase().includes('ADA') ||
              x.section.toUpperCase().includes('HANDICAP')
            )) ||
            // Check accessibility field
            (x.accessibility && x.accessibility.length > 0) ||
            // Check attributes for accessibility terms
            (x.attributes && x.attributes.some(attr => 
              attr.toLowerCase().includes('wheelchair') ||
              attr.toLowerCase().includes('accessible') ||
              attr.toLowerCase().includes('ada') ||
              attr.toLowerCase().includes('handicap') ||
              attr.toLowerCase().includes('sight') ||
              attr.toLowerCase().includes('hearing')
            )) ||
            // Check offer name for accessibility terms
            (offerGet && offerGet.name && (
              offerGet.name?.toLowerCase().includes('wheelchair') ||
              offerGet.name?.toLowerCase().includes('accessible') ||
              offerGet.name?.toLowerCase().includes('ada') ||
              offerGet.name?.toLowerCase().includes('handicap')
            ))
          );
          
          if (hasAccessibilityIndicators) {
            // console.log(`Filtering out accessibility seat. Section: ${x.section}, Accessibility: ${x.accessibility}`);
            return undefined;
          }
        }

        // Legacy wheelchair exclusion filter (kept for backward compatibility)
        if (GLOBAL_FILTERS.excludeWheelchair && x.section && x.section.toUpperCase().includes('WC')) {
          // console.log(`Filtering out wheelchair seat. Section: ${x.section}`);
          return undefined;
        }

        // New Global Filtering Logic: Item must match at least one active global filter category.
        let keepItemBasedOnGlobalFilters = false;
        const inventoryFilterActive = GLOBAL_FILTERS.inventoryType.length > 0;
        const descriptionFilterActive = GLOBAL_FILTERS.description.length > 0;
        const accessibilityFilterActive = GLOBAL_FILTERS.accessibility.length > 0;

        const anyGlobalFilterActive = inventoryFilterActive || descriptionFilterActive || accessibilityFilterActive;

        if (!anyGlobalFilterActive) {
            keepItemBasedOnGlobalFilters = true; // No global filters are active, so item passes this stage
        } else {
            // Check Inventory Type Filter
            if (inventoryFilterActive) {
                if (offerGet && GLOBAL_FILTERS.inventoryType.some(filterType => 
                    offerGet.inventoryType?.toLowerCase().includes(filterType.toLowerCase())
                )) {
                    keepItemBasedOnGlobalFilters = true;
                }
            }

            // Check Description Filter (only if not already marked to keep)
            if (!keepItemBasedOnGlobalFilters && descriptionFilterActive) {
                let descriptionMatched = false;
                const offerNameLower = offerGet?.name?.toLowerCase() || "";
                const offerDescriptionLower = offerGet?.description?.toLowerCase() || "";
                
                if (GLOBAL_FILTERS.description.some(filterTerm => 
                    offerNameLower.includes(filterTerm.toLowerCase()) || 
                    offerDescriptionLower.includes(filterTerm.toLowerCase())
                )) {
                    descriptionMatched = true;
                }

                if (!descriptionMatched && descriptions) {
                    const relevantDescriptionDoc = descriptions.find(d => d.descriptionId === x.descriptionId);
                    if (relevantDescriptionDoc && relevantDescriptionDoc.descriptions) {
                        const descriptionsTextLower = relevantDescriptionDoc.descriptions.join(' ').toLowerCase();
                        if (GLOBAL_FILTERS.description.some(filterTerm => descriptionsTextLower.includes(filterTerm.toLowerCase()))) {
                            descriptionMatched = true;
                        }
                    }
                }
                
                if (!descriptionMatched && x.attributes && x.attributes.length > 0){
                    const attributesTextLower = x.attributes.join(' ').toLowerCase();
                    if (GLOBAL_FILTERS.description.some(filterTerm => attributesTextLower.includes(filterTerm.toLowerCase()))) {
                        descriptionMatched = true;
                    }
                }

                if (descriptionMatched) {
                    keepItemBasedOnGlobalFilters = true;
                }
            }

            // Check Accessibility Filter (only if not already marked to keep)
            if (!keepItemBasedOnGlobalFilters && accessibilityFilterActive) {
                if (x.accessibility) {
                    const accessibilityLower = x.accessibility.toLowerCase();
                    if (GLOBAL_FILTERS.accessibility.some(filterTerm => accessibilityLower.includes(filterTerm.toLowerCase()))) {
                        keepItemBasedOnGlobalFilters = true;
                    }
                }
            }
        }

        if (!keepItemBasedOnGlobalFilters) {
            // console.log(`Filtering out by global filters combination. Item: ${x.section}-${x.row}-${x.seats}, Offer: ${offerGet?.name}`);
            return undefined;
        }

        // Original offer filtering logic
        if (offerGet) {
          if (offerGet.name == "Special Offers") {
            return undefined;
          } else if (offerGet.name == "Summer's Live 4 Pack") {
            return undefined;
          } else if (offerGet.name == "Me + 3 4-Pack Offer") {
            return undefined;
          } else if (/4[\s-]*pack/i.test(offerGet.name)) {
            return undefined;
          } if (/four[\s-]*pack/i.test(offerGet.name)) {
            return undefined;
          } else if (offerGet?.protected == true) {
            return undefined;
          } else {
            return CreateInventoryAndLine(x, offerGet, event, descriptions, resaleClassification);
          }
        } else {
          return undefined;
        }
        
      })
      .filter((x) => x != undefined)
      .filter((obj, index, self) => {
        // Convert dbId value to string to compare
        var dbId = obj.dbId.toString();

        // Check if the current dbId is the first occurrence in the array
        return index === self.findIndex((o) => o.dbId.toString() === dbId);
      })
      // .filter((x) => x.inventory.quantity > 1) // Commented out to prevent losing single seats

      //remove duplicate
      .filter((obj, index, self) => {
        // Check if any other object has the same row and section
        const hasDuplicate = self.some((otherObj, otherIndex) => {
          return (
            index !== otherIndex && // Exclude the current object from comparison
            obj.row === otherObj.row &&
            obj.section === otherObj.section &&
            obj.seats.some((seat) => otherObj.seats.includes(seat))
          );
        });

        return !hasDuplicate || index === 0; // Keep the first object or objects without duplicates
      });

  // fs.writeFileSync(`debug/seatBatch_${event.eventId}.json`, JSON.stringify(finalData, null, 2));
  
  // // Debug: Final processed data after all filters
  // fs.writeFileSync(`debug/finalProcessed_${event.eventId}.json`, JSON.stringify(finalData, null, 2));
  // console.log(`Final processed data written to debug/finalProcessed_${event.eventId}.json - Total items: ${finalData.length}`);

  return finalData;
};
