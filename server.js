import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!DISCORD_WEBHOOK_URL) {
  console.warn("Missing DISCORD_WEBHOOK_URL in environment variables.");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cooldowns = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function normalizeIp(ip) {
  if (!ip) return "Unknown";

  let cleanIp = String(ip).trim();

  if (cleanIp.includes(",")) {
    cleanIp = cleanIp.split(",")[0].trim();
  }

  if (cleanIp.startsWith("::ffff:")) {
    cleanIp = cleanIp.replace("::ffff:", "");
  }

  if (cleanIp === "::1") {
    cleanIp = "127.0.0.1";
  }

  return cleanIp || "Unknown";
}

function getClientIp(req) {
  const cfConnectingIp = req.headers["cf-connecting-ip"];
  const xRealIp = req.headers["x-real-ip"];
  const xForwardedFor = req.headers["x-forwarded-for"];

  if (typeof cfConnectingIp === "string" && cfConnectingIp.trim()) {
    return normalizeIp(cfConnectingIp);
  }

  if (typeof xRealIp === "string" && xRealIp.trim()) {
    return normalizeIp(xRealIp);
  }

  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    return normalizeIp(xForwardedFor);
  }

  if (req.ip) {
    return normalizeIp(req.ip);
  }

  if (req.socket?.remoteAddress) {
    return normalizeIp(req.socket.remoteAddress);
  }

  return "Unknown";
}

function isValidEmail(email) {
  const value = String(email || "").trim();
  const emailRegex =
    /^(?!\.)(?!.*\.\.)([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;

  return emailRegex.test(value);
}

function cleanText(value, maxLength = 4000) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function truncate(value, maxLength) {
  const str = String(value || "");
  if (str.length <= maxLength) return str;
  return str.slice(0, Math.max(0, maxLength - 3)) + "...";
}

function cleanupExpiredCooldowns() {
  const now = Date.now();
  for (const [ip, until] of cooldowns.entries()) {
    if (until <= now) {
      cooldowns.delete(ip);
    }
  }
}

setInterval(cleanupExpiredCooldowns, 60 * 1000).unref();

app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    webhookConfigured: Boolean(DISCORD_WEBHOOK_URL)
  });
});

app.post("/api/report", async (req, res) => {
  try {
    if (!DISCORD_WEBHOOK_URL) {
      return res.status(500).json({
        error: "Server is missing the Discord webhook configuration."
      });
    }

    const ip = getClientIp(req);
    const now = Date.now();
    const cooldownUntil = cooldowns.get(ip) || 0;

    if (cooldownUntil > now) {
      const secondsLeft = Math.ceil((cooldownUntil - now) / 1000);
      return res.status(429).json({
        error: `Cooldown active. Please wait ${secondsLeft} seconds before submitting again.`
      });
    }

    const fullName = cleanText(req.body.fullName, 120);
    const email = cleanText(req.body.email, 150);
    const issueType = cleanText(req.body.issueType, 80);
    const summary = String(req.body.summary || "").trim().slice(0, 3500);
    const submittedAt = cleanText(req.body.submittedAt, 80) || new Date().toISOString();
    const userAgent = cleanText(req.body.userAgent, 300);
    const page = cleanText(req.body.page, 300);

    if (fullName.length < 2) {
      return res.status(400).json({ error: "Invalid full name." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (!issueType) {
      return res.status(400).json({ error: "Issue type is required." });
    }

    if (summary.length < 10) {
      return res.status(400).json({ error: "Summary is too short." });
    }

    cooldowns.set(ip, now + COOLDOWN_MS);

    const embed = {
      username: "Digital Rights Commission",
      embeds: [
        {
          title: "New Report Submission",
          color: 15132390,
          fields: [
            {
              name: "Full name",
              value: truncate(fullName || "Not provided", 1024),
              inline: false
            },
            {
              name: "Email",
              value: truncate(email || "Not provided", 1024),
              inline: false
            },
            {
              name: "Issue type",
              value: truncate(issueType || "Not provided", 1024),
              inline: true
            },
            {
              name: "IP address",
              value: truncate(ip || "Unknown", 1024),
              inline: true
            },
            {
              name: "Submitted at",
              value: truncate(submittedAt, 1024),
              inline: false
            },
            {
              name: "Page",
              value: truncate(page || "Unknown", 1024),
              inline: false
            },
            {
              name: "Summary",
              value: truncate(summary || "Not provided", 1024),
              inline: false
            },
            {
              name: "User-Agent",
              value: truncate(userAgent || "User-Agent unavailable", 1024),
              inline: false
            }
          ],
          timestamp: new Date().toISOString()
        }
      ]
    };

    const webhookResponse = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(embed)
    });

    if (!webhookResponse.ok) {
      cooldowns.delete(ip);

      const responseText = await webhookResponse.text().catch(() => "");
      console.error("Webhook failed:", {
        status: webhookResponse.status,
        statusText: webhookResponse.statusText,
        body: responseText
      });

      return res.status(500).json({
        error: `Webhook delivery failed. Status ${webhookResponse.status}.`
      });
    }

    console.log("New report submitted", {
      ip,
      fullName,
      email,
      issueType
    });

    return res.status(200).json({
      success: true,
      message: "Your report was submitted successfully and forwarded for review."
    });
  } catch (error) {
    console.error("Report error:", error);

    return res.status(500).json({
      error: "Internal server error while processing the report."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("Webhook configured:", Boolean(DISCORD_WEBHOOK_URL));
});
