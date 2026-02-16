function calculatePartnerRevenue(grossAmount, revenueConfig) {

  const gross = Number(grossAmount);   // ← force number

  const { modelType, rules } = revenueConfig;

  let partnerShare = 0;
  let platformShare = gross;

  if (modelType === "revenue_share") {
    const percent = Number(rules.partnerSharePercent) || 0;
    partnerShare = gross * percent / 100;
    platformShare = gross - partnerShare;
  }

  else if (modelType === "perParcelRate") {
    partnerShare = Number(rules.perParcelRate) || 0;
    platformShare = gross - partnerShare;
  }

  else if (modelType === "full_partner_profit") {
    partnerShare = gross;
    platformShare = 0;
  }

  else if (modelType === "fixed_rent") {
    partnerShare = 0;
    platformShare = gross;
  }

  else if (modelType === "hybrid") {
    const percent = Number(rules.partnerSharePercent) || 0;
    const base = gross * percent / 100;
    partnerShare = base + (Number(rules.perParcelRate) || 0);
    platformShare = gross - partnerShare;
  }

  const cap = Number(rules.capAmount);
  if (cap && partnerShare > cap) {
    partnerShare = cap;
    platformShare = gross - partnerShare;
  }

  return {
    partnerShare: Math.max(0, Number(partnerShare)),
    platformShare: Math.max(0, Number(platformShare))
  };
}

module.exports = calculatePartnerRevenue;
