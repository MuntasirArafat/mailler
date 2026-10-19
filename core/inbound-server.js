const net = require('net');
const EventEmitter = require('events');
const PluginManager = require('./plugin-loader');
const OutboundQueue = require('./outbound-queue');
const Connection = require('./connection');

/**
 * Haraka-style Inbound SMTP Server
 * Runs on Node.js net sockets, processes plugins, and spools to outbound queue.
 */
class InboundServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 2525;
    this.host = options.host || '0.0.0.0';
    this.me = options.me || 'mail.localmta.dev';
    this.tlsOptions = options.tlsOptions || null;

    this.pluginManager = new PluginManager(options.pluginsDir);
    this.outboundQueue = new OutboundQueue({
      queueDir: options.queueDir,
      heloHost: this.me
    });

    this.server = null;
    this.connections = new Set();
  }

  /**
   * Load plugins configured in plugins.json.
   */
  loadPlugins(pluginList = ['logger', 'access', 'dkim_sign', 'queue_outbound']) {
    this.pluginManager.loadPlugins(pluginList);
  }

  /**
   * Start the SMTP listener.
   */
  start() {
    return new Promise((resolve, reject) => {
      // Start Outbound queue worker
      this.outboundQueue.start();

      this.server = net.createServer((socket) => {
        this.connections.add(socket);
        socket.on('close', () => this.connections.delete(socket));

        new Connection(socket, this);
      });

      this.server.on('error', (err) => {
        console.error('[InboundServer] Server Error:', err);
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[InboundServer] Haraka-Engine listening on ${this.host}:${this.port}`);
        this.emit('listening', { host: this.host, port: this.port });
        resolve(this);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.outboundQueue.stop();
      for (const socket of this.connections) {
        socket.destroy();
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

module.exports = InboundServer;
