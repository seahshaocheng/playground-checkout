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
  submitAdditionalDetails,
  checkSessionOutcome
} = require('./services/AdyenCheckoutServices');
const req = require('express/lib/request');

const app = express();
const PORT = process.env.PORT || 3005;

let hotelOrders = [];

app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'allow'
}));
// Health check

const handleCurrencyToCountryCode = (currency) => {
  //default singapore, switch case, if MYR = MY
  switch (currency) {
    case 'SGD':
      return 'SG';
    case 'MYR':
      return 'MY';
    default:
      return 'SG';
  }
}

const handleAscottMerchantAccountCode = (currency) => {
  //default singapore
  switch (currency) {
    case 'SGD':
      return 'SG_Lyf_Funan';
    case 'MYR':
      return 'MY_Lyf_ChinatownKL';
    default:
      return 'SG_Lyf_Funan';
  }
}

app.get('/', (req, res) => {
  res.send('Adyen Checkout API is running ✅');
});

app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.sendFile(path.join(__dirname,'.well-known','apple-developer-merchantid-domain-association'));
});

app.get('/dropin-session', (req, res) => {
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('dropin-session', { sdkVersion, env, clientKey });
});

app.get('/dropin-advanced', (req, res) => {
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('dropin-advance', { sdkVersion, env, clientKey });
});

app.get('/dropin-advance-booking',(req,res)=>{
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('dropin-advance-booking', { sdkVersion, env, clientKey });
})

app.get('/custom-card',(req,res)=>{
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.ADYEN_ENV || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  res.render('custom-card', { sdkVersion, env, clientKey });
})

//Ascott Customisation
app.get('/ascott/booking',(req,res)=>{
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  const mode = req.query.mode || null;
  const currency = req.query.CURRENCY || 'SGD';
  const country = handleCurrencyToCountryCode(currency);
  const merchantAccount = handleAscottMerchantAccountCode(currency);
  res.render('custom-demos/ascott/ascott-booking', { sdkVersion, env, clientKey,mode,currency,country,merchantAccount });
})

app.get('/ascott/booking-confirmation',(req,res)=>{
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  const mode = req.query.mode || null;
  const currency = req.query.CURRENCY || 'SGD';
  const country = handleCurrencyToCountryCode(currency);
  const merchantAccount = handleAscottMerchantAccountCode(currency);
  res.render('custom-demos/ascott/ascott-booking-confirmation', { sdkVersion, env, clientKey,mode,currency,country,merchantAccount });
})

app.get('/ascott/booking-payment',(req,res)=>{
  const sdkVersion = req.query.version || '6.13.1'; // default fallback
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;
  const mode = req.query.mode || null;
  const currency = req.query.CURRENCY || 'SGD';
  const country = handleCurrencyToCountryCode(currency);
  const merchantAccount = handleAscottMerchantAccountCode(currency);
  res.render('custom-demos/ascott/ascott-booking-payment', { sdkVersion, env, clientKey,mode,currency,country,merchantAccount });
})
//end ascott customisation

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
          // if member and wants to store card, forward to get token for member_id
          forwardAPIHandler(newShopperReference,originalStoredPaymentMethodId,originalShopperReference)
        }
        else{
          hotelOrders.push({
            reservation:rest.merchantReference,
            memberTokenUsed:originalStoredPaymentMethodId,
            member_id:originalShopperReference
          })
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
  console.log("completeing payment after action");
  const { isLive = false, merchantPrefix = "", isMember, shopperReference, version, ...rest } = req.body;
  try {
    const result = await submitAdditionalDetails(rest, isLive, merchantPrefix, version);
    console.log(result);

    if (result.resultCode === "Authorised") {
      console.log("Result is authorised, checking forwarding conditions...");

      const storedPaymentMethodId = rest?.paymentMethod?.storedPaymentMethodId;
      const wantsToStoreCard = rest?.storePaymentMethod; // or your custom flag

      const merchantAccount = isLive && merchantPrefix
        ? process.env.ADYEN_LIVE_MERCHANTACCOUNT
        : process.env.ADYEN_TEST_MERCHANTACCOUNT;

      const baseUrl = isLive
        ? 'https://pal-live.adyen.com'
        : 'https://pal-test.adyen.com';

      // Forward for card-on-file for Opera
      if (isMember && storedPaymentMethodId) {
        console.log("Forwarding to Opera (card-on-file)...");

        //console.log("Opera token response:", operaResponse);
      }

      // Forward to store token for member profile
      else if (isMember && wantsToStoreCard) {
        console.log("Forwarding to store token for member...");


        //console.log("Member token response:", memberTokenResponse);
      }
      else{
        console.log("not supported")
      }
    }

    res.json(result);
  } catch (error) {
    console.error("Error completing payment:", error);
    res.status(500).json(error.response?.data || { error: error.message });
  }
});


//End hotels tokenisation example

//Standard Integration Server Endpoints
// POST /api/sessions
app.post('/api/sessions', async (req, res) => {
  const { isLive = false, merchantPrefix = "", version, isMember, ...rest } = req.body;

  console.log("TESTING")
  rest.storePaymentMethodMode="askForConsent";
  rest.recurringProcessingModel = "Subscription"
  rest.shopperReference = "TestShopper"

  try {
    const result = await createSession(rest, isLive, merchantPrefix, version);
    console.log("result",result);
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
  console.log("Calling /payment/methods");
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

app.get('/status', (req, res) => {
  const status = req.query.status || 'unknown';
  res.render('status', { status });
});

app.all('/redirect', async (req, res) => {
  try {
   
    let actualResultCode = null; 
    //check if there is session result in query, if there is make a get session result call to adyen
    if(req.query.sessionResult){
      const sessionResult = req.query.sessionResult;
      const sessionOutcome = await checkSessionOutcome({ sessionId: req.query.sessionId, sessionResult });
      console.log(sessionOutcome);
      actualResultCode = sessionOutcome.payments?.[0].resultCode;
    }else{
        const redirectResult = req.method === 'POST' ? req.body.redirectResult : req.query.redirectResult;
        if (!redirectResult) {
          return res.status(400).json({ error: 'Missing redirectResult parameter.' });
        }
        const result = await submitAdditionalDetails(
          { details: { redirectResult } }, // Format expected by Adyen
          false, // isLive
          ''    // merchantPrefix
        );
        actualResultCode = result.resultCode;
        res.json(result); // Or handle result.action.type for redirects, etc.
    }
    if (actualResultCode) {
      switch (actualResultCode) {
        case "Authorised":
          return res.redirect("/status?status=success");
        case "Pending":
        case "Received":
          return res.redirect("/status?status=pending");
        case "Refused":
          return res.redirect("/status?status=failed");
        case "Cancelled":
          return res.redirect("/status?status=cancelled");
        case "Error":
          return res.redirect("/status?status=error");
        default:
          return res.redirect("/status?status=unknown");
      }
    }
  } catch (error) {
    console.error('Error during redirect handling:', error.message);
    res.status(500).json(error.response?.data || { error: error.message });
  }
});
//End Standard Integration Server Endpoints

app.listen(PORT, () => {
  console.log(`🚀 Adyen API Demo running at http://localhost:${PORT}`);
});
