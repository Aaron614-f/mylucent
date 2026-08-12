// Netlify Function: send-order-sms
//
// Sends the finished order details as a text message to the shop owner's
// phone via Mobile Message (mobilemessage.com.au), and reports back whether
// it was actually accepted for sending. The frontend waits for a success
// response from this function before it unlocks the "Pay Online with
// Stripe" button — so no payment can happen until the owner's phone has
// been notified.
//
// REQUIRED environment variables (set these in Netlify, never in the code):
//   MOBILEMESSAGE_USERNAME  - your Mobile Message API username
//   MOBILEMESSAGE_PASSWORD  - your Mobile Message API password
//   MOBILEMESSAGE_SENDER    - your approved Sender ID (e.g. your registered
//                              mobile number, or an approved business name).
//                              See GET /v1/senders in their docs, or register
//                              your own number via Settings > API in the
//                              Mobile Message dashboard.
//   OWNER_PHONE_NUMBER      - the shop owner's mobile number that should
//                              receive the order text, e.g. 04XXXXXXXX
//
// Set these at: Netlify dashboard -> Site configuration -> Environment variables

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  const {
    MOBILEMESSAGE_USERNAME,
    MOBILEMESSAGE_PASSWORD,
    MOBILEMESSAGE_SENDER,
    OWNER_PHONE_NUMBER
  } = process.env;

  if (!MOBILEMESSAGE_USERNAME || !MOBILEMESSAGE_PASSWORD || !MOBILEMESSAGE_SENDER || !OWNER_PHONE_NUMBER) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, error: 'Server is missing Mobile Message configuration. Set MOBILEMESSAGE_USERNAME, MOBILEMESSAGE_PASSWORD, MOBILEMESSAGE_SENDER, and OWNER_PHONE_NUMBER in Netlify environment variables.' })
    };
  }

  let order;
  try {
    order = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Invalid order data' }) };
  }

  const required = ['reference', 'size', 'design', 'language', 'font', 'finish', 'name', 'phone'];
  for (const field of required) {
    if (!order[field]) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ success: false, error: 'Missing order field: ' + field }) };
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
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, error: data.error || data.message || 'Mobile Message rejected the request' })
      };
    }

    const result = data.results && data.results[0];

    if (!result || result.status !== 'success') {
      const reason = (result && (result.error || result.status)) || 'Unknown error';
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, error: 'Message not sent: ' + reason })
      };
    }

    // Mobile Message accepted and queued the message for delivery.
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true, message_id: result.message_id, status: result.status })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, error: 'Could not reach Mobile Message: ' + err.message })
    };
  }
};

