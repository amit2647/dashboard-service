module.exports = {
  leadServiceUrl: process.env.LEAD_SERVICE_URL || "http://localhost:4001",

  customerServiceUrl:
    process.env.CUSTOMER_SERVICE_URL || "http://localhost:4002",

  serviceServiceUrl: process.env.SERVICE_SERVICE_URL || "http://localhost:4003",

  obligationServiceUrl: process.env.OBLIGATION_SERVICE_URL || "http://localhost:4010",
};
