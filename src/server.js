require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const { z } = require("zod");
const cron = require("node-cron");
const { Resend } = require("resend");
const multer = require("multer");
const { Parser } = require("json2csv");
const admin = require("firebase-admin");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT || 5000);

// Behind a hosting proxy (Vercel/Render/Nginx) so req.protocol reflects https.
app.set("trust proxy", true);

/* ── CORS ── */
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl / server-to-server
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "8mb" }));
app.use(morgan("dev"));

/* ── Supabase (service role — trusted server, bypasses RLS) ── */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
if (!supabase) {
  console.warn("[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — DB routes will return 503.");
}

const BUCKET = process.env.SUPABASE_BUCKET || "uploads";
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady || !supabase) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error && !/exist/i.test(error.message)) {
    console.warn(`[supabase] could not ensure bucket "${BUCKET}": ${error.message}`);
  }
  bucketReady = true;
}

/* ── Uploads: keep file in memory, then push to Supabase Storage (serverless-safe) ── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB per image
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    const err = new Error("Only image files can be uploaded.");
    err.status = 400;
    cb(err);
  },
});

/* ── Firebase Admin (admin login verification) ── */
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const adminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// An email is an admin if it's in ADMIN_EMAILS or has role='admin' in the users table.
const isAdminEmail = async (email) => {
  if (adminEmails.includes(email)) return true;
  if (!supabase) return false;
  const { data } = await supabase.from("users").select("role").eq("email", email).maybeSingle();
  return data?.role === "admin";
};

const authGuard = async (req, res, next) => {
  if (process.env.DISABLE_AUTH === "true") {
    req.user = { email: "dev@local", role: "admin" };
    return next();
  }
  if (!admin.apps.length) return res.status(500).json({ message: "Firebase Admin not configured" });
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ message: "Missing auth token" });
    const decoded = await admin.auth().verifyIdToken(token);
    const email = String(decoded.email || "").toLowerCase();
    if (!(await isAdminEmail(email))) return res.status(403).json({ message: "Admin access denied" });
    req.user = { email, role: "admin" };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid auth token" });
  }
};

/* ── Email (Resend HTTP API — reliable on serverless, unlike raw SMTP) ── */
// From-address must be on a domain verified in Resend. EMAIL_FROM falls back to
// the legacy SMTP_FROM so existing config keeps working.
const senderEmail = process.env.EMAIL_FROM || process.env.SMTP_FROM || "onboarding@resend.dev";
const senderName = process.env.EMAIL_FROM_NAME || process.env.SMTP_FROM_NAME || "Wormy (Wormy's Cantina)";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const emailReady = Boolean(resend);
if (!emailReady) {
  console.warn("[email] RESEND_API_KEY not set — emails will be skipped until it is configured.");
}

