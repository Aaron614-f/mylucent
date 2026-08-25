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
