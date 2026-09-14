const { getDashboardData } = require("../services/dashboardService");

function getAuthorizationToken(req) {
  return req.headers.authorization;
}

async function getDashboard(req, res) {
  try {
    const authorizationToken = getAuthorizationToken(req);

    const dashboard = await getDashboardData(authorizationToken);

    return res.json(dashboard);
  } catch (error) {
    console.error("[Dashboard Controller]", error);

    return res.status(error.statusCode || 500).json({
      error: error.message || "Unable to load dashboard",
    });
  }
}

module.exports = {
  getDashboard,
};
