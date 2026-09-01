// server.js
//
// Serves the myLucent.co website. Once a Stripe payment actually completes
// (verified via a Stripe webhook), this:
//   1. Texts the shop owner the order details, via Mobile Message.
//   2. Emails the customer an order confirmation, via the owner's own
//      Gmail account.
//
// Flow:
//   1. When a customer reaches checkout, the page calls POST /api/register-order
//      to store their order details here in memory, keyed by order reference.
//   2. The page then calls POST /api/create-checkout-session, which computes
//      the correct price from pricing.js (server-side, so it can't be
//      tampered with) and creates a Stripe Checkout Session directly via
//      the Stripe API — no more manually-created Payment Links per size.
//   3. Stripe calls POST /api/stripe-webhook the moment payment succeeds.
//      We verify it's really from Stripe, look up the stored order by
//      reference, text the owner, and email the customer.
//
// PRICES live in pricing.js, next to this file — edit that file to change
// what customers are charged. Nothing in this file needs to change.
//
// REQUIRED environment variables (Railway -> your service -> Variables):
//   MOBILEMESSAGE_USERNAME  - your Mobile Message API username
//   MOBILEMESSAGE_PASSWORD  - your Mobile Message API password
//   MOBILEMESSAGE_SENDER    - your approved Sender ID (e.g. 61XXXXXXXXX)
//   OWNER_PHONE_NUMBER      - the owner's mobile to receive order/inquiry
//                              texts, and the ONLY number allowed to
//                              trigger "ready" and reply-to-inquiry texts.
//   OWNER_EMAIL              - (optional) where Contact page inquiry
//                              notifications are emailed. Defaults to
//                              yefaiart@gmail.com if not set.
//   ADMIN_KEY                 - a password you make up yourself, used to
//                              log into the private Inbox page (admin.html).
//                              Pick anything reasonably long/random —
//                              this is the only thing protecting that
//                              page, so don't reuse a real password.
//   STRIPE_SECRET_KEY       - your Stripe SECRET key (starts with sk_test_...
//                              or sk_live_...). Get this from Stripe
//                              Dashboard -> Developers -> API keys. This is
//                              different from the publishable key and must
//                              be kept private — never put it in index.html.
//   STRIPE_WEBHOOK_SECRET   - the signing secret for your Stripe webhook
//                              endpoint (starts with whsec_...). Get this
//                              from Stripe Dashboard -> Developers ->
//                              Webhooks -> your endpoint. Test mode and
//                              live mode each have their OWN secret.
//   MAILGUN_API_KEY            - your Private API key from Mailgun (Control
//                              Panel -> Account Settings -> API Keys).
//                              Railway blocks outbound SMTP on the Hobby
//                              plan, so confirmation emails are sent via
//                              Mailgun's HTTPS API instead of SMTP.
//   MAILGUN_DOMAIN             - your verified sending domain in Mailgun,
//                              e.g. "mg.mylucent.co", or the sandbox
//                              domain Mailgun gives you before you verify
//                              your own (e.g. "sandboxXXXX.mailgun.org" —
//                              sandbox domains can only send to a short
//                              list of authorized recipients you add in
//                              Mailgun's dashboard).
//   MAILGUN_FROM_EMAIL          - the "from" address for confirmation
//                              emails, e.g. "myLucent.co <orders@mg.mylucent.co>"
//                              — must be an address at MAILGUN_DOMAIN.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');
const multer = require('multer');
const PRICING = require('./pricing.js');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB per file

const app = express();
app.set('trust proxy', true); // so req.protocol reflects Railway's HTTPS, not internal HTTP
const PORT = process.env.PORT || 3000;

// In-memory store of orders waiting to be paid. Good enough for a small
// shop's order volume; entries are cleaned up after 24 hours either way.
const pendingOrders = new Map();

function cleanupOldOrders() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [ref, entry] of pendingOrders) {
    if (entry.storedAt < cutoff) pendingOrders.delete(ref);
  }
}
setInterval(cleanupOldOrders, 60 * 60 * 1000);

// In-memory store of PAID orders awaiting the "text ready" trigger, keyed
// by order reference. This lets the owner text something like
// "ML-MSX70 ready" to automatically email the customer their pickup
// notice, without needing to look anything up manually.
//
// NOTE: like pendingOrders above, this lives in server memory only — a
// Railway restart/redeploy will clear it. For a small shop this is a
// reasonable tradeoff, but if you want it to survive restarts, this is
// the place to swap in a real database later.
const completedOrders = new Map();

function cleanupOldCompletedOrders() {
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000; // 45 days
  for (const [ref, entry] of completedOrders) {
    if (entry.completedAt < cutoff) completedOrders.delete(ref);
  }
}
setInterval(cleanupOldCompletedOrders, 60 * 60 * 1000);

// In-memory store of Contact page conversations, keyed by the customer's
// EMAIL (lowercased) — so every message from the same person, whether
// from the Contact form or a direct email, lands in one thread instead
// of creating a separate card each time. Each conversation keeps its own
// short reference (e.g. "INQ-MSX8A2B1"), assigned once and reused for
// every message in that thread — texting "[reference] their reply" from
// your phone always finds the right person's conversation.
const inquiries = new Map();

// Reverse lookup so a bare reference (from a text or the Inbox page) can
// find which conversation it belongs to.
const referenceToEmail = new Map();

function cleanupOldInquiries() {
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000; // 45 days
  for (const [emailKey, convo] of inquiries) {
    if (convo.lastActivityAt < cutoff) {
      referenceToEmail.delete(convo.reference);
      inquiries.delete(emailKey);
    }
  }
}
setInterval(cleanupOldInquiries, 60 * 60 * 1000);

