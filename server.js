import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1488958714336772370/Eveuub8VnfnaYU_f0GwHFehSm_dcCYw0nYRdxcp68kIR5nIZ0R5k21SzfdN0VxU5MnQk";

if (!DISCORD_WEBHOOK_URL) {
  console.warn("Missing DISCORD_WEBHOOK_URL in environment variables.");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cooldowns = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

// important if you are behind a reverse proxy
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function normalizeIp(ip) {
  if (!ip) return "Unknown";

  let cleanIp = String(ip).trim();

  if (cleanIp.startsWith("::ffff:")) {
    cleanIp = cleanIp.replace("::ffff:", "");
  }

  if (cleanIp === "::1") {
    cleanIp = "127.0.0.1";
  }

  return cleanIp;
}

function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  const xRealIp = req.headers["x-real-ip"];
  const cfConnectingIp = req.headers["cf-connecting-ip"];

  if (typeof cfConnectingIp === "string" && cfConnectingIp.trim()) {
    return normalizeIp(cfConnectingIp);
  }

  if (typeof xRealIp === "string" && xRealIp.trim()) {
    return normalizeIp(xRealIp);
  }

  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    const firstIp = xForwardedFor.split(",")[0].trim();
    return normalizeIp(firstIp);
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
  const emailRegex = /^(?!\.)(?!.*\.\.)([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;
  return emailRegex.test(value);
}

function cleanText(value, maxLength = 4000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

app.post("/api/report", async (req, res) => {
  try {
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
    const summary = String(req.body.summary || "").trim().slice(0, 4000);
    const submittedAt = cleanText(req.body.submittedAt, 80);
    const userAgent = cleanText(req.body.userAgent, 500);
    const page = cleanText(req.body.page, 500);

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
            { name: "Full name", value: fullName || "Not provided", inline: false },
            { name: "Email", value: email || "Not provided", inline: false },
            { name: "Issue type", value: issueType || "Not provided", inline: true },
            { name: "IP address", value: ip || "Unknown", inline: true },
            { name: "Submitted at", value: submittedAt || new Date().toISOString(), inline: false },
            { name: "Page", value: page || "Unknown", inline: false },
            {
              name: "Summary",
              value: summary.length > 1024 ? summary.slice(0, 1021) + "..." : summary,
              inline: false
            }
          ],
          footer: {
            text: userAgent ? `User-Agent: ${userAgent.slice(0, 180)}` : "User-Agent unavailable"
          },
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
      return res.status(500).json({
        error: `Webhook delivery failed. ${responseText || "No response body."}`
      });
    }

    console.log("New report from IP:", ip);

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
});
