const axios = require('axios');
require('dotenv').config();

const latestVersion = 'v71';

const configHandler= (isLive,merchantPrefix,version) => {
    const url = isLive
        ? `https://${merchantPrefix}-checkout-live.adyenpayments.com/checkout/${version}`
        : `https://checkout-test.adyen.com/${version}`;

    const apikey = isLive? process.env.ADYEN_API_KEY_LIVE : process.env.ADYEN_API_KEY_TEST;

    const merchantAccount = isLive
        ? process.env.ADYEN_LIVE_MERCHANT_ACCOUNT
        : process.env.ADYEN_TEST_MERCHANTACCOUNT;
    return { url, apikey,merchantAccount };
}


//Adyen Sessions API
const createSession = async (data,isLive=false,merchantPrefix="",version=latestVersion) => {

    const config = configHandler(isLive,merchantPrefix,version);
    const url = `${config.url}/sessions`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    data.merchantAccount = config.merchantAccount;

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
const getPaymentMethods = async (data,isLive=false,merchantPrefix="",version=latestVersion) => {
    
    const config = configHandler(isLive,merchantPrefix,version);
    const url = `${config.url}/paymentMethods`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    try {
        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error getting payment methods:', error.response.data);
        throw error;
    }
}

const intiatePayment = async (data,isLive=false,merchantPrefix="",version=latestVersion) => {
    
    const config = configHandler(isLive,merchantPrefix,version);
    const url = `${config.url}/payments`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': config.apikey,
    };

    try {
        const response = await axios.post(url, data, { headers });
        return response.data;
    } catch (error) {
        console.error('Error initiating payment:', error.response.data);
        throw error;
    }
}

const submitAdditionalDetails = async (data,isLive=false,merchantPrefix="",version=latestVersion) => {
   
    const config = configHandler(isLive,merchantPrefix,version);
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

module.exports = {
    createSession,
    getPaymentMethods,
    intiatePayment,
    submitAdditionalDetails
}