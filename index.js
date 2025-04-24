const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const {
  forward,
  createSession,
  getPaymentMethods,
  intiatePayment,
  submitAdditionalDetails
} = require('./services/AdyenCheckoutServices');
const req = require('express/lib/request');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/', (req, res) => {
  res.send('Adyen Checkout API is running ✅');
});

app.get('/dropin-session', (req, res) => {
  const sdkVersion = req.query.version || '5.44.0'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('dropin-session', { sdkVersion, env, clientKey });
});

app.get('/dropin-advanced', (req, res) => {
  const sdkVersion = req.query.version || '5.44.0'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('dropin-advance', { sdkVersion, env, clientKey });
});

app.get('/dropin-advance-booking',(req,res)=>{
  const sdkVersion = req.query.version || '5.44.0'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('dropin-advance-booking', { sdkVersion, env, clientKey });
})

//Hotels Tokenisation example
app.post('/api/initatePayment', async (req, res) => {
  try {
    const {
      isLive = false,
      merchantPrefix = "",
      version,
      isMember = false,
      shopperInteraction,
      ...rest
    } = req.body;

    const adyenEnv = isLive ? 'live' : 'test';

    // Optional: prepend merchantPrefix to merchantAccount if needed
    const merchantAccount = isLive && merchantPrefix
      ? process.env.ADYEN_LIVE_MERCHANTACCOUNT
      : process.env.ADYEN_TEST_MERCHANTACCOUNT;

    const baseRequest = {
      ...rest,
      shopperInteraction: shopperInteraction || 'Ecommerce',
      channel: 'Web'
    };

    console.log(req.body);
    let result=null;

    if (isMember && rest.paymentMethod.storedPaymentMethodId !== undefined) {
      console.log('Forwarding payment request as ContAuth for member...');
      const forwardBody = {
        merchantAccount,
        shopperReference:rest.shopperReference,
        storedPaymentMethodId: rest.paymentMethod.storedPaymentMethodId,
        baseUrl: isLive ? "https://checkout-live.adyen.com" : "https://checkout-test.adyen.com",
        request: {
          httpMethod: "POST",
          urlSuffix: "checkout/v71/payments",
          credentials: process.env.ADYEN_API_KEY, // or use secure key vault
          headers: {
            "X-Api-Key": process.env.ADYEN_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount:rest.amount,
            paymentMethod:{
              "type": "scheme",
              "number": "{{number}}",
              "expiryMonth": "{{expiryMonth}}",
              "expiryYear": "{{expiryYear}}",
              encryptedSecurityCode: rest.paymentMethod.encryptedSecurityCode,
              "holderName": rest.paymentMethod.holderName
            },
            shopperInteraction: "Ecommerce",
            channel: "web",
            reference:rest.merchantReference,
            merchantAccount,
            returnUrl:rest.returnUrl,
            shopperReference:rest.merchantReference,
            storePaymentMethod: true,
            recurringProcessingModel: "UnscheduledCardOnFile"
          })
         
        }
      }
      result = await forward(forwardBody,false, merchantPrefix,version);
    } else {
      console.log('Executing standard payment request...');
      //result = await AdyenServices.payments(baseRequest, adyenEnv);
    }

    res.json(result);
  } catch (err) {
    console.error("Error in initiatePayment:", err);
    res.status(500).json({ error: 'Something went wrong', details: err.message });
  }
});


//End hotels tokenisation example

//Standard Integration Server Endpoints
// POST /api/sessions
app.post('/api/sessions', async (req, res) => {
  const { isLive = false, merchantPrefix = "", version, isMember, ...rest } = req.body;

  try {
    const result = await createSession(rest, isLive, merchantPrefix, version);
    res.json(result);
  } catch (error) {
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

// POST /api/paymentMethods
app.post('/api/paymentMethods', async (req, res) => {
  const { isLive = false, merchantPrefix = "", version, isMember, ...rest } = req.body;
  console.log("Calling /payment/mtehods");
  rest.merchantAccount=process.env.ADYEN_TEST_MERCHANTACCOUNT;
  try {
    const result = await getPaymentMethods(rest, isLive, merchantPrefix, version);
    res.json(result);
  } catch (error) {
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

// POST /api/payments
app.post('/api/payments', async (req, res) => {
  const { isLive = false, merchantPrefix = "", version, ...rest } = req.body;
  rest.merchantAccount = process.env.ADYEN_TEST_MERCHANTACCOUNT;
  try {
    const result = await intiatePayment(rest, isLive, merchantPrefix, version);
    res.json(result);
  } catch (error) {
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

// POST /api/payments/details
app.post('/api/payments/details', async (req, res) => {
  const { isLive = false, merchantPrefix = "", version, ...rest } = req.body;

  try {
    const result = await submitAdditionalDetails(rest, isLive, merchantPrefix, version);
    res.json(result);
  } catch (error) {
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

//End Standard Integration Server Endpoints

app.listen(PORT, () => {
  console.log(`🚀 Adyen API Demo running at http://localhost:${PORT}`);
});
