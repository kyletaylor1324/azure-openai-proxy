// azure-openai-proxy.js
const express = require("express");
const { DefaultAzureCredential } = require("@azure/identity");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { program } = require("commander");

program
  .option("-p, --port <port>", "Port to listen on", 2000)
  .parse(process.argv);

const app = express();
const credential = new DefaultAzureCredential();

// Token caching with refresh coordination
const tokenCache = {
  token: null,
  expiresOn: 0,
  refreshPromise: null,
};

async function getCachedToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresOn - 300000)
    return tokenCache.token;

  if (tokenCache.refreshPromise) return await tokenCache.refreshPromise;

  try {
    tokenCache.refreshPromise = async () => {
      const tokenResult = await credential.getToken(
        "https://cognitiveservices.azure.com/.default",
      );
      tokenCache.token = tokenResult.token;
      tokenCache.expiresOn = tokenResult.expiresOnTimestamp;
      return tokenResult.token;
    };
    return await tokenCache.refreshPromise;
  } finally {
    tokenCache.refreshPromise = null;
  }
}

// Single endpoint at root path
app.use("/", async (req, res, next) => {
  try {
    // Validate required query parameters
    const { resource, deployment, api_version } = req.query;

    if (!resource || !deployment || !api_version)
      return res.status(400).json({
        error:
          "Missing required query parameters: resource, deployment, api_version",
      });

    // Get cached or fresh token
    const token = await getCachedToken();

    // Create proxy middleware
    const proxy = createProxyMiddleware({
      target: `https://${resource}.openai.azure.com`,
      changeOrigin: true,
      pathRewrite: () =>
        `/openai/deployments/${deployment}/chat/completions?api-version=${api_version}`,
      onProxyReq: (proxyReq) => {
        proxyReq.removeHeader("api-key");
        proxyReq.setHeader("Authorization", `Bearer ${token}`);
      },
    });

    // Handle the proxy request
    proxy(req, res, next);
  } catch (error) {
    console.error("Proxy error:", error.message);
    res.status(500).json({ error: "Proxy request failed" });
  }
});

// Start server
app.listen(program.opts().port, () => {
  console.log(
    `Azure OpenAI proxy running on http://localhost:${program.opts().port}`,
  );
  console.log("Usage:");
  console.log(
    `curl http://localhost:${program.opts().port}/?resource=RESOURCE&deployment=DEPLOYMENT&api_version=API_VERSION`,
  );
  console.log('  -H "Content-Type: application/json"');
  console.log('  -d \'{"messages": [{"role": "user", "content": "Hello"]}\'');
});
