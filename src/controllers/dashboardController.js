const { getDashboardData } = require("../services/dashboardService");

function getAuthorizationToken(req) {
  return req.headers.authorization;
}

async function getDashboard(req, res) {
  try {
    const authorizationToken = getAuthorizationToken(req);

    // Permissions include live just-in-time grants; they scope the cache.
    const dashboard = await getDashboardData(
      authorizationToken,
      req.auth.organizationId,
      req.auth.permissions,
    );

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
