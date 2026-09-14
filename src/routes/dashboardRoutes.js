const express = require("express");

const dashboardController = require("../controllers/dashboardController");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");

const router = express.Router();

router.get(
  "/dashboard",
  authenticate,
  requirePermission("reports.read"),
  dashboardController.getDashboard,
);

module.exports = router;
