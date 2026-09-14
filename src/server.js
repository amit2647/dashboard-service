const app = require("./app");

const PORT = Number(process.env.PORT) || 4005;

app.listen(PORT, () => {
  console.log(`Dashboard Service running on port ${PORT}`);
});
