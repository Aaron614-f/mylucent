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
//   2. They pay through a Stripe Payment Link (which carries that same
//      reference as client_reference_id).
//   3. Stripe calls POST /api/stripe-webhook the moment payment succeeds.
//      We verify it's really from Stripe, look up the stored order by
//      reference, text the owner, and email the customer.
//
// REQUIRED environment variables (Railway -> your service -> Variables):
//   MOBILEMESSAGE_USERNAME  - your Mobile Message API username
//   MOBILEMESSAGE_PASSWORD  - your Mobile Message API password
//   MOBILEMESSAGE_SENDER    - your approved Sender ID (e.g. 61XXXXXXXXX)
//   OWNER_PHONE_NUMBER      - the owner's mobile to receive order texts
//   STRIPE_WEBHOOK_SECRET   - the signing secret for your Stripe webhook
//                              endpoint (starts with whsec_...). Get this
//                              from Stripe Dashboard -> Developers ->
//                              Webhooks -> your endpoint. Test mode and
//                              live mode each have their OWN secret.
//   GMAIL_USER               - the Gmail address confirmation emails are
//                              sent FROM (e.g. hello@mylucent.co if that's
//                              a Gmail/Google Workspace address, or your
//                              own gmail.com address).
//   GMAIL_APP_PASSWORD       - a 16-character Google "App Password" for
//                              that account (NOT your normal Gmail
//                              password). Generate one at
//                              myaccount.google.com/apppasswords — this
//                              requires 2-Step Verification to be turned
//                              on for the account first.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
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

function buildOrderMessage(order) {
  return [
    order.reference,
    'Size: ' + order.size,
    'Design: ' + order.design,
    'Language: ' + order.language,
    'Font: ' + order.font,
    'Finish: ' + order.finish,
    'Name: ' + order.name,
    'Phone: ' + order.phone
  ].join('\n');
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
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error('Server is missing Gmail configuration.');
  }
  if (!order.email) {
    throw new Error('No customer email on file for this order.');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  const textBody = [
    'Thanks for your order, ' + order.name + '!',
    '',
    'Here\'s what we\'ve got for you:',
    'Order reference: ' + order.reference,
    'Size: ' + order.size,
    'Design: ' + order.design,
    'Language: ' + order.language,
    'Font: ' + order.font,
    'Finish: ' + order.finish,
    'Name / wording: ' + order.name,
    '',
    'This is a pickup-only order — no delivery. We\'ll contact you at ' + order.phone + ' to confirm the pickup address and timing.',
    '',
    '— myLucent.co'
  ].join('\n');

  const htmlBody = `
    <div style="font-family:Arial,sans-serif; color:#1B2733; max-width:480px; margin:0 auto;">
      <h2 style="font-weight:600;">Thanks for your order, ${order.name}!</h2>
      <p>Here's what we've got for you:</p>
      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Order reference</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;"><b>${order.reference}</b></td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Size</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.size}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Design</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.design}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Language</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.language}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Font</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.font}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Finish</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.finish}</td></tr>
        <tr><td style="padding:8px 0; color:#666;">Name / wording</td><td style="padding:8px 0; text-align:right;">${order.name}</td></tr>
      </table>
      <p style="margin-top:20px; padding:14px 16px; background:#fbf3ec; border:1px solid #e6d3c2; border-radius:8px; font-size:13px;">
        <b>No delivery available.</b> This is a pickup-only order. We'll contact you at ${order.phone} to confirm the pickup address and timing.
      </p>
      <p style="margin-top:24px; color:#999; font-size:12px;">— myLucent.co</p>
    </div>
  `;

  await transporter.sendMail({
    from: 'myLucent.co <' + GMAIL_USER + '>',
    to: order.email,
    subject: 'Your myLucent.co order is confirmed (' + order.reference + ')',
    text: textBody,
    html: htmlBody
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
      try {
        await sendOwnerText(buildOrderMessage(stored.order), reference);
        console.log('Order text sent for', reference);
      } catch (err) {
        console.error('Failed to send order text for', reference, err.message);
      }
      try {
        await sendCustomerConfirmationEmail(stored.order);
        console.log('Confirmation email sent for', reference);
      } catch (err) {
        console.error('Failed to send confirmation email for', reference, err.message);
      }
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
app.use(express.static(__dirname));

// Called from the site when a customer reaches checkout, before paying.
app.post('/api/register-order', (req, res) => {
  const order = req.body;
  const required = ['reference', 'size', 'design', 'language', 'font', 'finish', 'name', 'phone', 'email'];
  for (const field of required) {
    if (!order || !order[field]) {
      return res.status(400).json({ success: false, error: 'Missing order field: ' + field });
    }
  }
  pendingOrders.set(order.reference, { order: order, storedAt: Date.now() });
  res.status(200).json({ success: true });
});

// Fallback: serve index.html for the root and any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('myLucent.co server running on port ' + PORT);
});