const sendEmail = async ({ to, subject, html, replyTo }) => {
  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set — skipping: ${subject} → ${to}`);
    return { skipped: true };
  }
  const { data, error } = await resend.emails.send({
    from: `${senderName} <${senderEmail}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
  // The Resend SDK returns errors in the response rather than throwing.
  if (error) throw new Error(error.message || "Resend send failed");
  return { id: data?.id };
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const detailRow = (label, value) =>
  value
    ? `<tr><td style="padding:4px 16px 4px 0;font-weight:bold;white-space:nowrap;">${label}:</td><td>${escapeHtml(
        value
      )}</td></tr>`
    : "";

/* Shared email templates (one source of truth for live + test sends). */
const buildConfirmationHtml = (event, rsvp) => `
  <p>Hi ${escapeHtml(rsvp.firstName)},</p>
  <p>You&apos;re registered for <strong>${escapeHtml(event.title)}</strong> at Wormy&apos;s Cantina! Here are your event details:</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:15px;">
    ${detailRow("Event", event.title)}
    ${detailRow("Date", event.date)}
    ${detailRow("Time", event.time)}
    ${detailRow("Location", event.address)}
    ${detailRow("Guests", rsvp.guests)}
    ${detailRow("Notes", event.notes)}
  </table>
  <p>We look forward to seeing you!</p>
  <p>Cheers,<br/>Wormy</p>
`;

const buildManagerNotificationHtml = (event, rsvp) => `
  <p>New RSVP received for <strong>${escapeHtml(event.title)}</strong>.</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:15px;">
    ${detailRow("Name", `${rsvp.firstName} ${rsvp.lastName}`)}
    ${detailRow("Email", rsvp.email)}
    ${detailRow("Phone", rsvp.phone)}
    ${detailRow("Guests", rsvp.guests)}
    ${detailRow("Message", rsvp.message)}
    ${detailRow("Event date/time", `${event.date} at ${event.time}`)}
    ${detailRow("Location", event.address)}
  </table>
`;

const buildReminderHtml = (r) => `
  <p>Hey ${escapeHtml((r.name || "Friend").split(" ")[0])},</p>
  <p>Just a reminder that you&apos;re registered for:</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:15px;">
    ${detailRow("Event", r.eventName)}
    ${detailRow("Date", r.eventDate)}
    ${detailRow("Time", r.eventTime)}
    ${detailRow("Location", r.eventAddress)}
  </table>
  <p>We look forward to seeing you!</p>
  <p>Cheers,<br/>Wormy</p>
`;

const buildContactHtml = (msg) => `
  <p>New message from the Wormy&apos;s Cantina contact form.</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:15px;">
    ${detailRow("Name", msg.name)}
    ${detailRow("Email", msg.email)}
    ${detailRow("Subject", msg.subject)}
  </table>
  <p style="white-space:pre-wrap;border-left:3px solid #d2691e;padding-left:12px;color:#333;">${escapeHtml(
    msg.message
  )}</p>
`;

/* ── Zod schemas (API contract) ── */
const eventSchema = z.object({
  title: z.string().min(3),
  slug: z.string().min(3),
  description: z.string().min(10),
  date: z.string(),
  time: z.string(),
  venue: z.string().min(2),
  address: z.string().min(5),
  heroImage: z.string().optional().default(""),
  gallery: z.array(z.string()).optional().default([]),
  status: z.enum(["upcoming", "past"]).default("upcoming"),
  notes: z.string().optional().default(""),
  reminderDaysBefore: z.number().int().min(1).max(14).default(2),
  externalLink: z.string().url().optional().or(z.literal("")),
});

const rsvpSchema = z.object({
  eventId: z.string().min(6),
  firstName: z.string().min(2),
  lastName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  guests: z.number().int().min(1).max(10),
  message: z.string().optional().default(""),
});

const musicianSchema = z.object({
  name: z.string().min(2),
  instrument: z.string().min(2),
  imageUrl: z.string().min(3),
  order: z.number().int().min(0).default(0),
  description: z.string().optional().default(""),
});

const contactSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  subject: z.string().min(2),
  message: z.string().min(5),
});

/* ── Row mappers: Postgres (snake_case) ↔ API (camelCase, _id) ── */
const eventToRow = (d) => ({
  title: d.title,
  slug: d.slug,
  description: d.description,
  date: d.date,
  time: d.time,
  venue: d.venue,
  address: d.address,
  hero_image: d.heroImage || "",
  gallery: d.gallery || [],
  status: d.status,
  notes: d.notes || "",
  reminder_days_before: d.reminderDaysBefore ?? 2,
  external_link: d.externalLink || "",
});
const eventFromRow = (r) =>
  r && {
    _id: r.id,
    title: r.title,
    slug: r.slug,
    description: r.description,
    date: r.date,
    time: r.time,
    venue: r.venue,
    address: r.address,
    heroImage: r.hero_image || "",
    gallery: Array.isArray(r.gallery) ? r.gallery : [],
    status: r.status,
    notes: r.notes || "",
    reminderDaysBefore: r.reminder_days_before ?? 2,
    externalLink: r.external_link || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const musicianToRow = (d) => ({
  name: d.name,
  instrument: d.instrument,
  image_url: d.imageUrl,
  order: d.order ?? 0,
  description: d.description || "",
});
const musicianFromRow = (r) =>
  r && {
    _id: r.id,
    name: r.name,
    instrument: r.instrument,
    imageUrl: r.image_url || "",
    order: r.order ?? 0,
    description: r.description || "",
  };

const rsvpFromRow = (r) => ({
  _id: r.id,
  eventId: r.event_id,
  eventName: r.event_name,
  firstName: r.first_name,
  lastName: r.last_name,
  email: r.email,
  phone: r.phone,
  guests: r.guests,
  message: r.message || "",
  createdAt: r.created_at,
});

/* Throw helper that surfaces Supabase errors through the JSON error handler. */
const orThrow = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

/* ── Reminder processing (shared by cron + admin "run now" + Vercel cron) ── */
async function processReminders() {
  const pending = orThrow(await supabase.from("reminders").select("*").eq("sent", false));
  const now = new Date();
  let sent = 0;
  let failed = 0;
  let lastError = null;
  for (const r of pending) {
    const trigger = new Date(r.event_date);
    trigger.setDate(trigger.getDate() - Number(r.reminder_days_before || 2));
    if (now < trigger) continue; // not due yet
    // Each send is isolated — one failure must not abort the whole run.
    try {
      await sendEmail({
        to: r.email,
        subject: `Reminder: ${r.event_name || "Wormy's Cantina event"} is coming up!`,
        html: buildReminderHtml({
          name: r.name,
          eventName: r.event_name,
          eventDate: r.event_date,
          eventTime: r.event_time,
          eventAddress: r.event_address,
        }),
      });
      orThrow(await supabase.from("reminders").update({ sent: true, sent_at: new Date().toISOString() }).eq("id", r.id));
      sent += 1;
    } catch (err) {
      failed += 1;
      lastError = err.code ? `${err.code}: ${err.message}` : err.message;
      console.error(`[reminders] send failed for ${r.email}: ${lastError}`);
    }
  }
  return { pending: pending.length, sent, failed, lastError };
}

/* ── Health (no DB needed) ── */
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "wormys-cantina-api" }));