function generateInquiryReference() {
  return 'INQ-' + Date.now().toString(36).toUpperCase();
}

function getConversationByReference(reference) {
  const emailKey = referenceToEmail.get(reference);
  return emailKey ? inquiries.get(emailKey) : null;
}

// Shared by both the Contact page form AND a customer emailing the
// business directly (e.g. orders@mylucent.co). If this email has
// contacted before, the new message is added to their existing
// conversation instead of starting a new one; otherwise a fresh
// conversation (with a new reference) is created.
async function createInquiryAndNotifyOwner(name, email, message, messageId, originalSubject) {
  const emailKey = email.trim().toLowerCase();
  let trimmedMessage = message.trim();
  if (trimmedMessage.length > 500) {
    trimmedMessage = trimmedMessage.slice(0, 500) + '…';
  }

  let convo = inquiries.get(emailKey);
  if (!convo) {
    const reference = generateInquiryReference();
    convo = { reference, name: name.trim(), email: email.trim(), messages: [], replies: [], status: 'unread', receivedAt: Date.now() };
    inquiries.set(emailKey, convo);
    referenceToEmail.set(reference, emailKey);
  } else {
    convo.status = 'unread'; // a new message needs attention again
  }

  // messageId and originalSubject (only present for a direct email, not
  // the Contact form) let a later reply thread properly in their inbox.
  convo.messages.push({ text: trimmedMessage, receivedAt: Date.now(), messageId: messageId || null, subject: originalSubject || null });
  convo.lastActivityAt = Date.now();

  // Short SMS: just enough to recognize what it's about at a glance.
  const words = trimmedMessage.split(/\s+/).filter(Boolean);
  const preview = words.slice(0, 5).join(' ') + (words.length > 5 ? '…' : '');
  const smsBody = 'myLucent message: ' + preview;

  try {
    await sendOwnerText(smsBody, convo.reference);
  } catch (err) {
    console.error('Failed to send inquiry SMS for', convo.reference, err.message);
  }

  // Second text: the reference + a starter greeting, ready to forward
  // back as your reply. Edit or delete any part of it before sending —
  // whatever text follows the reference becomes the email verbatim, so
  // deleting the greeting here means it won't appear in the email either.
  try {
    await sendOwnerText(convo.reference + ' Thanks for reaching out to myLucent.co!', convo.reference + '-inq-ref');
  } catch (err) {
    console.error('Failed to send inquiry reference text for', convo.reference, err.message);
  }

  try {
    await sendOwnerInquiryEmail(convo);
  } catch (err) {
    console.error('Failed to send owner inquiry email for', convo.reference, err.message);
  }

  return convo;
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing Stripe-Signature header');
  const parts = {};
  sigHeader.split(',').forEach(function (part) {
    const idx = part.indexOf('=');
    parts[part.slice(0, idx)] = part.slice(idx + 1);
  });
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('Malformed Stripe-Signature header');

  const signedPayload = timestamp + '.' + rawBody;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Signature does not match');
  }

  const toleranceSeconds = 5 * 60;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > toleranceSeconds) {
    throw new Error('Timestamp outside tolerance — possible replay');
  }
}

// Computes the authoritative price (in cents) for a size + quantity,
// straight from pricing.js. This is the ONLY place price is calculated —
// the browser never gets to tell the server what something costs.
function calculatePriceCents(size, quantity) {
  const sizeConfig = PRICING[size];
  if (!sizeConfig) {
    throw new Error('No pricing configured for size: ' + size);
  }
  const qty = parseInt(quantity, 10);
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error('Invalid quantity: ' + quantity);
  }

  let dollars;
  if (sizeConfig.pricing[qty] !== undefined) {
    dollars = sizeConfig.pricing[qty];
  } else {
    const highestBracket = Math.max.apply(null, Object.keys(sizeConfig.pricing).map(Number));
    const extraUnits = qty - highestBracket;
    dollars = sizeConfig.pricing[highestBracket] + extraUnits * sizeConfig.additionalUnitPrice;
  }

  if (typeof dollars !== 'number' || dollars <= 0) {
    throw new Error('Pricing for ' + size + ' × ' + qty + ' has not been set yet in pricing.js');
  }

  return Math.round(dollars * 100);
}

function buildOrderMessage(order) {
  const designShort = (order.design || '').includes(' — ') ? order.design.split(' — ')[0] : order.design;
  const qtySuffix = order.quantity && order.quantity > 1 ? ' ×' + order.quantity : '';

  const specParts = [order.sizeLabel || order.size, designShort, order.finish];
  if ((order.language || '').toLowerCase() === 'hebrew') {
    specParts.push('Hebrew (' + order.font + ')');
  }
  const specLine = specParts.filter(Boolean).join(', ') + qtySuffix;

  return [
    order.name + ' · ' + order.phone,
    specLine,
    order.totalPaid ? ('$' + order.totalPaid + ' paid') : null
  ].filter(Boolean).join('\n');
}

// The second text sent right after an order confirmation — just the
// reference + "ready", pre-formatted so it can be forwarded/replied back
// as-is once the piece is done, with nothing to type or edit.
function buildReadyTriggerMessage(order) {
  return order.reference + ' ready';
}

