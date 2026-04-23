const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin SDK
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production: Read from environment variable
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Loading Firebase credentials from environment variable");
  } catch (error) {
    console.error("❌ Error parsing FIREBASE_SERVICE_ACCOUNT:", error.message);
    process.exit(1);
  }
} else if (fs.existsSync("./firebase-service-account.json")) {
  // Development: Read from local file
  serviceAccount = require("./firebase-service-account.json");
  console.log("✅ Loading Firebase credentials from local file");
} else {
  console.error(
    "❌ Firebase credentials not found! Set FIREBASE_SERVICE_ACCOUNT environment variable or create firebase-service-account.json",
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "ambulance-app-572b2",
});

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL || "https://uxsimhenmvyessotnnmx.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4c2ltaGVubXZ5ZXNzb3Rubm14Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTg2MDIxOSwiZXhwIjoyMDkxNDM2MjE5fQ.LMJpJrqxPhOEmLfNPffVtfe8i5G0oSd4USlV7Iz_V4Q",
);

// Deduplication cache: Store recent mission notifications to prevent duplicates
// Key: missionNumber, Value: {timestamp, count}
const notificationCache = new Map();
const DEDUPE_WINDOW_MS = 5000; // 5 second window to catch duplicate requests

// ========== CONFIG ENDPOINT ==========
// Provides notification configuration (sound version, URL, etc.)
// Called by mobile app to check for updated notification sounds
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
        "[CONFIG] ⚠️  Error fetching config from database:",
        error.message,
      );
      // Return hardcoded defaults if database fails
      return res.json({
        version: 1,
        url: "https://aaeglgmzusasbxatjkjl.supabase.co/storage/v1/object/public/notification-sounds/mission_alert.mp3",
      });
    }

    console.log(
      `[CONFIG] ✅ Returning config - Version: ${data.sound_version}`,
    );
    res.json({
      version: data.sound_version || 1,
      url: data.sound_url,
    });
  } catch (error) {
    console.error("[CONFIG] ❌ Unexpected error:", error);
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

// Send to multiple users
app.post("/send-notification-bulk", async (req, res) => {
  try {
    const { userIds, title, body, data } = req.body;

    // Fetch FCM tokens for all users from database
    // Example: const tokens = await db.query('SELECT fcm_token FROM user_fcm_tokens WHERE user_id IN (...)')

    const messages = userIds.map((userId) => ({
      notification: { title, body },
      data: data || {},
      token: userId, // Replace with actual FCM token
    }));

    const response = await admin.messaging().sendAll(messages);

    res.json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send notification to ALL users
app.post("/send-notification-all", async (req, res) => {
  try {
    const { title, body, data, missionNumber, requestId } = req.body;

    console.log("═══════════════════════════════════════════════════");
    console.log("📢 NOTIFICATION REQUEST RECEIVED");
    console.log("Title:", title);
    console.log("Body:", body);
    console.log("Data:", data);
    console.log("Mission Number:", missionNumber);
    console.log("Request ID:", requestId);
    console.log("═══════════════════════════════════════════════════");

    // DEDUPLICATION CHECK: Prevent sending same mission notification twice
    if (missionNumber) {
      const now = Date.now();
      const cached = notificationCache.get(missionNumber);

      if (cached && now - cached.timestamp < DEDUPE_WINDOW_MS) {
        console.log(
          `⚠️  DUPLICATE DETECTED! Mission ${missionNumber} already sent ${cached.count} time(s) in last ${DEDUPE_WINDOW_MS}ms`,
        );
        console.log(
          "🚫 BLOCKING DUPLICATE REQUEST TO PREVENT 2X NOTIFICATIONS",
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
        `✅ Added to dedupe cache: ${missionNumber} (request #${requestId})`,
      );

      // Clean up old entries (older than 30 seconds)
      for (const [key, value] of notificationCache.entries()) {
        if (now - value.timestamp > 30000) {
          notificationCache.delete(key);
          console.log(`🧹 Cleaned cache entry: ${key}`);
        }
      }
    }

    if (!title || !body) {
      console.log("❌ Missing required fields: title or body");
      return res.status(400).json({ error: "Missing title or body" });
    }

    // Fetch all FCM tokens from Supabase
    console.log("🔄 Fetching FCM tokens from Supabase...");
    const { data: tokens, error } = await supabase
      .from("user_fcm_tokens")
      .select("fcm_token");

    if (error) {
      console.error("❌ Supabase error:", error);
      return res.status(500).json({ error: "Failed to fetch FCM tokens" });
    }

    console.log(`✅ Found ${tokens?.length || 0} FCM tokens in database`);

    if (!tokens || tokens.length === 0) {
      console.log("⚠️  No FCM tokens found in database!");
      console.log("This means no users have registered their devices yet.");
      return res.json({
        success: true,
        sentCount: 0,
        message: "No FCM tokens found",
      });
    }

    // Log all tokens (first 50 chars only for privacy)
    console.log("📋 FCM Tokens:");
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
      `\n📤 Sending ${messages.length} notifications via Firebase Cloud Messaging...`,
    );
    console.log("═══════════════════════════════════════════════════");

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
        console.log("📤 Using send() method for each message...");
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
            `\n⚠️  ${failedResults.length} FAILED TOKENS - Error Details:`,
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
            `\n🧹 AUTO-CLEANUP: Removing ${failedResults.length} invalid tokens from database...`,
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
                `   ⚠️  Could not auto-cleanup: ${deleteError.message}`,
              );
            } else {
              console.log(
                `   ✅ Removed ${failedTokens.length} invalid tokens from database`,
              );
            }
          } catch (cleanupError) {
            console.log(`   ⚠️  Cleanup error: ${cleanupError.message}`);
          }
        }
      }
    } catch (methodError) {
      // If all methods fail, return a helpful error
      console.error(
        "❌ All Firebase messaging methods failed:",
        methodError.message,
      );
      throw methodError;
    }

    console.log("═══════════════════════════════════════════════════");
    console.log(`✅ Notification batch sent!`);
    console.log(`   Success: ${response.successCount}`);
    console.log(`   Failed: ${response.failureCount}`);
    console.log(`   Total: ${response.successCount + response.failureCount}`);
    console.log("═══════════════════════════════════════════════════");

    res.json({
      success: true,
      sentCount: response.successCount,
      failedCount: response.failureCount,
      totalUsers: tokens.length,
    });
  } catch (error) {
    console.log("═══════════════════════════════════════════════════");
    console.error("❌ ERROR sending notifications:", error.message);
    console.error(error);
    console.log("═══════════════════════════════════════════════════");
    res.status(500).json({ error: error.message });
  }
});

