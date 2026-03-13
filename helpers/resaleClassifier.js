/**
 * Resale Classifier
 *
 * Classifies resale listings as likely "verified_resale" (fan) or "3rd_party_resale" (broker)
 * based on listing ID clustering from the ISMDS facets response.
 *
 * How it works:
 * - Offer IDs are base32-encoded strings with structure: type|listing_id|hash
 *   - Primary offers: "2|<price_level>|<seat_id>"  (short IDs, ~10 chars)
 *   - Resale offers:  "3|<listing_id>|<hash>"       (long IDs, ~37 chars)
 * - Brokers upload inventory in bulk, creating clusters of sequential listing IDs
 * - Fans list individually, producing isolated listing IDs
 * - This clustering pattern persists even as tickets sell (IDs never change)
 *
 * Limitations:
 * - This is a heuristic, not a guarantee
 * - A fan who lists tickets for multiple events at once could appear clustered
 * - A broker who lists one pair looks isolated
 * - Ticketmaster does not expose seller type in the facets API
 */

// Base32 alphabet (RFC 4648)
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32 string to a Buffer
 */
function base32Decode(input) {
  // Remove any padding
  input = input.replace(/=+$/, '').toUpperCase();

  let bits = 0;
  let value = 0;
  let index = 0;
  const output = [];

  for (let i = 0; i < input.length; i++) {
    const charIndex = BASE32_CHARS.indexOf(input[i]);
    if (charIndex === -1) continue;

    value = (value << 5) | charIndex;
    bits += 5;

    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 0xFF;
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * Extract listing ID from a resale offer ID
 * Returns null for primary offers or if decoding fails
 */
function extractListingId(offerId) {
  try {
    const decoded = base32Decode(offerId).toString('ascii');
    const parts = decoded.split('|');

    // Primary offers decode to "2|..." , resale to "3|..."
    if (parts[0] !== '3' || parts.length < 2) {
      return null;
    }

    const listingId = parseInt(parts[1], 10);
    return isNaN(listingId) ? null : listingId;
  } catch {
    return null;
  }
}

/**
 * Classify resale listings from facets data.
 *
 * @param {Array} facets - Raw facets array from the ISMDS API response
 * @param {Object} options
 * @param {number} options.clusterGap - Max gap between listing IDs to be considered same cluster (default: 100)
 * @param {number} options.minClusterSize - Min listings in a cluster to flag as broker (default: 3)
 * @returns {Map<string, string>} Map of offerId -> "verified_resale" | "3rd_party_resale"
 */
export function classifyResaleListings(facets, options = {}) {
  const { clusterGap = 100, minClusterSize = 3 } = options;

  // Step 1: Extract listing IDs from all resale facets
  const offerListingMap = new Map(); // offerId -> listingId

  for (const facet of facets) {
    if (!facet.inventoryTypes?.includes('resale')) continue;

    for (const offerId of (facet.offers || [])) {
      if (offerListingMap.has(offerId)) continue;

      const listingId = extractListingId(offerId);
      if (listingId !== null) {
        offerListingMap.set(offerId, listingId);
      }
    }
  }

  if (offerListingMap.size === 0) {
    return new Map();
  }

  // Step 2: Sort all listing IDs and find clusters
  const entries = [...offerListingMap.entries()]
    .map(([offerId, listingId]) => ({ offerId, listingId }))
    .sort((a, b) => a.listingId - b.listingId);

  // Group into clusters based on gap threshold
  const clusters = [];
  let currentCluster = [entries[0]];

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].listingId - entries[i - 1].listingId <= clusterGap) {
      currentCluster.push(entries[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [entries[i]];
    }
  }
  clusters.push(currentCluster);

  // Step 3: Classify — clusters >= minClusterSize are likely broker
  const brokerOfferIds = new Set();

  for (const cluster of clusters) {
    if (cluster.length >= minClusterSize) {
      for (const entry of cluster) {
        brokerOfferIds.add(entry.offerId);
      }
    }
  }

  // Step 4: Build result map
  const result = new Map();
  for (const [offerId] of offerListingMap) {
    result.set(offerId, brokerOfferIds.has(offerId) ? '3rd_party_resale' : 'verified_resale');
  }

  return result;
}

/**
 * Get classification summary for logging
 */
export function getClassificationSummary(classificationMap) {
  let fan = 0;
  let broker = 0;

  for (const type of classificationMap.values()) {
    if (type === 'verified_resale') fan++;
    else broker++;
  }

  return { fan, broker, total: fan + broker };
}

export default { classifyResaleListings, getClassificationSummary };
