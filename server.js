// server.js
//
// Serves the myLucent.co website and handles sending an order-confirmation
// text to the shop owner via Mobile Message (mobilemessage.com.au) before
// the "Pay Online with Stripe" button is allowed to appear on the site.
//
// REQUIRED environment variables (set these in Railway -> your service ->
// Variables tab, never in this file):
//   MOBILEMESSAGE_USERNAME  - your Mobile Message API username
//   MOBILEMESSAGE_PASSWORD  - your Mobile Message API password
//   MOBILEMESSAGE_SENDER    - your approved Sender ID (e.g. your registered
//                              mobile number, in the form 61XXXXXXXXX)
//   OWNER_PHONE_NUMBER      - the shop owner's mobile number that should
//                              receive the order text (e.g. 0412345678)

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/send-order-sms', async (req, res) => {
  const {
    MOBILEMESSAGE_USERNAME,
    MOBILEMESSAGE_PASSWORD,
    MOBILEMESSAGE_SENDER,
    OWNER_PHONE_NUMBER
  } = process.env;

  if (!MOBILEMESSAGE_USERNAME || !MOBILEMESSAGE_PASSWORD || !MOBILEMESSAGE_SENDER || !OWNER_PHONE_NUMBER) {
    return res.status(500).json({
      success: false,
      error: 'Server is missing Mobile Message configuration. Set MOBILEMESSAGE_USERNAME, MOBILEMESSAGE_PASSWORD, MOBILEMESSAGE_SENDER, and OWNER_PHONE_NUMBER in Railway environment variables.'
    });
  }

  const order = req.body;
  const required = ['reference', 'size', 'design', 'language', 'font', 'finish', 'name', 'phone'];
  for (const field of required) {
    if (!order || !order[field]) {
      return res.status(400).json({ success: false, error: 'Missing order field: ' + field });
    }
  }

  const messageBody = [
    'New myLucent.co order ' + order.reference,
    'Size: ' + order.size,
    'Design: ' + order.design,
    'Language: ' + order.language,
    'Font: ' + order.font,
    'Finish: ' + order.finish,
    'Name: ' + order.name,
    'Customer phone: ' + order.phone,
    'Pickup only, no delivery.'
  ].join('\n');

  try {
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
            custom_ref: order.reference
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: data.error || data.message || 'Mobile Message rejected the request'
      });
    }

    const result = data.results && data.results[0];

    if (!result || result.status !== 'success') {
      const reason = (result && (result.error || result.status)) || 'Unknown error';
      return res.status(502).json({ success: false, error: 'Message not sent: ' + reason });
    }

    return res.status(200).json({ success: true, message_id: result.message_id, status: result.status });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Could not reach Mobile Message: ' + err.message });
  }
});

// Fallback: serve index.html for the root and any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('myLucent.co server running on port ' + PORT);
});
