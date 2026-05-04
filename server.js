const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cors());

function logStartup(step, details = {}) {
  console.log(`[STARTUP] ${step}`, details);
}

function logStartupError(step, error) {
  console.error(`[STARTUP] ${step} failed`, {
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[PROCESS] Uncaught exception", error);
});

// Initialize Firebase Admin SDK
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production: Read from environment variable
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("âœ… Loading Firebase credentials from environment variable");
  } catch (error) {
    console.error("âŒ Error parsing FIREBASE_SERVICE_ACCOUNT:", error.message);
    process.exit(1);
  }
} else if (fs.existsSync("./firebase-service-account.json")) {
  // Development: Read from local file
  serviceAccount = require("./firebase-service-account.json");
  console.log("âœ… Loading Firebase credentials from local file");
} else {
  console.error(
    "âŒ Firebase credentials not found! Set FIREBASE_SERVICE_ACCOUNT environment variable or create firebase-service-account.json",
  );
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: "ambulance-app-572b2",
  });
  logStartup("firebase-admin-initialized", {
    projectId: serviceAccount?.project_id || "ambulance-app-572b2",
    clientEmail: serviceAccount?.client_email || null,
    source: process.env.FIREBASE_SERVICE_ACCOUNT ? "env" : "file",
  });
} catch (error) {
  logStartupError("firebase-admin-initialize", error);
  process.exit(1);
}

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL || "https://uxsimhenmvyessotnnmx.supabase.co";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4c2ltaGVubXZ5ZXNzb3Rubm14Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTg2MDIxOSwiZXhwIjoyMDkxNDM2MjE5fQ.LMJpJrqxPhOEmLfNPffVtfe8i5G0oSd4USlV7Iz_V4Q";
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

logStartup("supabase-client-created", {
  url: supabaseUrl,
  usingEnvUrl: Boolean(process.env.SUPABASE_URL),
  usingEnvServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  serviceRoleKeyLength: supabaseServiceRoleKey?.length || 0,
});

async function verifySupabaseConnection() {
  logStartup("supabase-connection-check-start");
  const { data, error } = await supabase
    .from("user_fcm_tokens")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw error;
  }

  logStartup("supabase-connection-check-ok", {
    sampleTable: "user_fcm_tokens",
    responseType: typeof data,
  });
}

// Deduplication cache: Store recent mission notifications to prevent duplicates
// Key: missionNumber, Value: {timestamp, count}
const notificationCache = new Map();
const DEDUPE_WINDOW_MS = 5000; // 5 second window to catch duplicate requests