/* ── Cron endpoint for Vercel Cron Jobs (hourly) ──
 * Protected by CRON_SECRET when set (Vercel sends "Authorization: Bearer <CRON_SECRET>"). */
app.get("/api/cron/reminders", async (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    return res.json(await processReminders());
  } catch (err) {
    return next(err);
  }
});

/* ── Guard: everything else under /api needs Supabase configured ── */
app.use("/api", (_req, res, next) => {
  if (!supabase) {
    return res.status(503).json({
      message: "Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    });
  }
  next();
});

/* ── Public routes ── */
app.get("/api/events", async (req, res, next) => {
  try {
    let query = supabase.from("events").select("*").order("date", { ascending: true });
    if (req.query.status) query = query.eq("status", req.query.status);
    const rows = orThrow(await query);
    res.json(rows.map(eventFromRow));
  } catch (err) {
    next(err);
  }
});

app.get("/api/events/:slug", async (req, res, next) => {
  try {
    const row = orThrow(await supabase.from("events").select("*").eq("slug", req.params.slug).maybeSingle());
    if (!row) return res.status(404).json({ message: "Event not found" });
    res.json(eventFromRow(row));
  } catch (err) {
    next(err);
  }
});

app.get("/api/musicians", async (_req, res, next) => {
  try {
    // Sort in JS — the column is named "order" (a reserved word), so we avoid
    // ordering on it at the PostgREST layer.
    const rows = orThrow(await supabase.from("musicians").select("*"));
    res.json(rows.map(musicianFromRow).sort((a, b) => a.order - b.order));
  } catch (err) {
    next(err);
  }
});

app.get("/api/settings/public", async (_req, res, next) => {
  try {
    const row = orThrow(await supabase.from("settings").select("value").eq("key", "public").maybeSingle());
    res.json(row?.value || {});
  } catch (err) {
    next(err);
  }
});

/* ── RSVP (public) ── */
app.post("/api/rsvps", async (req, res, next) => {
  try {
    const parsed = rsvpSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });

    const eventRow = orThrow(await supabase.from("events").select("*").eq("id", parsed.data.eventId).maybeSingle());
    if (!eventRow) return res.status(404).json({ message: "Event not found" });
    const event = eventFromRow(eventRow);

    const rsvpRow = orThrow(
      await supabase
        .from("rsvps")
        .insert({
          event_id: event._id,
          event_name: event.title,
          first_name: parsed.data.firstName,
          last_name: parsed.data.lastName,
          email: parsed.data.email,
          phone: parsed.data.phone,
          guests: parsed.data.guests,
          message: parsed.data.message,
        })
        .select("id")
        .single()
    );

    // Queue the reminder.
    orThrow(
      await supabase.from("reminders").insert({
        event_id: event._id,
        rsvp_id: rsvpRow.id,
        email: parsed.data.email,
        name: `${parsed.data.firstName} ${parsed.data.lastName}`,
        event_name: event.title,
        event_date: event.date,
        event_time: event.time,
        event_address: event.address,
        reminder_days_before: event.reminderDaysBefore || 2,
        sent: false,
      })
    );

    // Emails are best-effort — the RSVP is already saved.
    try {
      await sendEmail({
        to: parsed.data.email,
        subject: `You're Registered! ${event.title} at Wormy's Cantina`,
        html: buildConfirmationHtml(event, parsed.data),
      });
      if (process.env.EVENT_MANAGER_EMAIL) {
        await sendEmail({
          to: process.env.EVENT_MANAGER_EMAIL,
          subject: `New RSVP: ${event.title}`,
          html: buildManagerNotificationHtml(event, parsed.data),
          replyTo: parsed.data.email,
        });
      }
    } catch (err) {
      console.error(`[email] RSVP emails failed for ${parsed.data.email}: ${err.message}`);
    }

    return res.status(201).json({
      message: "Thank you for registering. You will be receiving a confirmation email shortly with event details.",
    });
  } catch (err) {
    next(err);
  }
});

