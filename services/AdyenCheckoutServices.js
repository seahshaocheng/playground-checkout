const axios = require('axios');
require('dotenv').config();

const latestVersion = 'v71';

const getLiveMerchantAccount = () => {
    return process.env.ADYEN_LIVE_MERCHANTACCOUNT || process.env.ADYEN_LIVE_MERCHANT_ACCOUNT;
};

const getTestMerchantAccount = () => {
    return process.env.ADYEN_TEST_MERCHANTACCOUNT || process.env.ADYEN_TEST_MERCHANT_ACCOUNT;
};

const getLivePrefix = () => {
    return process.env.ADYEN_LIVE_PREFIX;
};

const configHandler = (isLive, version) => {
    const livePrefix = getLivePrefix();
    if (isLive && !livePrefix) {
        throw new Error('Missing ADYEN_LIVE_PREFIX for live Adyen requests.');
    }

    const url = isLive
        ? `https://${livePrefix}-checkout-live.adyenpayments.com/checkout/${version}`
        : `https://checkout-test.adyen.com/checkout/${version}`;

    const apikey = isLive? process.env.ADYEN_API_KEY_LIVE : process.env.ADYEN_API_KEY_TEST;

    const merchantAccount = isLive
        ? getLiveMerchantAccount()
        : getTestMerchantAccount();
    return { url, apikey,merchantAccount };
}


//Adyen Sessions API
const createSession = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {

    const config = configHandler(isLive, version);
    const url = `${config.url}/sessions`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    //if merchantaccount in data is not defined
    if (!data.merchantAccount) {
        data.merchantAccount = config.merchantAccount;
    }

    console.log(data);
    
    try {
        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error creating session:', error.response.data);
        throw error;
    }   
}

//Adyen Advanced Flow
const getPaymentMethods = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {
    
    const config = configHandler(isLive, version);
    const url = `${config.url}/paymentMethods`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    console.log("Post to Adyen Gateway Data");
    console.log(JSON.stringify(data, null, 2));

    try {
        const response = await axios.post(url, data, { headers });
        console.log("Response ",response);
        return response.data;
    } catch (error) {
        console.error('Error getting payment methods:', error.response.data);
        throw error;
    }
}

const intiatePayment = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {
    
    const config = configHandler(isLive, version);
    const url = `${config.url}/payments`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    //drop browserInfo from data if it exist
    if (data.browserInfo) {
        console.log("Removing browserInfo from data");
        delete data.browserInfo;
    }

    //Zip specific fields
    if(data.paymentMethod && data.paymentMethod.type && data.paymentMethod.type.includes("zip")){
        //
        data.deliveryAddress={
            //generate random address for testing in Australia
            street: "Test Street",
            postalCode: "2000",
            city: "Sydney",
            houseNumberOrName: "1",
            country: "AU",
            stateOrProvince: "NSW"

        }

        delete data.riskData;
    }

    console.log("Post to Adyen Gateway Data");
    console.log(JSON.stringify(data, null, 2));

    try {
        //JAVA library to send request
        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error initiating payment:', error.response.data);
        throw error;
    }
}

const submitAdditionalDetails = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {
   
    const config = configHandler(isLive, version);
        const url = `${config.url}/payments/details`;
        const headers = {
            'Content-Type': 'application/json',
            'X-API-Key': config.apikey,
        };

        try {
            const response = await axios.post(url, data, { headers });
            return response.data;
        } catch (error) {
            console.error('Error submitting additional details:', error.response.data);
            throw error;
        }
}

const checkSessionOutcome = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {
    const config = configHandler(isLive, version);
    const url = `${config.url}/sessions/${data.sessionId}?sessionResult=${data.sessionResult}`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey
    };

    try {
        const response = await axios.get(url ,{ headers });
        return response.data;
    } catch (error) {
        console.error('Error submitting additional details:', error.response.data);
        throw error;
    }
}


const forward = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {
    const config = configHandler(isLive, version);
    const url = `${config.url}/forward`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    try {
        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error submitting additional details:', error);
        throw error;
    }
}

//remove storedPaymentMethod
const removeStoredPaymentMethod = async (data, isLive = false, _merchantPrefix = "", version = latestVersion) => {
    const config = configHandler(isLive, version);
    const url = `${config.url}/storedPaymentMethods/${data.storedPaymentMethodId}?merchantAccount=${data.merchantAccount}&shopperReference=${data.shopperReference}`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    try {
        const response = await axios.delete(url, { headers });
        return response;
    } catch (error) {
        console.error('Error removing stored payment method:', error.response.data);
        throw error;
    }
}

module.exports = {
    forward,
    createSession,
    getPaymentMethods,
    removeStoredPaymentMethod,
    intiatePayment,
    submitAdditionalDetails,
    checkSessionOutcome
}