// ========== CONFIG ENDPOINT ==========
// Provides notification configuration (sound version, URL, etc.)
// Called by mobile app to check for updated notification sounds
app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("user_fcm_tokens")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error("[HEALTH] Supabase check failed", error);
      return res.status(500).json({
        ok: false,
        firebaseProjectId: serviceAccount?.project_id || "ambulance-app-572b2",
        supabaseUrl,
        error: error.message,
      });
    }

    return res.json({
      ok: true,
      firebaseProjectId: serviceAccount?.project_id || "ambulance-app-572b2",
      supabaseUrl,
      hasFirebaseEnv: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT),
      hasSupabaseEnvUrl: Boolean(process.env.SUPABASE_URL),
      hasSupabaseEnvServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    });
  } catch (error) {
    console.error("[HEALTH] Unexpected health error", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/notification-config", async (req, res) => {
  try {
    console.log("[CONFIG] Fetching notification configuration...");

    // Fetch config from Supabase
    const { data, error } = await supabase
      .from("config")
      .select("sound_version, sound_url")
      .eq("id", 1)
      .single();

    if (error) {
      console.error(
        "[CONFIG] âš ï¸  Error fetching config from database:",
        error.message,
      );
      // Return hardcoded defaults if database fails
      return res.json({
        version: 1,
        url: "https://aaeglgmzusasbxatjkjl.supabase.co/storage/v1/object/public/notification-sounds/mission_alert.mp3",
      });
    }

    console.log(
      `[CONFIG] âœ… Returning config - Version: ${data.sound_version}`,
    );
    res.json({
      version: data.sound_version || 1,
      url: data.sound_url,
    });
  } catch (error) {
    console.error("[CONFIG] âŒ Unexpected error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Send notification to specific user
app.post("/send-notification", async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get FCM token from Supabase (or your database)
    // For now, you can test with a static token
    const fcmToken = req.body.fcmToken; // Pass token in request or fetch from DB

    if (!fcmToken) {
      return res.status(400).json({ error: "FCM token not found" });
    }

    // Send message
    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: data || {},
      token: fcmToken,
    };

    const response = await admin.messaging().send(message);

    res.json({
      success: true,
      messageId: response,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function buildBatchMessages({ title, body, data, targets }) {
  return targets
    .filter((target) => target && target.fcmToken)
    .map((target) => ({
      notification: { title, body },
      data: Object.entries({
        ...(data || {}),
        user_id: target.userId || "",
        ambulance_id: target.ambulanceId || "",
        tenant_id: target.tenantId || "",
      }).reduce((acc, [key, value]) => {
        acc[key] = value == null ? "" : String(value);
        return acc;
      }, {}),
      android: {
        priority: "high",
        notification: {
          title,
          body,
          color: "#2962FF",
          channelId: "ambulance_channel_all",
          notificationPriority: "PRIORITY_HIGH",
          vibrateTimingsMillis: [500, 300, 500],
          lightSettings: {
            color: "#2962FF",
            lightOnDurationMillis: 500,
            lightOffDurationMillis: 500,
          },
        },
      },
      token: target.fcmToken,
    }));
}

async function sendBatchMessages(messages) {
  if (messages.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      responses: [],
    };
  }

  if (typeof admin.messaging().sendEach === "function") {
    return admin.messaging().sendEach(messages);
  }

  if (typeof admin.messaging().sendAll === "function") {
    return admin.messaging().sendAll(messages);
  }

  const results = await Promise.all(
    messages.map((message) =>
      admin.messaging().send(message)
        .then((messageId) => ({ success: true, messageId }))
        .catch((error) => ({ success: false, error })),
    ),
  );

  return {
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success).length,
    responses: results,
  };
}

// Send to multiple users / targeted devices
app.post("/send-notification-batch", async (req, res) => {
  try {
    const { title, body, data, targets } = req.body || {};

    console.log("[BATCH] Notification batch request received", {
      title,
      body,
      targetCount: Array.isArray(targets) ? targets.length : 0,
      sampleTargets: Array.isArray(targets) ? targets.slice(0, 10) : [],
      data,
    });

    if (!title || !body) {
      return res.status(400).json({ error: "Missing title or body" });
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      return res.json({
        success: true,
        delivered: 0,
        skipped: 0,
        failed: 0,
        reason: "No targets provided",
      });
    }

    const messages = buildBatchMessages({ title, body, data, targets });
    console.log("[BATCH] Prepared Firebase messages", {
      requestedTargetCount: targets.length,
      preparedMessageCount: messages.length,
      preparedTokens: messages.map((message) => `${String(message.token).slice(0, 20)}...`),
    });

    const response = await sendBatchMessages(messages);
    const failedResponses = Array.isArray(response.responses)
      ? response.responses.filter((entry) => entry && entry.error)
      : [];

    if (failedResponses.length > 0) {
      console.warn("[BATCH] Some notification sends failed", {
        failureCount: failedResponses.length,
        failures: failedResponses.map((entry) => ({
          code: entry.error?.code || null,
          message: entry.error?.message || String(entry.error),
        })),
      });
    }

    console.log("[BATCH] Notification batch sent", {
      successCount: response.successCount || 0,
      failureCount: response.failureCount || 0,
      requestedTargetCount: targets.length,
    });

    return res.json({
      success: true,
      delivered: response.successCount || 0,
      skipped: Math.max(0, targets.length - messages.length),
      failed: response.failureCount || 0,
    });
  } catch (error) {
    console.error("[BATCH] Error sending notification batch", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/send-notification-bulk", async (req, res) => {
  try {
    const { userIds, title, body, data } = req.body || {};
    const targets = (Array.isArray(userIds) ? userIds : []).map((fcmToken) => ({
      fcmToken,
    }));

    const messages = buildBatchMessages({ title, body, data, targets });
    const response = await sendBatchMessages(messages);

    return res.json({
      success: true,
      successCount: response.successCount || 0,
      failureCount: response.failureCount || 0,
    });
  } catch (error) {
    console.error("[BULK] Error sending bulk notification", error);
    return res.status(500).json({ error: error.message });
  }
});

async function resolveMissionNotificationTenantIds({ missionNumber, missionId, data }) {
  const directTenantIds = [];
  const broadcastTenantIds = [];
  const nestedData = data && typeof data === "object" ? data : {};

  const pushTenantId = (bucket, value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed && !bucket.includes(trimmed)) {
      bucket.push(trimmed);
    }
  };

  const pushTenantList = (bucket, value) => {
    if (!Array.isArray(value)) {
      return;
    }
    value.forEach((entry) => pushTenantId(bucket, entry));
  };

  pushTenantId(directTenantIds, nestedData.selected_provider_tenant_id);
  pushTenantId(directTenantIds, nestedData.assigned_company_id);
  pushTenantList(broadcastTenantIds, nestedData.broadcast_provider_ids);

  let mission = null;
  let missionError = null;

  if (missionNumber) {
    const result = await supabase
      .from("missions")
      .select("mission_number, tenant_id, assigned_company_id, selected_provider_tenant_id, broadcast_provider_ids, assigned_ambulance_id, ambulance_id")
      .eq("mission_number", missionNumber)
      .maybeSingle();
    mission = result.data;
    missionError = result.error;
  } else if (missionId) {
    const result = await supabase
      .from("missions")
      .select("id, tenant_id, assigned_company_id, selected_provider_tenant_id, broadcast_provider_ids, assigned_ambulance_id, ambulance_id")
      .eq("id", missionId)
      .maybeSingle();
    mission = result.data;
    missionError = result.error;
  }

  if (missionError) {
    console.error("[NOTIFY] Failed to load mission targeting", missionError);
  }

  if (mission) {
    pushTenantId(directTenantIds, mission.selected_provider_tenant_id);
    pushTenantId(directTenantIds, mission.assigned_company_id);
    pushTenantList(broadcastTenantIds, mission.broadcast_provider_ids);

    const ambulanceIds = [mission.assigned_ambulance_id, mission.ambulance_id]
      .filter((value) => typeof value === "string" && value.trim());

    if (ambulanceIds.length > 0) {
      const { data: ambulances, error: ambulanceError } = await supabase
        .from("ambulances")
        .select("id, tenant_id")
        .in("id", ambulanceIds);

      if (ambulanceError) {
        console.error("[NOTIFY] Failed to resolve ambulance tenants", ambulanceError);
      } else {
        (ambulances || []).forEach((ambulance) =>
          pushTenantId(directTenantIds, ambulance.tenant_id),
        );
      }
    }

    if (directTenantIds.length === 0 && broadcastTenantIds.length === 0) {
      pushTenantId(directTenantIds, mission.tenant_id);
    }
  }

  if (directTenantIds.length > 0) {
    return directTenantIds;
  }

  if (broadcastTenantIds.length > 0) {
    return broadcastTenantIds;
  }

  pushTenantId(directTenantIds, nestedData.tenant_id);
  return directTenantIds;
}
// Send notification to ALL users
app.post("/send-notification-all", async (req, res) => {
  try {
    const { title, body, data, missionNumber, missionId, requestId } = req.body;

    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
    console.log("ðŸ“¢ NOTIFICATION REQUEST RECEIVED");
    console.log("Title:", title);
    console.log("Body:", body);
    console.log("Data:", data);
    console.log("Mission Number:", missionNumber);
    console.log("Request ID:", requestId);
    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");

    // DEDUPLICATION CHECK: Prevent sending same mission notification twice
    if (missionNumber) {
      const now = Date.now();
      const cached = notificationCache.get(missionNumber);

      if (cached && now - cached.timestamp < DEDUPE_WINDOW_MS) {
        console.log(
          `âš ï¸  DUPLICATE DETECTED! Mission ${missionNumber} already sent ${cached.count} time(s) in last ${DEDUPE_WINDOW_MS}ms`,
        );
        console.log(
          "ðŸš« BLOCKING DUPLICATE REQUEST TO PREVENT 2X NOTIFICATIONS",
        );
        return res.json({
          success: false,
          blocked: true,
          reason: "Duplicate notification request (deduped)",
          sentCount: 0,
        });
      }

      // Update cache
      notificationCache.set(missionNumber, {
        timestamp: now,
        count: (cached?.count || 0) + 1,
        requestId,
      });
      console.log(
        `âœ… Added to dedupe cache: ${missionNumber} (request #${requestId})`,
      );

      // Clean up old entries (older than 30 seconds)
      for (const [key, value] of notificationCache.entries()) {
        if (now - value.timestamp > 30000) {
          notificationCache.delete(key);
          console.log(`ðŸ§¹ Cleaned cache entry: ${key}`);
        }
      }
    }

    if (!title || !body) {
      console.log("âŒ Missing required fields: title or body");
      return res.status(400).json({ error: "Missing title or body" });
    }

    const targetTenantIds = await resolveMissionNotificationTenantIds({
      missionNumber,
      missionId,
      data,
    });

    console.log("[NOTIFY] Target tenant ids:", targetTenantIds);

    if (!targetTenantIds.length) {
      console.log("[NOTIFY] No target tenant ids resolved. Skipping notification.");
      return res.json({
        success: true,
        sentCount: 0,
        message: "No target tenant ids resolved",
      });
    }

    // Fetch FCM tokens only for the targeted ambulance/provider tenant(s)
    console.log("ðŸ”„ Fetching tenant-scoped FCM tokens from Supabase...");
    const { data: tokens, error } = await supabase
      .from("user_fcm_tokens")
      .select("fcm_token, tenant_id")
      .in("tenant_id", targetTenantIds);

    if (error) {
      console.error("âŒ Supabase error:", error);
      return res.status(500).json({ error: "Failed to fetch FCM tokens" });
    }

    console.log(`âœ… Found ${tokens?.length || 0} FCM tokens in database`);

    if (!tokens || tokens.length === 0) {
      console.log("âš ï¸  No FCM tokens found in database!");
      console.log("This means no users have registered their devices yet.");
      return res.json({
        success: true,
        sentCount: 0,
        message: "No FCM tokens found",
      });
    }

    // Log all tokens (first 50 chars only for privacy)
    console.log("ðŸ“‹ FCM Tokens:");
    tokens.forEach((t, i) => {
      console.log(`  [${i + 1}] ${t.fcm_token.substring(0, 50)}...`);
    });

    // Create messages for all tokens with Android-specific styling
    const messages = tokens
      .filter((t) => t.fcm_token) // Filter out null tokens
      .map((t) => ({
        notification: { title, body },
        data: {
          ...data,
          missionNumber: missionNumber || "",
        },
        android: {
          // Android-specific notification styling
          priority: "high",
          notification: {
            title: title,
            body: body,
            // Ambulance blue color (#2962FF) - applied to the small icon
            color: "#2962FF",
            // NO sound parameter - uses channel default (mission_alert.mp3)
            // Channel ID must match Android settings in Flutter app
            channelId: "ambulance_channel_all",
            // Notification priority
            notificationPriority: "PRIORITY_HIGH",
            // Vibration pattern (ms on, off, on)
            vibrateTimingsMillis: [500, 300, 500],
            // LED pattern (color in #RRGGBB format, on ms, off ms)
            lightSettings: {
              color: "#2962FF", // Ambulance blue
              lightOnDurationMillis: 500,
              lightOffDurationMillis: 500,
            },
          },
        },
        webpush: {
          // Web push styling (if supported)
          notification: {
            title: title,
            body: body,
            badge: "ic_launcher",
          },
        },
        token: t.fcm_token,
      }));

    console.log(
      `\nðŸ“¤ Sending ${messages.length} notifications via Firebase Cloud Messaging...`,
    );
    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");

    // Try different Firebase Admin SDK methods depending on version
    let response;
    try {
      // Try sendMulticast first (newer SDK versions)
      if (typeof admin.messaging().sendMulticast === "function") {
        response = await admin.messaging().sendMulticast(messages);
      }
      // Fall back to sendAll (medium SDK versions)
      else if (typeof admin.messaging().sendAll === "function") {
        response = await admin.messaging().sendAll(messages);
      }
      // Fall back to manual send loop (older SDK versions)
      else {
        console.log("ðŸ“¤ Using send() method for each message...");
        const results = await Promise.all(
          messages.map((msg) =>
            admin
              .messaging()
              .send(msg)
              .catch((err) => ({ error: err, token: msg.token })),
          ),
        );

        // Log detailed error information for failed tokens
        const failedResults = results.filter((r) => r.error);
        if (failedResults.length > 0) {
          console.log(
            `\nâš ï¸  ${failedResults.length} FAILED TOKENS - Error Details:`,
          );
          failedResults.forEach((result, idx) => {
            const errorCode = result.error?.code || "UNKNOWN";
            const errorMsg = result.error?.message || "No message";
            const token = result.token?.substring(0, 30) + "...";
            console.log(
              `   [${idx + 1}] ${token} | Code: ${errorCode} | ${errorMsg}`,
            );
          });
        }

        response = {
          successCount: results.filter((r) => !r.error).length,
          failureCount: results.filter((r) => r.error).length,
          responses: results,
        };

        // AUTO-CLEANUP: Remove invalid tokens from database
        if (failedResults.length > 0) {
          console.log(
            `\nðŸ§¹ AUTO-CLEANUP: Removing ${failedResults.length} invalid tokens from database...`,
          );
          const failedTokens = failedResults.map((r) => r.token);

          try {
            // Remove tokens that failed with "invalid registration token" or "mismatched token"
            const { error: deleteError } = await supabase
              .from("user_fcm_tokens")
              .delete()
              .in("fcm_token", failedTokens);

            if (deleteError) {
              console.log(
                `   âš ï¸  Could not auto-cleanup: ${deleteError.message}`,
              );
            } else {
              console.log(
                `   âœ… Removed ${failedTokens.length} invalid tokens from database`,
              );
            }
          } catch (cleanupError) {
            console.log(`   âš ï¸  Cleanup error: ${cleanupError.message}`);
          }
        }
      }
    } catch (methodError) {
      // If all methods fail, return a helpful error
      console.error(
        "âŒ All Firebase messaging methods failed:",
        methodError.message,
      );
      throw methodError;
    }

    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
    console.log(`âœ… Notification batch sent!`);
    console.log(`   Success: ${response.successCount}`);
    console.log(`   Failed: ${response.failureCount}`);
    console.log(`   Total: ${response.successCount + response.failureCount}`);
    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");

    res.json({
      success: true,
      sentCount: response.successCount,
      failedCount: response.failureCount,
      totalUsers: tokens.length,
    });
  } catch (error) {
    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
    console.error("âŒ ERROR sending notifications:", error.message);
    console.error(error);
    console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
    res.status(500).json({ error: error.message });
  }
});

// Store last processed notification ID to avoid re-processing
let lastProcessedNotificationId = null;

// Watch app_notifications table for new notifications
async function watchNotifications() {
  console.log(
    "\nðŸ” Starting notification watcher for app_notifications table...",
  );

  try {
    // Get initial max ID
    const { data: maxData } = await supabase
      .from("app_notifications")
      .select("id")
      .order("id", { ascending: false })
      .limit(1);

    if (maxData && maxData.length > 0) {
      lastProcessedNotificationId = maxData[0].id;
      console.log(
        `ðŸ“Œ Starting from notification ID: ${lastProcessedNotificationId}`,
      );
    }

    // Poll for new notifications every 2 seconds
    setInterval(async () => {
      try {
        // Query for notifications newer than the last one we processed
        let query = supabase
          .from("app_notifications")
          .select("id, title, body, type, data, created_at")
          .order("id", { ascending: true });

        if (lastProcessedNotificationId) {
          query = query.gt("id", lastProcessedNotificationId);
        }

        const { data: newNotifications, error } = await query.limit(10);

        if (error) {
          console.error("âŒ Error polling notifications:", error);
          return;
        }

        if (newNotifications && newNotifications.length > 0) {
          console.log(
            `\nðŸ“¨ Found ${newNotifications.length} new notification(s) to process`,
          );

          for (const notification of newNotifications) {
            await processNotification(notification);
            lastProcessedNotificationId = notification.id;
          }
        }
      } catch (error) {
        console.error("âŒ Error in notification polling loop:", error);
      }
    }, 2000); // Poll every 2 seconds

    console.log("âœ… Notification watcher started!");
  } catch (error) {
    console.error("âŒ Error starting notification watcher:", error);
  }
}

// Process a single notification and send FCM
async function processNotification(notification) {
  try {
    const { id, title, type, data } = notification;
    let { body } = notification;

    // Extract user_id from the data JSON field
    const userId = data?.user_id;

    console.log(`\nâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
    console.log(`ðŸ“¬ Processing notification ID: ${id}`);
    console.log(`Type: ${type}`);
    console.log(`Title: ${title}`);
    console.log(`Body: ${body}`);
    console.log(`User ID: ${userId}`);
    console.log(`â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);

    if (!userId) {
      console.warn(`âš ï¸  No user_id found in notification data`);
      return;
    }

    // Get the user's FCM token
    const { data: fcmData, error: fcmError } = await supabase
      .from("user_fcm_tokens")
      .select("fcm_token, id")
      .eq("user_id", userId)
      .limit(1);

    if (fcmError || !fcmData || fcmData.length === 0) {
      console.warn(`âš ï¸  No FCM token found for user: ${userId}`);
      return;
    }

    const fcmToken = fcmData[0].fcm_token;
    console.log(`âœ… Found FCM token: ${fcmToken.substring(0, 50)}...`);

    // Build the FCM message
    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: {
        type: type || "",
        ...(data || {}),
      },
      android: {
        priority: "high",
        notification: {
          title: title,
          body: body,
          color: "#2962FF",
          sound: "default",
          channelId: "ambulance_channel",
          notificationPriority: "PRIORITY_HIGH",
          vibrateTimingsMillis: [500, 300, 500],
          lightSettings: {
            color: "#2962FF",
            lightOnDurationMillis: 500,
            lightOffDurationMillis: 500,
          },
        },
      },
      token: fcmToken,
    };

    // Send the notification
    const response = await admin.messaging().send(message);
    console.log(`âœ… FCM notification sent! Message ID: ${response}`);
  } catch (error) {
    console.error(`âŒ Error processing notification:`, error.message);
  }
}

async function bootstrap() {
  try {
    logStartup("bootstrap-begin", {
      nodeVersion: process.version,
      port: process.env.PORT || 3000,
      hasFirebaseEnv: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT),
      hasSupabaseEnvUrl: Boolean(process.env.SUPABASE_URL),
      hasSupabaseEnvServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    });

    await verifySupabaseConnection();
    await watchNotifications();

    const PORT = process.env.PORT || 3000;
    const HOST = process.env.HOST || "0.0.0.0";
    app.listen(PORT, HOST, () => {
      logStartup("http-server-listening", {
        host: HOST,
        port: PORT,
        healthUrl: `http://${HOST}:${PORT}/health`,
      });
      console.log(`Notification server running on http://${HOST}:${PORT}`);
    });
  } catch (error) {
    logStartupError("bootstrap", error);
    process.exit(1);
  }
}

bootstrap();

