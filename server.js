/**
 * MedCare India — Reminder Notification Backend
 * ================================================
 * Sends scheduled Email + SMS reminders for medicine alerts.
 *
 * Stack:
 *   • Express     — HTTP server
 *   • node-cron   — schedule daily recurring reminders
 *   • Nodemailer  — send email via Gmail SMTP
 *   • Twilio      — send SMS
 *   • cors        — allow frontend requests
 *
 * Setup:
 *   1. npm install
 *   2. Copy .env.example ? .env and fill in your credentials
 *   3. node server.js
 *
 * API Endpoints:
 *   POST /api/reminder/schedule   — schedule a new reminder
 *   GET  /api/reminders           — list all active reminders
 *   DELETE /api/reminder/:id      — cancel a reminder
 *   POST /api/test/email          — send a test email immediately
 *   POST /api/test/sms            — send a test SMS immediately
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const twilio     = require('twilio');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- In-memory reminder store ------------------------------------
// In production replace with a database (SQLite / MongoDB / PostgreSQL)
const reminders = new Map(); // id ? { ...data, cronJob }

// --- Email transporter (Gmail) -----------------------------------
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,   // your Gmail address
    pass: process.env.GMAIL_PASS,   // Gmail App Password (not your login password!)
  },
});

// --- Twilio client -----------------------------------------------
const twilioClient = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- Helper: send email ------------------------------------------
async function sendEmail({ to, medicineName, whenToTake, timeStr }) {
  const html = `
    <div style="font-family:'Segoe UI',sans-serif;max-width:480px;margin:0 auto;background:#F0F4F8;padding:24px;border-radius:16px;">
      <div style="background:linear-gradient(135deg,#1565C0,#1976D2);border-radius:12px;padding:24px;text-align:center;color:#fff;margin-bottom:20px;">
        <div style="font-size:40px;margin-bottom:8px;">??</div>
        <h1 style="margin:0;font-size:22px;">MedCare India</h1>
        <p style="margin:6px 0 0;opacity:0.85;font-size:14px;">Medicine Reminder Alert</p>
      </div>
      <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #E0E7EF;">
        <h2 style="color:#1565C0;margin:0 0 12px;font-size:18px;">? Time to take your medicine!</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr style="border-bottom:1px solid #F5F5F5;">
            <td style="padding:9px 0;color:#888;font-weight:600;">Medicine</td>
            <td style="padding:9px 0;font-weight:700;color:#1a1a2e;">${medicineName}</td>
          </tr>
          <tr style="border-bottom:1px solid #F5F5F5;">
            <td style="padding:9px 0;color:#888;font-weight:600;">When</td>
            <td style="padding:9px 0;font-weight:700;color:#1a1a2e;">${whenToTake}</td>
          </tr>
          <tr>
            <td style="padding:9px 0;color:#888;font-weight:600;">Scheduled Time</td>
            <td style="padding:9px 0;font-weight:700;color:#1565C0;">${timeStr}</td>
          </tr>
        </table>
      </div>
      <p style="text-align:center;font-size:11px;color:#888;margin-top:16px;">
        ?? This is a reminder from MedCare India. Always follow your doctor's prescription.<br>
        Tamil Nadu Health Emergency: <b>108</b>
      </p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"MedCare India ??" <${process.env.GMAIL_USER}>`,
    to,
    subject: `?? Reminder: Take ${medicineName} — ${timeStr}`,
    html,
  });
}

// --- Helper: send SMS --------------------------------------------
async function sendSMS({ to, medicineName, whenToTake, timeStr }) {
  // Ensure Indian number has +91 prefix
  let phone = to.replace(/\s+/g, '');
  if (phone.startsWith('0')) phone = '+91' + phone.slice(1);
  if (!phone.startsWith('+')) phone = '+91' + phone;

  await twilioClient.messages.create({
    body: `?? MedCare Reminder\nTime to take: ${medicineName}\nWhen: ${whenToTake}\nTime: ${timeStr}\n\nStay healthy! - MedCare India\nEmergency: 108`,
    from: process.env.TWILIO_PHONE,  // your Twilio number e.g. +1XXXXXXXXXX
    to: phone,
  });
}

// --- Build cron expression from HH:MM ---------------------------
function buildCron(hour, minute) {
  // Runs every day at HH:MM
  return `${minute} ${hour} * * *`;
}

// ----------------------------------------------------------------
// ROUTES
// ----------------------------------------------------------------

/**
 * POST /api/reminder/schedule
 * Body: {
 *   medicineName: "Metformin 500mg",
 *   whenToTake:   "After breakfast",
 *   time:         "08:00",           // 24-hour HH:MM
 *   email:        "user@gmail.com",  // optional
 *   phone:        "9876543210",      // optional (Indian mobile)
 *   notify:       ["email","sms"]    // which channels to use
 * }
 */