async function sendOwnerText(messageBody, reference) {
  const {
    MOBILEMESSAGE_USERNAME,
    MOBILEMESSAGE_PASSWORD,
    MOBILEMESSAGE_SENDER,
    OWNER_PHONE_NUMBER
  } = process.env;

  if (!MOBILEMESSAGE_USERNAME || !MOBILEMESSAGE_PASSWORD || !MOBILEMESSAGE_SENDER || !OWNER_PHONE_NUMBER) {
    throw new Error('Server is missing Mobile Message configuration.');
  }

  const authHeader = 'Basic ' + Buffer.from(MOBILEMESSAGE_USERNAME + ':' + MOBILEMESSAGE_PASSWORD).toString('base64');

  const response = await fetch('https://api.mobilemessage.com.au/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {
          to: OWNER_PHONE_NUMBER,
          message: messageBody,
          sender: MOBILEMESSAGE_SENDER,
          custom_ref: reference
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || 'Mobile Message rejected the request');
  }
  const result = data.results && data.results[0];
  if (!result || result.status !== 'success') {
    throw new Error('Message not sent: ' + ((result && (result.error || result.status)) || 'Unknown error'));
  }
  return result;
}

async function sendCustomerConfirmationEmail(order) {
  const { MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM_EMAIL } = process.env;

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN || !MAILGUN_FROM_EMAIL) {
    throw new Error('Server is missing Mailgun configuration.');
  }
  if (!order.email) {
    throw new Error('No customer email on file for this order.');
  }

  const firstName = (order.name || '').trim().split(/\s+/)[0] || 'there';
  const designName = (order.design || '').includes(' — ') ? order.design.split(' — ')[1] : order.design;
  const itemLine = (order.sizeLabel || order.size) + ' ' + order.finish + ' Nameplate (' + designName + ')' +
    (order.quantity && order.quantity > 1 ? ' × ' + order.quantity : '');
  const placedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const textBody = [
    'Thanks, ' + firstName + ' — your order is confirmed.',
    '',
    'ORDER SUMMARY',
    'Order: ' + order.reference,
    'Item: ' + itemLine,
    'Placed: ' + placedDate,
    order.totalPaid ? ('Total paid: $' + order.totalPaid) : null,
    '',
    'WHAT\'S NEXT',
    'Your piece is now in production. Normal turnaround is 7 business days. This is a pickup-only order — we\'ll contact you at ' + order.phone + ' to confirm the pickup address and timing once it\'s ready.',
    '',
    'Questions about your order? Reply to this email or visit https://mylucent.co/contact.html',
    '',
    '— myLucent.co'
  ].filter(function(line){ return line !== null; }).join('\n');

  const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>myLucent.co — Order Confirmed</title>
