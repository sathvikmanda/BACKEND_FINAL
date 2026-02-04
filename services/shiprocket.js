const axios = require("axios");

/**
 * IMPORTANT:
 * - Assumes you already have a valid Shiprocket token
 * - Token should be cached & refreshed elsewhere
 */


/**
 * IMPORTANT:
 * - Assumes you already have a valid Shiprocket token
 * - Token should be cached & refreshed elsewhere
 */

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

/**
 * estimateInput = {
 *   pickup: { pincode },
 *   drop: { pincode },
 *   parcel: { weightKg }
 * }
 */
async function getShiprocketEstimate(estimateInput) {
  const { pickup, drop, parcel } = estimateInput;

  // Shiprocket requires pincodes
  if (!pickup?.pincode || !drop?.pincode) {
    console.warn("⚠️ Shiprocket skipped: missing pincode");
    return [];
  }

  const weight = Number(parcel?.weightKg) || 1;

  try {
    const token = await getShiprocketToken(); // 🔥 MUST EXIST

    const response = await axios.get(
      `${SHIPROCKET_BASE_URL}/courier/serviceability`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          pickup_postcode: pickup.pincode,
          delivery_postcode: drop.pincode,
          weight,
          cod: 0,
        },
        timeout: 15000,
      }
    );

    const apiData = response.data;

    if (
      !apiData ||
      apiData.status !== 200 ||
      !Array.isArray(apiData.data?.available_courier_companies)
    ) {
      console.error("❌ Shiprocket invalid response:", apiData);
      return [];
    }

    // 🔄 Normalize each courier
    const couriers = apiData.data.available_courier_companies.map(
      (courier) => ({
        provider: "shiprocket",
        courier_name: `${courier.courier_name} ${
          courier.is_air ? "Air" : "Surface"
        }`,
        rate: Number(courier.rate),
        estimated_delivery_days: Number(
          courier.estimated_delivery_days || 3
        ),
        courier_company_id: `shiprocket_${courier.courier_company_id}`,
        raw: courier,
      })
    );

    return couriers;
  } catch (err) {
    console.error("❌ Shiprocket estimate failed:", {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    });
    return [];
  }
}

/* --------------------------------------------------
   🔐 SHIPROCKET TOKEN HANDLER (SIMPLE + SAFE)
-------------------------------------------------- */

let cachedToken = null;
let tokenExpiry = null;

async function getShiprocketToken() {
  // Reuse token if valid
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const loginResponse = await axios.post(
    `${SHIPROCKET_BASE_URL}/auth/login`,
    {
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    },
    {
      timeout: 10000,
    }
  );

  if (!loginResponse.data?.token) {
    throw new Error("Failed to authenticate with Shiprocket");
  }

  cachedToken = loginResponse.data.token;

  // Token valid ~9 days, keep safe margin
  tokenExpiry = Date.now() + 8 * 24 * 60 * 60 * 1000;

  return cachedToken;
}

module.exports = { getShiprocketEstimate };