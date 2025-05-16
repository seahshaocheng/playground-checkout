const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');

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
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'allow'
}));
// Health check

app.get('/', (req, res) => {
  res.send('Adyen Checkout API is running ✅');
});

app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.sendFile(path.join(__dirname,'.well-known','apple-developer-merchantid-domain-association'));
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

app.get('/custom-card',(req,res)=>{
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('custom-card', { sdkVersion, env, clientKey });
})

//Hotels Tokenisation example
const forwardAPIHandler = async(newShopperReference,originalStoredPaymentMethodId,originalShopperReference) => {
  const randomUuid = uuidv4();
        const forwardBody = {
          merchantAccount,
          shopperReference:originalShopperReference,
          storedPaymentMethodId: originalStoredPaymentMethodId,
          baseUrl: isLive ? "https://pal-test.adyen.com" : "https://pal-test.adyen.com",
          request: {
            httpMethod: "POST",
            urlSuffix: "pal/servlet/Recurring/v30/storeToken",
            credentials: process.env.ADYEN_API_KEY_TEST, // or use secure key vault
            headers: {
              "X-Api-Key": process.env.ADYEN_API_KEY_TEST,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              card:{
                "number": "{{number}}",
                "expiryMonth": "{{expiryMonth}}",
                "expiryYear": "{{expiryYear}}",
                "holderName": "{{holderName}}"
              },
              reference:newShopperReference,
              merchantAccount,
              shopperReference:`${newShopperReference}`,
              recurring: {
                contract:"ONECLICK"
              }
            })
          }}
          
      console.log("Retrieved shopper token for reservation");
      const forwardResult = await forward(forwardBody,false, merchantPrefix,version);
      console.log(rest.merchantReference);
      console.log(forwardResult);
      const convertedForwardResult = JSON.parse(forwardResult.response.body);
      console.log(convertedForwardResult.recurringDetailReference);

      return convertedForwardResult;
}


app.post('/api/hotel/initatePayment', async (req, res) => {
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
  
        const paymentRequest = {
          ...rest,
          merchantAccount,
          recurringProcessingModel:"CardOnFile",
          shopperInteraction:"ContAuth",
          authenticationData:{
            "threeDSRequestData": {
              "nativeThreeDS": "preferred"
            }
          }
        }
        console.log(paymentRequest);
        const paymentResult = await intiatePayment(paymentRequest, isLive, merchantPrefix, version);
        console.log(paymentResult);
       
        //Forwarding payment request to retrieve a token for ORN number
        let originalShopperReference = rest.shopperReference;
        let originalStoredPaymentMethodId= rest.paymentMethod.storedPaymentMethodId;
        let newShopperReference = rest.merchantReference;

        if(paymentResult.action===undefined){

          //if member and using Cardon file, forward to get token for Opera

          // if member and wants to store card, forward to get token for member_id
          forwardAPIHandler(newShopperReference,originalStoredPaymentMethodId,originalShopperReference)
        }

      res.json(paymentResult);
    } else {
      console.log('Executing standard payment request...');
      const paymentRequest = {
        ...rest,
        merchantAccount,
        recurringProcessingModel:"CardOnFile",
        shopperInteraction:"ContAuth"
      }
      const paymentResult = await intiatePayment(paymentRequest, isLive, merchantPrefix, version);
      res.json(paymentResult);
      //result = await AdyenServices.payments(baseRequest, adyenEnv);
    }
   
  } catch (err) {
    console.error("Error in initiatePayment:", err);
    res.status(500).json({ error: 'Something went wrong', details: err.message });
  }
});

// POST /api/payments/details
app.post('/api/hotel/completepayment', async (req, res) => {
  const { isLive = false, merchantPrefix = "", isMember, shopperReference, version, ...rest } = req.body;

  try {
    const result = await submitAdditionalDetails(rest, isLive, merchantPrefix, version);
    console.log(result);
    if(result.resultCode==="Authorised"){
      console.log("result is authorised, forwarding API to get new token")
        //if member and using Cardon file, forward to get token for Opera

          // if member and wants to store card, forward to get token for member_id


    }
    res.json(result);
  } catch (error) {
    res.status(500).json(error.response?.data || { error: error.message });
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
    console.log("THis is the error");
    console.log(error);
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
