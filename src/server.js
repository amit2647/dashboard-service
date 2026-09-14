const app = require("./app");
const { connectRedis } = require("./config/redis");

const PORT = Number(process.env.PORT) || 4005;

async function startServer() {
  try {
    await connectRedis();

    app.listen(PORT, () => {
      console.log(`Dashboard Service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start Dashboard Service:", error);

    process.exit(1);
  }
}

startServer();
