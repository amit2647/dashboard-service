function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = Array.isArray(req.auth?.permissions)
      ? req.auth.permissions
      : [];

    if (!permissions.includes(permission)) {
      return res.status(403).json({
        error: `Missing required permission: ${permission}`,
      });
    }

    next();
  };
}

module.exports = requirePermission;
