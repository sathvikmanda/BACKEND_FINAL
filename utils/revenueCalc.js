function calculatePartnerRevenue(grossAmount, revenueConfig) {
  const { modelType, rules } = revenueConfig;

  let partnerShare = 0;
  let platformShare = grossAmount;

  if (modelType === "revenue_share") {
    const percent = rules.partnerSharePercent || 0;
    partnerShare = grossAmount * percent / 100;
    platformShare = grossAmount - partnerShare;
  }

  else if (modelType === "perParcelRate") {
    partnerShare = rules.perParcelRate || 0;
    platformShare = grossAmount - partnerShare;
  }

  else if (modelType === "full_partner_profit") {
    partnerShare = grossAmount;
    platformShare = 0;
  }

  else if (modelType === "fixed_rent") {
    partnerShare = 0;
    platformShare = grossAmount;
  }

  else if (modelType === "hybrid") {
    const percent = rules.partnerSharePercent || 0;
    const base = grossAmount * percent / 100;
    partnerShare = base + (rules.perParcelRate || 0);
    platformShare = grossAmount - partnerShare;
  }

  if (rules.capAmount && partnerShare > rules.capAmount) {
    partnerShare = rules.capAmount;
    platformShare = grossAmount - partnerShare;
  }

  return {
    partnerShare: Math.max(0, partnerShare),
    platformShare: Math.max(0, platformShare)
  };
}

module.exports = calculatePartnerRevenue;
    