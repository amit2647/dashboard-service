const express = require("express");
const cors = require("cors");

const dashboardRoutes = require("./routes/dashboardRoutes");
const requestLogger = require("./middleware/requestLogger");

const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.get("/health", (req, res) => {
  res.json({
    service: "dashboard-service",
    status: "ok",
    architecture: "aggregation-service",
  });
});

app.use(dashboardRoutes);

module.exports = app;
