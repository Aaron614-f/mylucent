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
//   OWNER_PHONE_NUMBER      - the owner's mobile to receive order texts
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
//   RESEND_API_KEY            - your API key from resend.com (Railway blocks
//                              outbound SMTP on the Hobby plan, so
//                              confirmation emails are sent via Resend's
//                              HTTPS API instead of Gmail/SMTP).
//   RESEND_FROM_EMAIL          - the "from" address for confirmation emails,
//                              e.g. "myLucent.co <orders@mylucent.co>" once
//                              your domain is verified in Resend, or
//                              "myLucent.co <onboarding@resend.dev>" for
//                              testing before you verify a domain.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');
const PRICING = require('./pricing.js');

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
  return [
    order.reference,
    'Size: ' + (order.sizeLabel || order.size),
    'Quantity: ' + (order.quantity || 1),
    'Design: ' + order.design,
    'Language: ' + order.language,
    'Font: ' + order.font,
    'Finish: ' + order.finish,
    'Name: ' + order.name,
    'Phone: ' + order.phone,
    order.totalPaid ? ('Paid: $' + order.totalPaid) : null
  ].filter(Boolean).join('\n');
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
  const { RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;

  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new Error('Server is missing Resend configuration.');
  }
  if (!order.email) {
    throw new Error('No customer email on file for this order.');
  }

  const textBody = [
    'Thanks for your order, ' + order.name + '!',
    '',
    'Here\'s what we\'ve got for you:',
    'Order reference: ' + order.reference,
    'Size: ' + (order.sizeLabel || order.size),
    'Quantity: ' + (order.quantity || 1),
    'Design: ' + order.design,
    'Language: ' + order.language,
    'Font: ' + order.font,
    'Finish: ' + order.finish,
    'Name / wording: ' + order.name,
    order.totalPaid ? ('Total paid: $' + order.totalPaid) : null,
    '',
    'This is a pickup-only order — no delivery. We\'ll contact you at ' + order.phone + ' to confirm the pickup address and timing.',
    '',
    '— myLucent.co'
  ].filter(function(line){ return line !== null; }).join('\n');

  const htmlBody = `
    <div style="font-family:Arial,sans-serif; color:#1B2733; max-width:480px; margin:0 auto;">
      <h2 style="font-weight:600;">Thanks for your order, ${order.name}!</h2>
      <p>Here's what we've got for you:</p>
      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Order reference</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;"><b>${order.reference}</b></td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Size</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.sizeLabel || order.size}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Quantity</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.quantity || 1}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Design</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.design}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Language</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.language}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Font</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.font}</td></tr>
        <tr><td style="padding:8px 0; color:#666; border-bottom:1px solid #eee;">Finish</td><td style="padding:8px 0; text-align:right; border-bottom:1px solid #eee;">${order.finish}</td></tr>
        <tr><td style="padding:8px 0; color:#666;">Name / wording</td><td style="padding:8px 0; text-align:right;">${order.name}</td></tr>
        ${order.totalPaid ? `<tr><td style="padding:8px 0; color:#666;"><b>Total paid</b></td><td style="padding:8px 0; text-align:right;"><b>$${order.totalPaid}</b></td></tr>` : ''}
      </table>
      <p style="margin-top:20px; padding:14px 16px; background:#fbf3ec; border:1px solid #e6d3c2; border-radius:8px; font-size:13px;">
        <b>No delivery available.</b> This is a pickup-only order. We'll contact you at ${order.phone} to confirm the pickup address and timing.
      </p>
      <p style="margin-top:24px; color:#999; font-size:12px;">— myLucent.co</p>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: order.email,
      subject: 'Your myLucent.co order is confirmed (' + order.reference + ')',
      text: textBody,
      html: htmlBody
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || 'Resend rejected the request (status ' + response.status + ')');
  }
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

// Fallback: serve index.html for the root and any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('myLucent.co server running on port ' + PORT);
});
