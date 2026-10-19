const path = require('path');
const fs = require('fs');
const app = require('./server');
const InboundServer = require('../core/inbound-server');

// Load server config
const configPath = path.join(__dirname, '..', 'config', 'server.json');
let serverConfig = {
  me: 'mail.localmta.dev',
  inbound: { port: 2525, host: '0.0.0.0' },
  dashboard: { port: 3000, host: '0.0.0.0' }
};

if (fs.existsSync(configPath)) {
  try {
    serverConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {}
}

const HTTP_PORT = parseInt(process.env.PORT || serverConfig.dashboard.port || '3000', 10);
const SMTP_PORT = parseInt(process.env.SMTP_RELAY_PORT || serverConfig.inbound.port || '2525', 10);
const SMTP_HOST = process.env.SMTP_HOST || serverConfig.inbound.host || '0.0.0.0';

// Load plugins list from config/plugins.json
const pluginsConfigPath = path.join(__dirname, '..', 'config', 'plugins.json');
let pluginList = ['logger', 'access', 'spf', 'dkim_sign', 'queue_outbound'];
if (fs.existsSync(pluginsConfigPath)) {
  try {
    pluginList = JSON.parse(fs.readFileSync(pluginsConfigPath, 'utf8'));
  } catch (e) {}
}

// Instantiate Haraka Inbound Server
const inboundServer = new InboundServer({
  port: SMTP_PORT,
  host: SMTP_HOST,
  me: serverConfig.me || 'mail.localmta.dev',
  pluginsDir: path.join(__dirname, '..', 'plugins'),
  queueDir: path.join(__dirname, '..', 'queue')
});

// Load Haraka plugins
inboundServer.loadPlugins(pluginList);

// Attach to Express app for API visibility
app.locals.inboundServer = inboundServer;

// Start Inbound Haraka SMTP Server
inboundServer.start().then(() => {
  // Start Web App & REST API
  const server = app.listen(HTTP_PORT, () => {
    console.log(`\n=========================================================`);
    console.log(`🚀 HARAKA-STYLE NODE.JS DIRECT MAIL SERVER (MTA)`);
    console.log(`=========================================================`);
    console.log(`🌐 Web Dashboard & Control   : http://localhost:${HTTP_PORT}`);
    console.log(`📨 Haraka Inbound SMTP       : smtp://${SMTP_HOST}:${SMTP_PORT}`);
    console.log(`🔌 Active Plugins Loaded     : ${pluginList.join(', ')}`);
    console.log(`📂 Spool Queue Directory     : queue/`);
    console.log(`📡 Direct Outbound Delivery  : Active (DNS MX lookup -> Port 25)`);
    console.log(`=========================================================\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down Haraka-style Mail Server...');
    await inboundServer.stop();
    server.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch(err => {
  console.error('Failed to start Haraka-style Mail Server:', err);
  process.exit(1);
});
