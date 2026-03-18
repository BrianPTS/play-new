import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * StubHub inventory API operations for the scraper.
 * Replaces the old SeatScouts/Automatiq sync API.
 *
 * Uses the StubHub POS API to manage seller listings by external_id
 * (which maps to our internal inventory ID).
 *
 * API Reference: https://developer.stubhub.com/api-reference/inventory/
 */
class InventoryApi {
  constructor() {
    this.baseURL = 'https://api.stubhub.net';
    this.accessToken = process.env.STUBHUB_ACCESS_TOKEN;
    this.requestTimeout = 30000; // 30 seconds
    this.maxRetries = 3;
  }

  /**
   * Make an authenticated request to the StubHub API with retry logic.
   */
  async request(method, path, body = null) {
    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const url = `${this.baseURL}${path}`;
        const options = {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/hal+json',
          },
        };

        if (body) {
          options.body = JSON.stringify(body);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.requestTimeout
        );
        options.signal = controller.signal;

        const response = await fetch(url, options);
        clearTimeout(timeoutId);

        if (response.status === 204) {
          return {};
        }

        const text = await response.text();

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}: ${text || response.statusText}`
          );
        }

        return text ? JSON.parse(text) : {};
      } catch (error) {
        lastError = error;
        console.error(
          `StubHub API ${method} ${path} attempt ${attempt + 1}/${this.maxRetries} failed:`,
          error.message
        );

        if (attempt < this.maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Delete a single listing by its external ID (our inventory ID).
   * @param {string} externalId - The external_id (our inventory_id)
   */
  async deleteByExternalId(externalId) {
    return this.request(
      'DELETE',
      `/inventory/sellerlistings/external/${encodeURIComponent(externalId)}`
    );
  }

  /**
   * Delete multiple inventory items in batch by their external IDs.
   * StubHub doesn't have a bulk delete endpoint, so we delete individually
   * with concurrency control.
   * @param {Array<string>} inventoryIds - Array of inventory IDs to delete
   * @returns {Promise<Object>} Batch deletion results
   */
  async deleteInventoryBatch(inventoryIds) {
    const CONCURRENCY = 5;
    const successful = [];
    const failed = [];

    console.log(
      `[StubHub] Deleting ${inventoryIds.length} listings by external_id...`
    );

    // Process in concurrent batches
    for (let i = 0; i < inventoryIds.length; i += CONCURRENCY) {
      const batch = inventoryIds.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (id) => {
          await this.deleteByExternalId(id);
          return id;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          successful.push(result.value);
        } else {
          const id = batch[results.indexOf(result)];
          failed.push({
            id,
            error: result.reason?.message || 'Unknown error',
            status: 'FAILED',
          });
        }
      }
    }

    console.log(
      `[StubHub] Batch deletion complete: ${successful.length} succeeded, ${failed.length} failed`
    );

    return {
      successful,
      failed,
      total: inventoryIds.length,
    };
  }
}

export default InventoryApi;