app.post('/api/reminder/schedule', async (req, res) => {
  const { medicineName, whenToTake, time, email, phone, notify = ['email'] } = req.body;

  // Validate
  if (!medicineName || !time) {
    return res.status(400).json({ error: 'medicineName and time are required.' });
  }
  if (notify.includes('email') && !email) {
    return res.status(400).json({ error: 'Email address is required for email notifications.' });
  }
  if (notify.includes('sms') && !phone) {
    return res.status(400).json({ error: 'Phone number is required for SMS notifications.' });
  }

  const [hourStr, minuteStr] = time.split(':');
  const hour   = parseInt(hourStr);
  const minute = parseInt(minuteStr);
  const hr12   = hour % 12 || 12;
  const ampm   = hour >= 12 ? 'PM' : 'AM';
  const timeStr = `${hr12}:${minuteStr} ${ampm}`;

  const id = uuidv4();

  // Schedule daily cron
  const cronJob = cron.schedule(buildCron(hour, minute), async () => {
    console.log(`[${new Date().toISOString()}] Firing reminder: ${medicineName}`);
    const payload = { medicineName, whenToTake, timeStr };

    const promises = [];
    if (notify.includes('email') && email) {
      promises.push(
        sendEmail({ to: email, ...payload })
          .then(() => console.log(`  ? Email sent to ${email}`))
          .catch(e  => console.error(`  ? Email error:`, e.message))
      );
    }
    if (notify.includes('sms') && phone) {
      promises.push(
        sendSMS({ to: phone, ...payload })
          .then(() => console.log(`  ? SMS sent to ${phone}`))
          .catch(e  => console.error(`  ? SMS error:`, e.message))
      );
    }
    await Promise.all(promises);
  }, { timezone: 'Asia/Kolkata' }); // IST timezone

  // Store
  reminders.set(id, {
    id,
    medicineName,
    whenToTake,
    time,
    timeStr,
    email: email || null,
    phone: phone || null,
    notify,
    createdAt: new Date().toISOString(),
    cronJob,
  });

  console.log(`[${new Date().toISOString()}] Scheduled: ${medicineName} @ ${timeStr} (id: ${id})`);

  res.json({
    success: true,
    id,
    message: `Reminder scheduled for ${medicineName} daily at ${timeStr} (IST).`,
    channels: notify,
  });
});

/**
 * GET /api/reminders
 * Returns list of all active reminders (without cron internals)
 */
app.get('/api/reminders', (req, res) => {
  const list = [...reminders.values()].map(({ cronJob, ...r }) => r);
  res.json({ count: list.length, reminders: list });
});

/**
 * DELETE /api/reminder/:id
 * Cancels and removes a reminder
 */
app.delete('/api/reminder/:id', (req, res) => {
  const { id } = req.params;
  const reminder = reminders.get(id);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });

  reminder.cronJob.stop();
  reminders.delete(id);

  res.json({ success: true, message: `Reminder for ${reminder.medicineName} cancelled.` });
});

/**
 * POST /api/test/email
 * Immediately sends a test email (useful for credential verification)
 * Body: { email, medicineName? }
 */
app.post('/api/test/email', async (req, res) => {
  const { email, medicineName = 'Metformin 500mg' } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required.' });

  try {
    await sendEmail({ to: email, medicineName, whenToTake: 'After breakfast', timeStr: 'Test - Right Now' });
    res.json({ success: true, message: `Test email sent to ${email}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/test/sms
 * Immediately sends a test SMS
 * Body: { phone, medicineName? }
 */
app.post('/api/test/sms', async (req, res) => {
  const { phone, medicineName = 'Metformin 500mg' } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required.' });

  try {
    await sendSMS({ to: phone, medicineName, whenToTake: 'After breakfast', timeStr: 'Test - Right Now' });
    res.json({ success: true, message: `Test SMS sent to ${phone}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Health check ------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'MedCare India Notification Backend',
    time: new Date().toISOString(),
    activeReminders: reminders.size,
  });
});

// --- Start -------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n?? MedCare Backend running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});
