const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');

const {
  forward,
  createSession,
  getSession,
  getPaymentMethods,
  intiatePayment,
  submitAdditionalDetails,
  checkSessionOutcome,
  removeStoredPaymentMethod
} = require('./services/AdyenCheckoutServices');
const req = require('express/lib/request');

const app = express();
const PORT = process.env.PORT || 3005;
const DEFAULT_SDK_VERSION = '6.13.1';

let hotelOrders = [];

const getLiveMerchantAccount = () => {
  return process.env.ADYEN_LIVE_MERCHANTACCOUNT || process.env.ADYEN_LIVE_MERCHANT_ACCOUNT;
};

const getCheckoutContext = (req) => {
  const sdkVersion = req.query.version || DEFAULT_SDK_VERSION;
  const env = req.query.env || 'test';
  const clientKey = env === 'live' ? process.env.ADYEN_LIVE_CLIENT_KEY : process.env.ADYEN_TEST_CLIENT_KEY;

  return {
    sdkVersion,
    env,
    clientKey,
    testClientKey: process.env.ADYEN_TEST_CLIENT_KEY,
    liveClientKey: process.env.ADYEN_LIVE_CLIENT_KEY
  };
};

const getMerchantAccountFromBody = (isLive) => {
  return isLive
    ? getLiveMerchantAccount()
    : (process.env.ADYEN_TEST_MERCHANTACCOUNT || process.env.ADYEN_TEST_MERCHANT_ACCOUNT);
};

app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'allow'
}));
// Health check

const CURRENCY_TO_COUNTRY_CODE = {
  SGD: 'SG',
  MYR: 'MY',
  HKD: 'HK',
  AUD: 'AU',
  USD: 'US',
  EUR: 'DE',
  GBP: 'GB',
  JPY: 'JP',
  CAD: 'CA'
};

const handleCurrencyToCountryCode = (currency) => {
  const normalizedCurrency = String(currency || '').toUpperCase();
  return CURRENCY_TO_COUNTRY_CODE[normalizedCurrency] || 'SG';
}

const handlehotelsMerchantAccountCode = (currency) => {
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

const maskSecret = (value) => {
  if (!value) {
    return 'Unavailable';
  }

  const normalized = String(value);
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  }

  return `${normalized.slice(0, 4)}${'*'.repeat(Math.max(4, normalized.length - 8))}${normalized.slice(-4)}`;
};

const integrationVariants = [
  {
    name: 'Drop-in Session Basic',
    description: 'Simple session-based Drop-in with configuration form and shopper viewport only.',
    href: '/dropin-session-basic',
    group: 'Session'
  },
  {
    name: 'Drop-in Session Explorer',
    description: 'Session-based Drop-in with interactive runtime explorer and sequence visibility.',
    href: '/dropin-session',
    group: 'Session'
  },
  {
    name: 'Drop-in Advanced Basic',
    description: 'Simple advanced Drop-in with configuration form and direct callbacks only.',
    href: '/dropin-advanced-basic',
    group: 'Advanced'
  },
  {
    name: 'Drop-in Advanced Flow',
    description: 'Advanced Drop-in callbacks with direct payments and additional details handling.',
    href: '/dropin-advanced',
    group: 'Advanced'
  },
  {
    name: 'Drop-in Advanced Booking',
    description: 'Booking-oriented advanced Drop-in flow for reservation style payment journeys.',
    href: '/dropin-advance-booking',
    group: 'Advanced'
  },
  {
    name: 'Custom Card Component',
    description: 'Card component integration for full control of payment UI and interaction points.',
    href: '/custom-card',
    group: 'Custom'
  },
  {
    name: 'Hotels Booking Demo',
    description: 'Customized hotels booking and payment journey with vertical-specific behavior.',
    href: '/hotels/booking',
    group: 'Vertical'
  }
];

app.get('/', (req, res) => {
  const integrationGroups = [...new Set(integrationVariants.map((variant) => variant.group))];
  res.render('index', {
    defaultSdkVersion: DEFAULT_SDK_VERSION,
    integrationVariants,
    integrationGroups
  });
});

app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  res.sendFile(path.join(__dirname,'.well-known','apple-developer-merchantid-domain-association'));
});

app.get('/dropin-session', (req, res) => {
  const checkoutContext = getCheckoutContext(req);
  res.render('dropin-session', {
    ...checkoutContext,
    maskedTestApiKey: maskSecret(process.env.ADYEN_API_KEY_TEST),
    maskedLiveApiKey: maskSecret(process.env.ADYEN_API_KEY_LIVE)
  });
});