/* ── Contact form (public) ── */
app.post("/api/contact", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });

  const recipient = process.env.CONTACT_RECIPIENT || process.env.EVENT_MANAGER_EMAIL || senderEmail;

  if (!resend) {
    console.log(`[contact] Email not configured — message from ${parsed.data.email} not delivered.`);
    return res.json({ message: "Thanks for reaching out — we'll get back to you soon." });
  }
  try {
    await sendEmail({
      to: recipient,
      subject: `Contact form: ${parsed.data.subject}`,
      html: buildContactHtml(parsed.data),
      replyTo: parsed.data.email,
    });
    return res.json({ message: "Thanks for reaching out — we'll get back to you soon." });
  } catch (err) {
    console.error(`[contact] send failed: ${err.message}`);
    return res.status(502).json({ message: "Could not send your message right now. Please try again later." });
  }
});

/* ── Admin: me ── */
app.get("/api/admin/me", authGuard, (req, res) => res.json({ email: req.user.email, role: "admin" }));

/* ── Admin: events ── */
app.post("/api/admin/events", authGuard, async (req, res, next) => {
  try {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
    const existing = orThrow(await supabase.from("events").select("id").eq("slug", parsed.data.slug).maybeSingle());
    if (existing) return res.status(409).json({ message: "Slug already in use — choose a different one." });
    const row = orThrow(await supabase.from("events").insert(eventToRow(parsed.data)).select("id").single());
    return res.status(201).json({ insertedId: row.id });
  } catch (err) {
    next(err);
  }
});

app.put("/api/admin/events/:id", authGuard, async (req, res, next) => {
  try {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
    orThrow(
      await supabase
        .from("events")
        .update({ ...eventToRow(parsed.data), updated_at: new Date().toISOString() })
        .eq("id", req.params.id)
    );
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/admin/events/:id", authGuard, async (req, res, next) => {
  try {
    orThrow(await supabase.from("events").delete().eq("id", req.params.id));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── Admin: file upload → Supabase Storage ── */
app.post("/api/admin/upload", authGuard, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    await ensureBucket();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const objectName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) return res.status(500).json({ message: `Upload failed: ${error.message}` });
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectName);
    return res.status(201).json({ fileUrl: data.publicUrl });
  } catch (err) {
    next(err);
  }
});