<style>
  body, table, td { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
  a { color: #A9784F; }
  @media only screen and (max-width: 600px) {
    .full-width { width: 100% !important; }
    .px-fluid { padding-left: 24px !important; padding-right: 24px !important; }
    .h1-fluid { font-size: 24px !important; line-height: 1.3 !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#EEF2F6;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#EEF2F6;">
  Your order is confirmed — normal turnaround is 7 business days.
</div>
<center style="width:100%; background-color:#EEF2F6;">
<table role="presentation" class="full-width" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; margin:0 auto;">

  <tr>
    <td class="px-fluid" style="padding:32px 40px 20px 40px; text-align:center;">
      <span style="font-family:Georgia, 'Times New Roman', serif; font-size:18px; font-weight:500; letter-spacing:0.5px; color:#1B2733;">myLucent.co</span>
    </td>
  </tr>

  <tr>
    <td class="px-fluid" style="padding:0 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFFFFF; border-radius:14px; overflow:hidden;">
        <tr>
          <td style="padding:44px 36px 32px 36px; text-align:center;">
            <span style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:11px; font-weight:500; letter-spacing:3px; color:#A9784F;">ORDER CONFIRMED</span>
            <div class="h1-fluid" style="font-family:Georgia, 'Times New Roman', serif; font-size:28px; line-height:1.3; font-weight:500; color:#1B2733; padding-top:14px;">
              Thanks, ${firstName} — your order is confirmed.
            </div>
            <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:14.5px; line-height:1.75; color:#4a5763; padding-top:16px; max-width:440px; margin:0 auto;">
              We've received your order and payment. Your piece is now heading into production.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td height="1" style="font-size:0; line-height:0; background-color:rgba(27,39,51,0.10);">&nbsp;</td>
            </tr></table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 36px 8px 36px;">
            <span style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:10px; font-weight:500; letter-spacing:2px; color:#8a94a0;">ORDER SUMMARY</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 36px 8px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#4a5763;">Order</td>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#1B2733; text-align:right;">${order.reference}</td>
              </tr>
              <tr>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#4a5763; border-top:1px solid rgba(27,39,51,0.08);">Item</td>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#1B2733; text-align:right; border-top:1px solid rgba(27,39,51,0.08);">${itemLine}</td>
              </tr>
              <tr>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#4a5763; border-top:1px solid rgba(27,39,51,0.08);">Placed</td>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#1B2733; text-align:right; border-top:1px solid rgba(27,39,51,0.08);">${placedDate}</td>
              </tr>
              ${order.totalPaid ? `<tr>
                <td style="padding:14px 0 4px; font-family:Georgia, 'Times New Roman', serif; font-size:16px; font-weight:500; color:#1B2733; border-top:1px solid rgba(27,39,51,0.08);">Total paid</td>
                <td style="padding:14px 0 4px; font-family:Georgia, 'Times New Roman', serif; font-size:16px; font-weight:500; color:#1B2733; text-align:right; border-top:1px solid rgba(27,39,51,0.08);">$${order.totalPaid}</td>
              </tr>` : ''}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td class="px-fluid" style="padding:44px 40px 4px 40px; text-align:center;">
      <span style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:10px; font-weight:500; letter-spacing:2px; color:#8a94a0;">WHAT'S NEXT</span>
    </td>
  </tr>
  <tr>
    <td class="px-fluid" style="padding:8px 40px 8px 40px; font-family:Georgia, 'Times New Roman', serif; font-size:20px; font-weight:500; color:#1B2733; text-align:center;">
      Normal turnaround is 7 business days
    </td>
  </tr>
  <tr>
    <td class="px-fluid" style="padding:0 40px 24px 40px; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13.5px; line-height:1.7; color:#4a5763; text-align:center;">
      This is a pickup-only order — no delivery. We'll contact you at ${order.phone} to confirm the pickup address and timing once it's ready.
    </td>
  </tr>
  <tr>
    <td class="px-fluid" style="padding:0 40px 8px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:14px 0; text-align:center;">
            <a href="https://mylucent.co/contact.html" style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#A9784F; text-decoration:none;">Questions about your order? Contact us &#8594;</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td class="px-fluid" style="padding:40px 40px 40px 40px; text-align:center; font-family:'Helvetica Neue', Arial, sans-serif; font-size:11px; line-height:1.7; color:#8a94a0;">
      myLucent.co — Custom Acrylic Art
    </td>
  </tr>

</table>
</center>
</body>
</html>
  `;

  const formData = new URLSearchParams();
  formData.append('from', MAILGUN_FROM_EMAIL);
  formData.append('to', order.email);
  formData.append('subject', 'Your myLucent.co order is confirmed (' + order.reference + ')');
  formData.append('text', textBody);
  formData.append('html', htmlBody);

  const mailgunAuth = 'Basic ' + Buffer.from('api:' + MAILGUN_API_KEY).toString('base64');

  const response = await fetch('https://api.mailgun.net/v3/' + MAILGUN_DOMAIN + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': mailgunAuth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || 'Mailgun rejected the request (status ' + response.status + ')');
  }
}

// Sent when the owner texts "[reference] ready" — lets the customer know
// their piece is ready and prompts them to arrange pickup.
async function sendReadyForPickupEmail(order) {
  const { MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM_EMAIL } = process.env;

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN || !MAILGUN_FROM_EMAIL) {
    throw new Error('Server is missing Mailgun configuration.');
  }
  if (!order.email) {
    throw new Error('No customer email on file for this order.');
  }

  const firstName = (order.name || '').trim().split(/\s+/)[0] || 'there';
  const designName = (order.design || '').includes(' — ') ? order.design.split(' — ')[1] : order.design;
  const itemLine = (order.sizeLabel || order.size) + ' ' + order.finish + ' Nameplate (' + designName + ')' +
    (order.quantity && order.quantity > 1 ? ' × ' + order.quantity : '');

  const textBody = [
    'Good news, ' + firstName + ' — your order is ready for pickup!',
    '',
    'ORDER SUMMARY',
    'Order: ' + order.reference,
    'Item: ' + itemLine,
    '',
    'We\'ll be in touch at ' + order.phone + ' to arrange a pickup time and confirm the address.',
    '',
    'Questions? Reply to this email or visit https://mylucent.co/contact.html',
    '',
    '— myLucent.co'
  ].join('\n');

  const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>myLucent.co — Ready for Pickup</title>
<style>
  body, table, td { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
  a { color: #A9784F; }
  @media only screen and (max-width: 600px) {
    .full-width { width: 100% !important; }
    .px-fluid { padding-left: 24px !important; padding-right: 24px !important; }
    .h1-fluid { font-size: 24px !important; line-height: 1.3 !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#EEF2F6;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#EEF2F6;">
  Your order is ready for pickup — we'll be in touch to arrange a time.
</div>
<center style="width:100%; background-color:#EEF2F6;">
<table role="presentation" class="full-width" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; margin:0 auto;">

  <tr>
    <td class="px-fluid" style="padding:32px 40px 20px 40px; text-align:center;">
      <span style="font-family:Georgia, 'Times New Roman', serif; font-size:18px; font-weight:500; letter-spacing:0.5px; color:#1B2733;">myLucent.co</span>
    </td>
  </tr>

  <tr>
    <td class="px-fluid" style="padding:0 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFFFFF; border-radius:14px; overflow:hidden;">
        <tr>
          <td style="padding:44px 36px 32px 36px; text-align:center;">
            <span style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:11px; font-weight:500; letter-spacing:3px; color:#A9784F;">READY FOR PICKUP</span>
            <div class="h1-fluid" style="font-family:Georgia, 'Times New Roman', serif; font-size:28px; line-height:1.3; font-weight:500; color:#1B2733; padding-top:14px;">
              Good news, ${firstName} — it's ready!
            </div>
            <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:14.5px; line-height:1.75; color:#4a5763; padding-top:16px; max-width:440px; margin:0 auto;">
              Your piece has been finished and is ready to pick up.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td height="1" style="font-size:0; line-height:0; background-color:rgba(27,39,51,0.10);">&nbsp;</td>
            </tr></table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 36px 8px 36px;">
            <span style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:10px; font-weight:500; letter-spacing:2px; color:#8a94a0;">ORDER SUMMARY</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 36px 28px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#4a5763;">Order</td>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#1B2733; text-align:right;">${order.reference}</td>
              </tr>
              <tr>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#4a5763; border-top:1px solid rgba(27,39,51,0.08);">Item</td>
                <td style="padding:10px 0; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#1B2733; text-align:right; border-top:1px solid rgba(27,39,51,0.08);">${itemLine}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td class="px-fluid" style="padding:44px 40px 4px 40px; text-align:center;">
      <span style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:10px; font-weight:500; letter-spacing:2px; color:#8a94a0;">NEXT STEP</span>
    </td>
  </tr>
  <tr>
    <td class="px-fluid" style="padding:8px 40px 8px 40px; font-family:Georgia, 'Times New Roman', serif; font-size:20px; font-weight:500; color:#1B2733; text-align:center;">
      We'll be in touch to arrange pickup
    </td>
  </tr>
  <tr>
    <td class="px-fluid" style="padding:0 40px 24px 40px; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13.5px; line-height:1.7; color:#4a5763; text-align:center;">
      We'll contact you at ${order.phone} to confirm the pickup address and a time that works for you.
    </td>
  </tr>
  <tr>
    <td class="px-fluid" style="padding:0 40px 8px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:14px 0; text-align:center;">
            <a href="https://mylucent.co/contact.html" style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; color:#A9784F; text-decoration:none;">Questions about your order? Contact us &#8594;</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td class="px-fluid" style="padding:40px 40px 40px 40px; text-align:center; font-family:'Helvetica Neue', Arial, sans-serif; font-size:11px; line-height:1.7; color:#8a94a0;">
      myLucent.co — Custom Acrylic Art
    </td>
  </tr>

</table>
</center>
</body>
</html>
  `;

  const formData = new URLSearchParams();
  formData.append('from', MAILGUN_FROM_EMAIL);
  formData.append('to', order.email);
  formData.append('subject', 'Your myLucent.co order is ready for pickup (' + order.reference + ')');
  formData.append('text', textBody);
  formData.append('html', htmlBody);

  const mailgunAuth = 'Basic ' + Buffer.from('api:' + MAILGUN_API_KEY).toString('base64');

  const response = await fetch('https://api.mailgun.net/v3/' + MAILGUN_DOMAIN + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': mailgunAuth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || 'Mailgun rejected the request (status ' + response.status + ')');
  }
}

// A simple shared helper for the two "internal" emails below — sends a
// plain, branded notification. Not fancy, just consistent with the rest
// of the site's look.
async function sendSimpleBrandedEmail(to, subject, heading, bodyLines, textBody, attachments, inReplyToMessageId) {
  const { MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM_EMAIL } = process.env;
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN || !MAILGUN_FROM_EMAIL) {
    throw new Error('Server is missing Mailgun configuration.');
  }

  const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${heading}</title>
</head>
<body style="margin:0; padding:0; background-color:#EEF2F6;">
<center style="width:100%; background-color:#EEF2F6;">
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; margin:0 auto;">
  <tr>
    <td style="padding:32px 40px 20px 40px; text-align:center;">
      <span style="font-family:Georgia, 'Times New Roman', serif; font-size:18px; font-weight:500; color:#1B2733;">myLucent.co</span>
    </td>
  </tr>
  <tr>
    <td style="padding:0 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFFFFF; border-radius:14px; overflow:hidden;">
        <tr>
          <td style="padding:36px 36px 8px 36px;">
            <div style="font-family:Georgia, 'Times New Roman', serif; font-size:22px; font-weight:500; color:#1B2733;">${heading}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 36px 36px 36px; font-family:'Helvetica Neue', Arial, sans-serif; font-size:14px; line-height:1.8; color:#1B2733; white-space:pre-line;">${bodyLines}</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:32px 40px 40px 40px; text-align:center; font-family:'Helvetica Neue', Arial, sans-serif; font-size:11px; color:#8a94a0;">
      myLucent.co — Custom Acrylic Art
    </td>
  </tr>
</table>
</center>
</body>
</html>
  `;

  const mailgunAuth = 'Basic ' + Buffer.from('api:' + MAILGUN_API_KEY).toString('base64');
  let response;

  // Setting these two headers is what makes a reply nest into the same
  // thread as the original email in Gmail/Outlook/etc., instead of
  // showing up as a brand new, unrelated message.
  const threadingHeaders = inReplyToMessageId
    ? { 'h:In-Reply-To': inReplyToMessageId, 'h:References': inReplyToMessageId }
    : null;

  if (attachments && attachments.length > 0) {
    // Attachments require multipart/form-data — Node's built-in FormData
    // handles this automatically (don't set Content-Type manually, fetch
    // sets the correct multipart boundary header itself).
    const form = new FormData();
    form.append('from', MAILGUN_FROM_EMAIL);
    form.append('to', to);
    form.append('subject', subject);
    form.append('text', textBody);
    form.append('html', htmlBody);
    if (threadingHeaders) {
      form.append('h:In-Reply-To', threadingHeaders['h:In-Reply-To']);
      form.append('h:References', threadingHeaders['h:References']);
    }
    attachments.forEach((att) => {
      form.append('attachment', new Blob([att.buffer], { type: att.mimetype || 'application/octet-stream' }), att.originalname);
    });

    response = await fetch('https://api.mailgun.net/v3/' + MAILGUN_DOMAIN + '/messages', {
      method: 'POST',
      headers: { 'Authorization': mailgunAuth },
      body: form
    });
  } else {
    const formData = new URLSearchParams();
    formData.append('from', MAILGUN_FROM_EMAIL);
    formData.append('to', to);
    formData.append('subject', subject);
    formData.append('text', textBody);
    formData.append('html', htmlBody);
    if (threadingHeaders) {
      formData.append('h:In-Reply-To', threadingHeaders['h:In-Reply-To']);
      formData.append('h:References', threadingHeaders['h:References']);
    }

    response = await fetch('https://api.mailgun.net/v3/' + MAILGUN_DOMAIN + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': mailgunAuth,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || 'Mailgun rejected the request (status ' + response.status + ')');
  }
}

// Notifies the owner's own inbox about a new Contact page inquiry —
// sent alongside (not instead of) the SMS notification.
async function sendOwnerInquiryEmail(inquiry) {
  const ownerEmail = process.env.OWNER_EMAIL || 'yefaiart@gmail.com';
  const bodyText = [
    'Reference: ' + inquiry.reference,
    'From: ' + inquiry.name + ' <' + inquiry.email + '>',
    '',
    inquiry.messages[inquiry.messages.length - 1].text,
    '',
    'To reply, text "' + inquiry.reference + ' your reply message" to your Mobile Message number — it\'ll email them back automatically.'
  ].join('\n');

  await sendSimpleBrandedEmail(
    ownerEmail,
    'New website inquiry — ' + inquiry.reference,
    'New inquiry: ' + inquiry.reference,
    bodyText.replace(/\n/g, '<br>'),
    bodyText
  );
}

// Sends the owner's reply (from SMS or the Inbox page) to the person who
// submitted the Contact form. attachments is optional — an array of
// { buffer, originalname, mimetype } (what multer gives us).
async function sendReplyToInquirer(inquiry, replyText, attachments) {
  const bodyText = [
    'Hi ' + (inquiry.name.trim().split(/\s+/)[0] || 'there') + ',',
    '',
    replyText,
    '',
    '— myLucent.co'
  ].join('\n');

  // If they ever emailed us directly, find the most recent one that has
  // a real Message-ID — replying with matching threading headers (and,
  // where we have it, a matching subject) makes this nest as a proper
  // reply in their inbox instead of showing up as a new email. Contact
  // form-only conversations have no such message, so this stays null and
  // the reply just sends as a normal new email (nothing to thread under).
  let threadMessageId = null;
  let threadSubject = null;
  for (let i = inquiry.messages.length - 1; i >= 0; i--) {
    if (inquiry.messages[i].messageId) {
      threadMessageId = inquiry.messages[i].messageId;
      threadSubject = inquiry.messages[i].subject;
      break;
    }
  }
  const subject = threadSubject
    ? (/^re:/i.test(threadSubject) ? threadSubject : 'Re: ' + threadSubject)
    : 'Re: your inquiry to myLucent.co';

  await sendSimpleBrandedEmail(
    inquiry.email,
    subject,
    'A reply from myLucent.co',
    bodyText.replace(/\n/g, '<br>'),
    bodyText,
    attachments,
    threadMessageId
  );

  // Record this reply so the full conversation is visible in the Inbox
  // page, regardless of which channel (text, email, or the page itself)
  // was used to send it.
  if (!inquiry.replies) inquiry.replies = [];
  inquiry.replies.push({
    text: replyText,
    sentAt: Date.now(),
    attachmentNames: (attachments || []).map((a) => a.originalname)
  });
}

// --- Stripe webhook: needs the RAW body for signature verification, so
// this route is registered BEFORE the general express.json() parser below. ---
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).send('Webhook not configured');
  }

  const rawBody = req.body.toString('utf8');

  try {
    verifyStripeSignature(rawBody, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send('Signature verification failed');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Invalid JSON');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const reference = session.client_reference_id;
    const stored = reference && pendingOrders.get(reference);

    if (stored) {
      pendingOrders.delete(reference);
      if (typeof session.amount_total === 'number') {
        stored.order.totalPaid = (session.amount_total / 100).toFixed(2);
      }
      try {
        await sendOwnerText(buildOrderMessage(stored.order), reference);
        console.log('Order text sent for', reference);
      } catch (err) {
        console.error('Failed to send order text for', reference, err.message);
      }
      try {
        await sendOwnerText(buildReadyTriggerMessage(stored.order), reference + '-ready-trigger');
        console.log('Ready-trigger text sent for', reference);
      } catch (err) {
        console.error('Failed to send ready-trigger text for', reference, err.message);
      }
      try {
        await sendCustomerConfirmationEmail(stored.order);
        console.log('Confirmation email sent for', reference);
      } catch (err) {
        console.error('Failed to send confirmation email for', reference, err.message);
      }

      // Save this paid order so the "text ready" workflow can find it later.
      completedOrders.set(reference, { order: stored.order, completedAt: Date.now(), readyEmailSent: false });
    } else {
      console.error('Payment completed but no matching order found for reference:', reference);
      try {
        await sendOwnerText('Payment received (ref ' + reference + ') but order details were lost — check Stripe dashboard.', reference);
      } catch (err) {
        console.error('Failed to send fallback text:', err.message);
      }
    }
  }

  res.status(200).send('ok');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Mailgun forwards inbound emails as form-encoded
app.use(express.static(__dirname));

// --- Inbound SMS webhook ---
// Set this URL as your "Inbound Message Webhook" in Mobile Message's
// dashboard (Settings -> API): https://mylucent.co/api/inbound-sms
//
// Two things this responds to, both from the OWNER'S phone only:
//   1. "[order reference] ready" (e.g. "ML-MSX70 ready") — emails that
//      customer their pickup notice.
//   2. "[inquiry reference] your reply text" (e.g. "INQ-MSX8A2B1 Yes we
//      can do that size, how about Tuesday?") — emails that reply
//      straight to the person who submitted the Contact form.
// Any text from a number other than OWNER_PHONE_NUMBER is ignored, so
// neither of these can be triggered by anyone else.
app.post('/api/inbound-sms', async (req, res) => {
  // Always respond 200 quickly so Mobile Message doesn't retry/queue this.
  res.status(200).send('ok');

  try {
    const { OWNER_PHONE_NUMBER } = process.env;
    const body = req.body || {};
    const sender = (body.sender || '').replace(/\s+/g, '');
    const message = (body.message || '').trim();

    if (!OWNER_PHONE_NUMBER) {
      console.error('Inbound SMS ignored: OWNER_PHONE_NUMBER is not configured.');
      return;
    }

    // Normalize both numbers (strip spaces, leading +, leading 0) so
    // "0412345678" and "61412345678" etc. are treated as the same number.
    const normalize = (n) => (n || '').replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '');
    if (normalize(sender) !== normalize(OWNER_PHONE_NUMBER)) {
      console.log('Inbound SMS ignored (not from owner number):', sender);
      return;
    }

    // --- Branch 1: reply to a Contact page inquiry ("INQ-XXXX ...") ---
    const inqMatch = message.match(/INQ-[A-Z0-9]+/i);
    if (inqMatch) {
      const reference = inqMatch[0].toUpperCase();
      const inquiry = getConversationByReference(reference);

      if (!inquiry) {
        await sendOwnerText('No inquiry found for ' + reference + '. Double-check the reference and try again.', 'inbound-sms-inq-notfound');
        return;
      }

      let replyText = message.slice(inqMatch.index + inqMatch[0].length).trim();
      replyText = replyText.replace(/^[:\-–—,]+\s*/, '');

      if (!replyText) {
        await sendOwnerText('Got the reference but no reply text after it. Format: "' + reference + ' your reply message"', 'inbound-sms-inq-noreply');
        return;
      }

      await sendReplyToInquirer(inquiry, replyText);
      inquiry.status = 'replied';
      console.log('Reply email sent for inquiry', reference);
      await sendOwnerText('✅ Reply sent to ' + inquiry.name + ' (' + inquiry.email + ') for ' + reference + '.', 'inbound-sms-inq-confirm');
      return;
    }

    // --- Branch 2: mark an order ready for pickup ("ML-XXXX ready") ---
    if (!/ready/i.test(message)) {
      console.log('Inbound SMS from owner ignored (no reference or "ready" keyword):', message);
      return;
    }

    const refMatch = message.match(/ML-[A-Z0-9]+/i);
    if (!refMatch) {
      await sendOwnerText('Got your text but couldn\'t find an order reference in it. Format: "ML-XXXXXXXX ready"', 'inbound-sms-noref');
      return;
    }

    const reference = refMatch[0].toUpperCase();
    const found = completedOrders.get(reference);

    if (!found) {
      await sendOwnerText('No paid order found for ' + reference + '. Double-check the reference and try again.', 'inbound-sms-notfound');
      return;
    }

    if (found.readyEmailSent) {
      await sendOwnerText('Heads up: a pickup-ready email was already sent for ' + reference + '. Sent again just now.', 'inbound-sms-resend');
    }

    await sendReadyForPickupEmail(found.order);
    found.readyEmailSent = true;
    console.log('Ready-for-pickup email sent for', reference);
    await sendOwnerText('✅ Sent pickup-ready email to ' + found.order.name + ' for ' + reference + '.', 'inbound-sms-confirm');

  } catch (err) {
    console.error('Error handling inbound SMS:', err.message);
    try {
      await sendOwnerText('Something went wrong processing your text — check Railway logs.', 'inbound-sms-error');
    } catch (e) { /* give up quietly */ }
  }
});

// --- Inbound EMAIL webhook (the email equivalent of the SMS one above) ---
// Set this up as a Mailgun "Route" (Receiving -> Routes -> Create Route):
// --- Inbound EMAIL webhook ---
// Set this up as a Mailgun "Route" (Receiving -> Routes -> Create Route):
//   Filter:  match_recipient(".*@YOUR_MAILGUN_DOMAIN")
//   Action:  forward("https://mylucent.co/api/inbound-email")
//
// Every email that lands here (regardless of sender) is captured exactly
// like a Contact form submission — added to that person's conversation
// (grouped by their email address), and you get the same two texts +
// owner email. Replying by email is no longer supported — reply by
// texting the reference back, or from the Inbox page.
app.post('/api/inbound-email', async (req, res) => {
  // Respond fast so Mailgun doesn't retry/queue this.
  res.status(200).send('ok');

  try {
    const body = req.body || {};
    const rawSender = body.sender || body.from || '';
    const senderMatch = rawSender.toLowerCase().match(/<([^>]+)>/);
    const senderEmail = (senderMatch ? senderMatch[1] : rawSender.toLowerCase()).trim();

    // Mailgun's stripped-text is the message content with quoted history
    // and signature blocks already removed — exactly what we want.
    const bodyRaw = (body['stripped-text'] || body['body-plain'] || '').trim();

    if (!senderEmail) {
      console.log('Inbound email ignored (no sender address found).');
      return;
    }
    if (!bodyRaw) {
      console.log('Inbound email ignored (empty body):', senderEmail);
      return;
    }

    // Prefer the display name from "Name <email>" if present, otherwise
    // fall back to the part of the address before the @.
    const nameMatch = rawSender.match(/^"?([^"<]*)"?\s*<[^>]+>/);
    let senderName = nameMatch ? nameMatch[1].trim() : '';
    if (!senderName) senderName = senderEmail.split('@')[0];

    const convo = await createInquiryAndNotifyOwner(senderName, senderEmail, bodyRaw, body['Message-Id'], body.subject);
    console.log('Inbound email added to conversation:', convo.reference, senderEmail);

  } catch (err) {
    console.error('Error handling inbound email:', err.message);
  }
});


// Contact page submissions — sent straight to the owner's phone via SMS
// and email, so there's no dependency on the visitor having an email
// app configured. Also viewable any time in the Inbox page (admin.html),
// even if both notifications below happen to fail.
app.post('/api/contact-form', async (req, res) => {
  const { name, email, message } = req.body || {};

  if (!name || !name.trim() || !email || !email.trim() || !message || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Please fill in your name, email, and message.' });
  }

  await createInquiryAndNotifyOwner(name, email, message);
  res.status(200).json({ success: true });
});

// Called from the site when a customer reaches checkout, before paying.
app.post('/api/register-order', (req, res) => {
  const order = req.body;
  const required = ['reference', 'size', 'design', 'language', 'font', 'finish', 'name', 'phone', 'email'];
  for (const field of required) {
    if (!order || !order[field]) {
      return res.status(400).json({ success: false, error: 'Missing order field: ' + field });
    }
  }
  if (!order.quantity) order.quantity = 1;
  pendingOrders.set(order.reference, { order: order, storedAt: Date.now() });
  res.status(200).json({ success: true });
});

// Public pricing table — lets the front end render "1 = $X, 2 = $Y..."
// without duplicating numbers in two places.
app.get('/api/pricing', (req, res) => {
  res.status(200).json(PRICING);
});

// Creates a Stripe Checkout Session directly via the Stripe API — no more
// hand-made Payment Links per size. The order must already have been
// registered via /api/register-order; the price is calculated here from
// pricing.js, never trusted from the browser.
app.post('/api/create-checkout-session', async (req, res) => {
  const { STRIPE_SECRET_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set');
    return res.status(500).json({ success: false, error: 'Payments are not configured on the server yet.' });
  }

  const reference = req.body && req.body.reference;
  const stored = reference && pendingOrders.get(reference);
  if (!stored) {
    return res.status(404).json({ success: false, error: 'Order not found. Please go back and review your order again.' });
  }

  const order = stored.order;
  if (order.size === 'custom') {
    return res.status(400).json({ success: false, error: 'Online payment is not available for custom sizes yet.' });
  }

  let amountCents;
  try {
    amountCents = calculatePriceCents(order.size, order.quantity || 1);
  } catch (err) {
    console.error('Pricing error for', reference, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }

  const sizeLabel = (PRICING[order.size] && PRICING[order.size].label) || order.size;
  const qty = order.quantity || 1;
  const baseUrl = req.protocol + '://' + req.get('host');

  try {
    const stripe = Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: reference,
      customer_email: order.email,
      line_items: [
        {
          price_data: {
            currency: PRICING.currency || 'aud',
            unit_amount: amountCents,
            product_data: {
              name: 'myLucent.co — ' + sizeLabel + (qty > 1 ? ' × ' + qty : ''),
              description: 'Order ' + reference
            }
          },
          quantity: 1
        }
      ],
      success_url: baseUrl + '/?order=success&ref=' + encodeURIComponent(reference),
      cancel_url: baseUrl + '/?order=cancelled&ref=' + encodeURIComponent(reference)
    });

    res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error('Failed to create Stripe Checkout Session for', reference, err.message);
    res.status(500).json({ success: false, error: 'Could not start checkout. Please try again.' });
  }
});

// --- Private Inbox page API ---
// Powers admin.html, a hidden (not linked in nav) page where the owner
// can view Contact page inquiries and reply to them without needing
// email or SMS. Every route here requires the ADMIN_KEY env var to be
// sent as an "X-Admin-Key" header — set that key in Railway, and use the
// same value when the Inbox page asks you to log in.
function requireAdminKey(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) {
    return res.status(500).json({ success: false, error: 'Server is missing ADMIN_KEY configuration.' });
  }
  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== configured) {
    return res.status(401).json({ success: false, error: 'Incorrect key.' });
  }
  next();
}

// Returns every inquiry, most recent first. Also doubles as the "is my
// key correct?" check the Inbox page's login screen uses.
app.get('/api/inbox/messages', requireAdminKey, (req, res) => {
  const list = Array.from(inquiries.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  res.status(200).json({ success: true, messages: list });
});

// Marks a message as read (only affects it if it was still "unread" —
// won't un-mark a message that's already been replied to).
app.post('/api/inbox/mark-read', requireAdminKey, (req, res) => {
  const { reference } = req.body || {};
  const inquiry = reference && getConversationByReference(reference);
  if (!inquiry) {
    return res.status(404).json({ success: false, error: 'Message not found.' });
  }
  if (inquiry.status === 'unread') inquiry.status = 'read';
  res.status(200).json({ success: true });
});

// Permanently deletes a conversation — for clearing out spam/junk
// messages that come in through the Contact form or a direct email.
app.post('/api/inbox/delete', requireAdminKey, (req, res) => {
  const { reference } = req.body || {};
  const emailKey = reference && referenceToEmail.get(reference);
  if (!emailKey || !inquiries.has(emailKey)) {
    return res.status(404).json({ success: false, error: 'Message not found.' });
  }
  inquiries.delete(emailKey);
  referenceToEmail.delete(reference);
  res.status(200).json({ success: true });
});

// Sends a reply from the Inbox page — same underlying email as the SMS
// reply method, just triggered from the website instead. Accepts
// multipart/form-data so file attachments work.
app.post('/api/inbox/reply', requireAdminKey, upload.array('attachments', 5), async (req, res) => {
  const { reference, replyText } = req.body || {};
  const inquiry = reference && getConversationByReference(reference);

  if (!inquiry) {
    return res.status(404).json({ success: false, error: 'Message not found.' });
  }
  if (!replyText || !replyText.trim()) {
    return res.status(400).json({ success: false, error: 'Reply text is required.' });
  }

  try {
    await sendReplyToInquirer(inquiry, replyText.trim(), req.files);
    inquiry.status = 'replied';
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Failed to send Inbox page reply for', reference, err.message);
    res.status(500).json({ success: false, error: 'Could not send the reply. ' + err.message });
  }
});

// Fallback: serve index.html for the root and any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('myLucent.co server running on port ' + PORT);
});