app.get('/dropin-session-basic', (req, res) => {
  res.render('dropin-session-basic', getCheckoutContext(req));
});

app.get('/dropin-advanced', (req, res) => {
  res.render('dropin-advance', getCheckoutContext(req));
});

app.get('/dropin-advanced-basic', (req, res) => {
  res.render('dropin-advanced-basic', getCheckoutContext(req));
});

app.get('/dropin-advance-booking',(req,res)=>{
  res.render('dropin-advance-booking', getCheckoutContext(req));
})

app.get('/custom-card',(req,res)=>{
  res.render('custom-card', getCheckoutContext(req));
})

//hotels Customisation
app.get('/hotels/booking',(req,res)=>{
  const checkoutContext = getCheckoutContext(req);
  const mode = req.query.mode || null;
  const currency = req.query.CURRENCY || 'SGD';
  const country = handleCurrencyToCountryCode(currency);
  const merchantAccount = handlehotelsMerchantAccountCode(currency);
  const shopperReference = req.query.shopperReference || '';
  res.render('custom-demos/hotels/hotels-booking', {
    ...checkoutContext,
    mode,
    currency,
    country,
    shopperReference,
    merchantAccount
  });
})

app.get('/hotels/booking-confirmation',(req,res)=>{
  const checkoutContext = getCheckoutContext(req);
  const mode = req.query.mode || null;
  const currency = req.query.CURRENCY || 'SGD';
  const country = handleCurrencyToCountryCode(currency);
  const merchantAccount = handlehotelsMerchantAccountCode(currency);
  const shopperReference = req.query.shopperReference || '';
  res.render('custom-demos/hotels/hotels-booking-confirmation', {
    ...checkoutContext,
    mode,
    currency,
    country,
    merchantAccount,
    shopperReference
  });
})

app.get('/hotels/booking-payment',(req,res)=>{
  const checkoutContext = getCheckoutContext(req);
  const mode = req.query.mode || null;
  const currency = req.query.CURRENCY || 'SGD';
  const country = handleCurrencyToCountryCode(currency);
  const merchantAccount = handlehotelsMerchantAccountCode(currency);
  const shopperReference = req.query.shopperReference || '';
  res.render('custom-demos/hotels/hotels-booking-payment', {
    ...checkoutContext,
    mode,
    currency,
    country,
    merchantAccount,
    shopperReference
  });
})
//end hotels customisation


