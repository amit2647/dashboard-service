const jwt = require("jsonwebtoken");

function authenticate(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const token = authorization.substring("Bearer ".length).trim();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: process.env.JWT_ISSUER,
    });

    req.auth = {
      userId: Number(decoded.sub),
      organizationId: Number(decoded.organizationId),
      role: decoded.role,
      permissions: Array.isArray(decoded.permissions)
        ? decoded.permissions
        : [],
    };

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired authentication token",
    });
  }
}

module.exports = authenticate;