/* ── Admin: musicians ── */
app.get("/api/admin/musicians", authGuard, async (_req, res, next) => {
  try {
    const rows = orThrow(await supabase.from("musicians").select("*"));
    res.json(rows.map(musicianFromRow).sort((a, b) => a.order - b.order));
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/musicians", authGuard, async (req, res, next) => {
  try {
    const parsed = musicianSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
    const row = orThrow(await supabase.from("musicians").insert(musicianToRow(parsed.data)).select("id").single());
    res.status(201).json({ insertedId: row.id });
  } catch (err) {
    next(err);
  }
});

app.put("/api/admin/musicians/:id", authGuard, async (req, res, next) => {
  try {
    const parsed = musicianSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0].message });
    orThrow(await supabase.from("musicians").update(musicianToRow(parsed.data)).eq("id", req.params.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/admin/musicians/:id", authGuard, async (req, res, next) => {
  try {
    orThrow(await supabase.from("musicians").delete().eq("id", req.params.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── Admin: settings ── */
app.get("/api/admin/settings", authGuard, async (_req, res, next) => {
  try {
    const row = orThrow(await supabase.from("settings").select("value").eq("key", "public").maybeSingle());
    res.json(row?.value || {});
  } catch (err) {
    next(err);
  }
});

app.put("/api/admin/settings", authGuard, async (req, res, next) => {
  try {
    orThrow(await supabase.from("settings").upsert({ key: "public", value: req.body }, { onConflict: "key" }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── Admin: RSVPs ── */
app.get("/api/admin/rsvps", authGuard, async (req, res, next) => {
  try {
    let query = supabase.from("rsvps").select("*").order("created_at", { ascending: false });
    if (req.query.eventId) query = query.eq("event_id", String(req.query.eventId));
    const rows = orThrow(await query);
    res.json(rows.map(rsvpFromRow));
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/rsvps/export.csv", authGuard, async (_req, res, next) => {
  try {
    const rows = orThrow(await supabase.from("rsvps").select("*").order("created_at", { ascending: false }));
    const parser = new Parser({
      fields: ["eventName", "firstName", "lastName", "email", "phone", "guests", "message", "createdAt"],
    });
    const csv = parser.parse(rows.map(rsvpFromRow));
    res.header("Content-Type", "text/csv");
    res.attachment("rsvps.csv");
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/* ── Admin: email proofing / RSVP testing ── */
app.post("/api/admin/events/:id/test-emails", authGuard, async (req, res, next) => {
  try {
    const eventRow = orThrow(await supabase.from("events").select("*").eq("id", req.params.id).maybeSingle());
    if (!eventRow) return res.status(404).json({ message: "Event not found" });
    const event = eventFromRow(eventRow);

    const to = (req.body?.to || process.env.EVENT_MANAGER_EMAIL || req.user.email || senderEmail).trim();
    if (!resend) {
      return res.status(400).json({ message: "Email is not configured on the server (RESEND_API_KEY missing), so test emails cannot be sent yet." });
    }

    const sampleRsvp = {
      firstName: "Test",
      lastName: "Guest",
      email: to,
      phone: "555-0100",
      guests: 2,
      message: "This is a sample RSVP used to proof the automated emails.",
    };

    await sendEmail({
      to,
      subject: `[TEST] You're Registered! ${event.title} at Wormy's Cantina`,
      html: buildConfirmationHtml(event, sampleRsvp),
    });
    await sendEmail({
      to,
      subject: `[TEST] Reminder: ${event.title} is coming up!`,
      html: buildReminderHtml({
        name: `${sampleRsvp.firstName} ${sampleRsvp.lastName}`,
        eventName: event.title,
        eventDate: event.date,
        eventTime: event.time,
        eventAddress: event.address,
      }),
    });
    return res.json({ message: `Sample confirmation + reminder emails sent to ${to}.` });
  } catch (err) {
    console.error(`[test-emails] failed: ${err.message}`);
    return res.status(502).json({ message: `Could not send test emails: ${err.message}` });
  }
});

app.post("/api/admin/reminders/run", authGuard, async (_req, res, next) => {
  try {
    const result = await processReminders();
    const msg =
      `Reminder run complete — ${result.sent} sent` +
      (result.failed ? `, ${result.failed} failed` : "") +
      `, ${result.pending} in queue.` +
      (result.lastError ? ` Last email error: ${result.lastError}` : "");
    return res.json({ message: msg, ...result });
  } catch (err) {
    next(err);
  }
});

/* ── JSON error handler (no opaque HTML 500s) ── */
app.use((err, _req, res, _next) => {
  console.error(`[error] ${err.message}`);
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "Image is too large (max 8 MB)." : `Upload error: ${err.message}`;
    return res.status(400).json({ message: msg });
  }
  if (/not allowed by CORS/.test(err.message || "")) {
    return res.status(403).json({ message: err.message });
  }
  return res.status(err.status || 500).json({ message: err.message || "Unexpected server error" });
});

/* ── Local reminder cron (serverless platforms use the /api/cron/reminders endpoint instead) ── */
if (!process.env.VERCEL && supabase) {
  cron.schedule("0 * * * *", () => {
    processReminders()
      .then(({ sent }) => sent && console.log(`[cron] Sent ${sent} reminder email(s).`))
      .catch((err) => console.error(`[cron] Reminder run failed: ${err.message}`));
  });
}

/* ── Start (skipped on Vercel, which imports the exported app) ── */
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[server] Listening on http://localhost:${PORT}`));
}

module.exports = app;