// Store last processed notification ID to avoid re-processing
let lastProcessedNotificationId = null;

// Watch app_notifications table for new notifications
async function watchNotifications() {
  console.log(
    "\n🔍 Starting notification watcher for app_notifications table...",
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
        `📌 Starting from notification ID: ${lastProcessedNotificationId}`,
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
          console.error("❌ Error polling notifications:", error);
          return;
        }

        if (newNotifications && newNotifications.length > 0) {
          console.log(
            `\n📨 Found ${newNotifications.length} new notification(s) to process`,
          );

          for (const notification of newNotifications) {
            await processNotification(notification);
            lastProcessedNotificationId = notification.id;
          }
        }
      } catch (error) {
        console.error("❌ Error in notification polling loop:", error);
      }
    }, 2000); // Poll every 2 seconds

    console.log("✅ Notification watcher started!");
  } catch (error) {
    console.error("❌ Error starting notification watcher:", error);
  }
}

// Process a single notification and send FCM
async function processNotification(notification) {
  try {
    const { id, title, type, data } = notification;
    let { body } = notification;

    // Extract user_id from the data JSON field
    const userId = data?.user_id;

    console.log(`\n─────────────────────────────────────────`);
    console.log(`📬 Processing notification ID: ${id}`);
    console.log(`Type: ${type}`);
    console.log(`Title: ${title}`);
    console.log(`Body: ${body}`);
    console.log(`User ID: ${userId}`);
    console.log(`─────────────────────────────────────────`);

    if (!userId) {
      console.warn(`⚠️  No user_id found in notification data`);
      return;
    }

    // Get the user's FCM token
    const { data: fcmData, error: fcmError } = await supabase
      .from("user_fcm_tokens")
      .select("fcm_token, id")
      .eq("user_id", userId)
      .limit(1);

    if (fcmError || !fcmData || fcmData.length === 0) {
      console.warn(`⚠️  No FCM token found for user: ${userId}`);
      return;
    }

    const fcmToken = fcmData[0].fcm_token;
    console.log(`✅ Found FCM token: ${fcmToken.substring(0, 50)}...`);

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
    console.log(`✅ FCM notification sent! Message ID: ${response}`);
  } catch (error) {
    console.error(`❌ Error processing notification:`, error.message);
  }
}

// Start the watcher
watchNotifications();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Notification server running on port ${PORT}`);
});
