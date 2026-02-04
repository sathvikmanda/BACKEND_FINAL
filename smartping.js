const axios = require("axios");

async function sendSMS(number,text) {
  const url = "https://restapi.smscountry.com/v0.1/Accounts/Ltowy0SKWQUxNK5tRV14/SMSes/";
  const payload = {
    Text: text,
    Number: number,
    SenderId: "DROPNT",
    DRNotifyUrl: "https://www.domainname.com/notifyurl",
    DRNotifyHttpMethod: "POST",
    Tool: "API",
  };

  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Basic " + Buffer.from("Ltowy0SKWQUxNK5tRV14:mGwY2blgvdEnJKuR7NYQEAzHabqmEoTSj8vaj5Hr").toString("base64"),
  };
 
  
  try {
    const res = await axios.post(url, payload, { headers });
    console.log("SMS sent:", res.data);
  } catch (err) {
    console.error("Error sending SMS:", err.response?.data || err.message);
  }
}

module.exports = {sendSMS};