app.post('/api/hotel/initatePayment', async (req, res) => {
  console.log("initating payment");
  console.log(req.body);
  try {
    const {
      isLive = false,
      merchantPrefix = "",
      version,
      isMember = false,
      shopperInteraction,
      ...rest
    } = req.body;

    const merchantAccount = getMerchantAccountFromBody(isLive);

    console.log(req.body);
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

      const merchantAccount = getMerchantAccountFromBody(isLive);

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
  console.log("Creating session with body:", req.body);
  const { isLive = false, merchantPrefix = "", version, isMember, ...rest } = req.body;

  rest.merchantAccount = getMerchantAccountFromBody(isLive);
  console.log("the currency is", rest.amount.currency);
  rest.countryCode = handleCurrencyToCountryCode(rest.amount.currency);
  console.log("Request body for sessions:");
  console.log(JSON.stringify(rest, null, 2));

  const allowedStorePaymentMethodModes = ['enabled', 'askForConsent', 'disabled'];
  if (!allowedStorePaymentMethodModes.includes(rest.storePaymentMethodMode)) {
    rest.storePaymentMethodMode = 'askForConsent';
  }
  rest.recurringProcessingModel = "Subscription"

  try {
    const result = await createSession(rest, isLive, merchantPrefix, version);
    console.log("result for session",result);
    res.json(result);
  } catch (error) {
    console.log("THis is the error");
    console.log(error);
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const isLive = req.query.isLive === 'true';
  const merchantPrefix = req.query.merchantPrefix || '';
  const version = req.query.version;
  const sessionResult = req.query.sessionResult;

  try {
    const result = await getSession({ sessionId: id, sessionResult }, isLive, merchantPrefix, version);
    console.log('Retrieved session from Adyen:', result);
    res.json(result);
  } catch (error) {
    console.error('Error retrieving session:', error.message);
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

app.get('/api/sessionoutcome/:id', async (req, res) => {
  const { id } = req.params;
  try {
      const sessionResult = req.query.sessionResult;
      const sessionOutcome = await checkSessionOutcome({ sessionId:id, sessionResult });
      console.log("session outcome 1");
      console.log(sessionOutcome);

      let originalStoredPaymentMethodId = sessionOutcome.additionalData['tokenization.storedPaymentMethodId'];
      let originalShopperReference = sessionOutcome.additionalData['recurring.shopperReference'];
      let newShopperReference = sessionOutcome.reference;

      console.log('Stored Payment Method ID:', originalStoredPaymentMethodId);
      console.log('Original Shopper Reference:', originalShopperReference);
      console.log('New Shopper Reference:', newShopperReference);


      const forwardBody = {
          merchantAccount:"SG_Lyf_Funan",
          shopperReference:originalShopperReference,
          storedPaymentMethodId: originalStoredPaymentMethodId,
          baseUrl: "https://pal-test.adyen.com/",
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
              shopperReference:newShopperReference,
              recurring: {
                contract:"RECURRING"
              }
            })
          }}
          
      console.log("Retrieved shopper token for reservation");
      const forwardResult = await forward(forwardBody,false,"");
      console.log(forwardResult);
      const convertedForwardResult = JSON.parse(forwardResult.response.body);
      console.log(convertedForwardResult.recurringDetailReference); 

    res.json(sessionOutcome);
  } catch (error) {
    console.error('Error retrieving session outcome:', error.message);
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

// POST /api/paymentMethods
app.post('/api/paymentMethods', async (req, res) => {
  const { isLive = false, merchantPrefix = "", version, isMember, ...rest } = req.body;
  console.log("Calling /payment/methods");
  rest.merchantAccount = getMerchantAccountFromBody(isLive);
  console.log("the currency is", rest.amount.currency);
  rest.countryCode = handleCurrencyToCountryCode(rest.amount.currency);
  console.log("Request body for payment methods:");
  console.log(JSON.stringify(rest, null, 2));
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
  rest.merchantAccount = getMerchantAccountFromBody(isLive);
  rest.countryCode = handleCurrencyToCountryCode(rest.amount.currency);

  try {
    const result = await intiatePayment(rest, isLive, merchantPrefix, version);
    console.log("the payment result")
    console.log(result);
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
    console.log("the payment details result")
    console.log(result);
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
    const isLive = req.method === 'POST' ? Boolean(req.body?.isLive) : false;
    const merchantPrefix = req.method === 'POST' ? (req.body?.merchantPrefix || '') : '';
    const version = req.method === 'POST' ? req.body?.version : undefined;
   
    let actualResultCode = null; 
    //check if there is session result in query, if there is make a get session result call to adyen
    if(req.query.sessionResult){
      const sessionResult = req.query.sessionResult;
      const sessionOutcome = await checkSessionOutcome({ sessionId: req.query.sessionId, sessionResult }, isLive, merchantPrefix, version);
      console.log(sessionOutcome);
      actualResultCode = sessionOutcome.payments?.[0].resultCode;
    }else{
        const redirectResult = req.method === 'POST' ? req.body.redirectResult : req.query.redirectResult;
        if (!redirectResult) {
          return res.status(400).json({ error: 'Missing redirectResult parameter.' });
        }
        console.log("submitting additional details with redirectResult:", redirectResult);
        const result = await submitAdditionalDetails(
          { details: { redirectResult } }, // Format expected by Adyen
          isLive,
          merchantPrefix,
          version
        );
        actualResultCode = result.resultCode;

    console.log("the result code is", result);
        //res.json(result); // Or handle result.action.type for redirects, etc.
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

//remove payment methods
app.post('/api/deletePaymentMethods/:id', async (req, res) => {
  const {id} = req.params;
  const { merchantAccount, shopperReference } = req.body;
  const { isLive = false, merchantPrefix = "", version } = req.body;
  const resolvedMerchantAccount = merchantAccount || getMerchantAccountFromBody(isLive);

  try {
    const result = await removeStoredPaymentMethod({ storedPaymentMethodId: id, merchantAccount: resolvedMerchantAccount, shopperReference }, isLive, merchantPrefix, version);
    console.log("DELETEING TOKENc")
    console.log(result);
    res.send(result.status);
  } catch (error) {
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

//
//End Standard Integration Server Endpoints

app.listen(PORT, () => {
  console.log(`🚀 Adyen API Demo running at http://localhost:${PORT}`);
});
