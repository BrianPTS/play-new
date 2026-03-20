// app.js
import express from "express";
import mongoose from "mongoose";
import morgan from "morgan";
import cors from "cors";
import dotenv from "dotenv";

// Route imports
import scraperRoutes from "./routes/scraperRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import statsRoutes from "./routes/statsRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";
import cookieRefreshRoutes from "./routes/cookieRefreshRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

// Import global setup
import setupGlobals from "./setup.js";
import scraperManager from "./scraperManager.js"; // Added for command-line start and graceful shutdown
import { cleanup as cleanupBrowsers, cleanupApiBrowser } from "./browser-cookies.js";
import salesPoller from "./utils/salesPoller.js";

dotenv.config();

// Initialize global components (including ProxyManager)
setupGlobals();

const app = express();
const initialPort = parseInt(process.env.PORT, 10) || 3000; // Renamed and parsed
let serverInstance; // To hold the server instance for graceful shutdown
// MongoDB URI now handled in config/db.js

// Middleware
const allowedOrigins = [
  "https://americanwebgeek.com",
  "http://3.81.42.229", // Production", // Production
  "http://localhost:5173", // Local development
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: "GET,POST,PUT,DELETE",
    allowedHeaders: "Content-Type,Authorization",
  })
);

app.use(express.json());
app.use(morgan("dev"));


// Import database configuration
import connectDB, { closeConnections } from "./config/db.js";

// Database connection
connectDB();

// Routes
app.use("/api/health", healthRoutes);
app.use("/api/scraper", scraperRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/cookies", cookieRefreshRoutes);
app.use("/api/admin", adminRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    status: "error",
    message: "Internal server error",
    error: err.message,
  });
});

// Start server
function startServerWithPortFallback(currentPort, attempt = 0, maxAttempts = 20) {
  if (attempt >= maxAttempts) {
    console.error(`Failed to bind to a port after ${maxAttempts} attempts. Exiting.`);
    process.exit(1);
    return;
  }

  const server = app.listen(currentPort, "0.0.0.0");

  server.on('listening', () => {
    serverInstance = server; // Assign to the higher-scoped variable
    global.serverInstance = server; // Make it globally accessible for restart logic
    console.log(`Server running on port ${currentPort}`);

    // Start sales poller (runs regardless of scraper state)
    salesPoller.start();

    // Check for --start-scraper argument
    if (process.argv.includes('--start-scraper')) {
      console.log('Command-line argument --start-scraper detected. Attempting to start scraper...');
      if (scraperManager && scraperManager.isRunning) {
        console.log("Scraper is already running.");
      } else if (scraperManager && typeof scraperManager.startContinuousScraping === 'function') {
        scraperManager.startContinuousScraping().catch((error) => {
          console.error("Error starting scraper from command line:", error);
          if (scraperManager) scraperManager.isRunning = false;
        });
        console.log("Scraper initiated via command line.");
      } else {
        console.error("Scraper manager or startContinuousScraping method is not available.");
      }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${currentPort} is in use. Trying port ${currentPort + 1}...`);
      server.close(); // Close the server that failed to listen
      startServerWithPortFallback(currentPort + 1, attempt + 1, maxAttempts);
    } else {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
  });
}

// Start server
startServerWithPortFallback(initialPort);

// Graceful shutdown handler - shared between SIGTERM and SIGINT
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`${signal}: Shutdown already in progress, skipping...`);
    return;
  }
  isShuttingDown = true;
  console.log(`${signal} received. Starting graceful shutdown...`);

  // 0. Stop sales poller
  salesPoller.stop();

  // 1. Stop the scraper first (prevents new browser launches)
  if (scraperManager && typeof scraperManager.stopContinuousScraping === 'function') {
    try {
      console.log("Stopping scraper...");
      await scraperManager.stopContinuousScraping();
      console.log("Scraper stopped successfully.");
    } catch (error) {
      console.error("Error during scraper stop:", error);
    }
  }

  // 2. Close all open browser instances (main + API browsers)
  try {
    console.log("Closing all browser instances...");
    await Promise.race([
      cleanupBrowsers(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Browser cleanup timeout')), 10000)),
    ]);
    console.log("All browser instances closed successfully.");
  } catch (error) {
    console.error("Error closing browsers (force killing):", error.message);
    // Force kill any remaining chromium processes on Windows
    try {
      const { execSync } = await import('child_process');
      execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' });
      execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
      console.log("Force killed remaining browser processes.");
    } catch {
      // No processes to kill, that's fine
    }
  }

  // 3. Close HTTP server
  const closeDbAndExit = async (serverError) => {
    console.log("Closing database connections...");
    try {
      await closeConnections();
      console.log("Database connections closed successfully.");
      process.exit(serverError ? 1 : 0);
    } catch (dbErr) {
      console.error("Error closing database connections:", dbErr);
      process.exit(1);
    }
  };

  if (serverInstance && serverInstance.listening) {
    console.log("Closing HTTP server...");
    serverInstance.close(async (serverCloseErr) => {
      if (serverCloseErr) {
        console.error("Error closing HTTP server:", serverCloseErr);
      } else {
        console.log("HTTP server closed successfully.");
      }
      await closeDbAndExit(serverCloseErr);
    });
  } else {
    console.log("HTTP server was not started or already closed. Proceeding to close database.");
    await closeDbAndExit(null);
  }

  // Safety: force exit after 15 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error("Graceful shutdown timed out after 15s. Force exiting.");
    process.exit(1);
  }, 15000).unref();
}

// PM2 sends SIGINT on restart, SIGTERM on stop
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Safety net: clean up browsers on uncaught errors before crashing
process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  try {
    await cleanupBrowsers();
  } catch {
    // Best effort
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

export default app;
