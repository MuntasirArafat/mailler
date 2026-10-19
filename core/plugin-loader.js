const fs = require('fs');
const path = require('path');
const constants = require('./constants');

/**
 * PluginManager
 * Manages Haraka-style plugin lifecycle, hook registration, and chain execution.
 */
class PluginManager {
  constructor(pluginsDir) {
    this.pluginsDir = pluginsDir || path.join(__dirname, '..', 'plugins');
    this.plugins = [];
    this.hooks = {}; // hook_name -> [ { pluginName, fn, priority } ]
  }

  /**
   * Register a hook handler.
   */
  register_hook(hookName, fn, pluginName = 'core', priority = 0) {
    if (!this.hooks[hookName]) {
      this.hooks[hookName] = [];
    }
    this.hooks[hookName].push({
      pluginName,
      fn,
      priority
    });
    // Sort by priority descending
    this.hooks[hookName].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Load plugins from an array of filenames or from plugins.json config.
   */
  loadPlugins(pluginList = []) {
    this.plugins = [];
    this.hooks = {};

    for (const pluginName of pluginList) {
      this.loadPlugin(pluginName);
    }
  }

  /**
   * Load an individual plugin by name (e.g. 'access', 'dkim_sign', 'queue_outbound')
   */
  loadPlugin(pluginName) {
    const pluginPath = path.join(this.pluginsDir, `${pluginName}.js`);
    if (!fs.existsSync(pluginPath)) {
      console.warn(`[PluginManager] Plugin file not found: ${pluginPath}`);
      return;
    }

    try {
      delete require.cache[require.resolve(pluginPath)];
      const pluginModule = require(pluginPath);
      const pluginInstance = {
        name: pluginName,
        module: pluginModule,
        config: {}
      };

      // Call register if available
      if (typeof pluginModule.register === 'function') {
        const context = {
          name: pluginName,
          register_hook: (hook, methodName, priority = 0) => {
            const handler = typeof methodName === 'function' ? methodName : pluginModule[methodName];
            if (handler) {
              this.register_hook(hook, handler.bind(pluginModule), pluginName, priority);
            }
          }
        };
        pluginModule.register.call(context);
      }

      // Automatically register any exported hook_* functions
      for (const [key, val] of Object.entries(pluginModule)) {
        if (key.startsWith('hook_') && typeof val === 'function') {
          const hookName = key.replace('hook_', '');
          this.register_hook(hookName, val.bind(pluginModule), pluginName, 0);
        }
      }

      this.plugins.push(pluginInstance);
      console.log(`[PluginManager] Loaded Haraka-style plugin: "${pluginName}"`);
    } catch (err) {
      console.error(`[PluginManager] Failed to load plugin "${pluginName}":`, err);
    }
  }

  /**
   * Run all registered plugins for a given hook sequentially.
   * Signature: run_hook(hookName, connection, params, callback)
   * Callback receives: (retval, msg)
   */
  run_hook(hookName, connection, params, callback) {
    const handlers = this.hooks[hookName] || [];
    let index = 0;

    const next = (retval = constants.CONT, msg) => {
      // If plugin returned anything other than CONT, stop chain
      if (retval !== constants.CONT) {
        return callback(retval, msg);
      }

      // Check if more handlers remain
      if (index >= handlers.length) {
        // All plugins passed without veto
        return callback(constants.CONT, msg);
      }

      const current = handlers[index++];
      try {
        current.fn(next, connection, params);
      } catch (err) {
        console.error(`[PluginManager] Error in plugin "${current.pluginName}" during hook "${hookName}":`, err);
        // Fail-safe: continue to next or fail soft
        next(constants.CONT);
      }
    };

    next();
  }
}

module.exports = PluginManager;
