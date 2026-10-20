const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DkimManager {
  constructor(configDir) {
    this.configDir = configDir || path.join(__dirname, '..', 'config');
    this.keyFile = path.join(this.configDir, 'dkim-keys.json');
    this.keys = {};
    this.init();
  }

  init() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    if (fs.existsSync(this.keyFile)) {
      try {
        const raw = fs.readFileSync(this.keyFile, 'utf8');
        this.keys = JSON.parse(raw);
      } catch (e) {
        this.keys = {};
      }
    } else {
      this.keys = {};
    }
  }

  save() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    fs.writeFileSync(this.keyFile, JSON.stringify(this.keys, null, 2), 'utf8');
  }

  /**
   * Generate an RSA 2048-bit key pair for a domain.
   */
  generateKey(domain, selector = 'default') {
    const cleanDomain = domain.toLowerCase().trim();
    const cleanSelector = selector.toLowerCase().trim();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });

    const pubKeyBase64 = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/[\r\n\s]/g, '');

    const recordName = `${cleanSelector}._domainkey.${cleanDomain}`;
    const txtValue = `v=DKIM1; k=rsa; p=${pubKeyBase64}`;

    const keyObj = {
      domain: cleanDomain,
      selector: cleanSelector,
      privateKey,
      publicKey,
      recordName,
      txtValue,
      createdAt: new Date().toISOString()
    };

    this.init();
    if (!this.keys[cleanDomain]) {
      this.keys[cleanDomain] = {};
    }
    this.keys[cleanDomain][cleanSelector] = keyObj;
    this.save();

    return keyObj;
  }

  /**
   * Set or import an existing private key and selector for a domain.
   */
  setKey(domain, selector, privateKey, publicKey = '') {
    const cleanDomain = domain.toLowerCase().trim();
    const cleanSelector = (selector || 'default').toLowerCase().trim();
    this.init();

    const pubKeyBase64 = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/[\r\n\s]/g, '');

    const recordName = `${cleanSelector}._domainkey.${cleanDomain}`;
    const txtValue = pubKeyBase64 ? `v=DKIM1; k=rsa; p=${pubKeyBase64}` : '';

    const keyObj = {
      domain: cleanDomain,
      selector: cleanSelector,
      privateKey: privateKey.trim(),
      publicKey: publicKey.trim(),
      recordName,
      txtValue,
      createdAt: new Date().toISOString()
    };

    if (!this.keys[cleanDomain]) {
      this.keys[cleanDomain] = {};
    }
    this.keys[cleanDomain][cleanSelector] = keyObj;
    this.save();

    return keyObj;
  }

  /**
   * Get DKIM signing config for a domain.
   * If none exists, automatically generates a 2048-bit key and saves it so emails are ALWAYS signed.
   */
  getKey(domain, selector = 'default') {
    this.init();
    const cleanDomain = domain.toLowerCase().trim();
    const cleanSelector = selector.toLowerCase().trim();

    if (this.keys[cleanDomain]) {
      if (this.keys[cleanDomain][cleanSelector]) {
        return this.keys[cleanDomain][cleanSelector];
      }
      const selectors = Object.keys(this.keys[cleanDomain]);
      if (selectors.length > 0) {
        return this.keys[cleanDomain][selectors[0]];
      }
    }

    // Auto-generate key if not found so outgoing email is guaranteed to be DKIM signed
    return this.generateKey(cleanDomain, cleanSelector);
  }

  /**
   * List all configured DKIM keys.
   */
  listKeys() {
    this.init();
    const list = [];
    for (const [domain, selectors] of Object.entries(this.keys)) {
      for (const [selector, data] of Object.entries(selectors)) {
        list.push({
          domain,
          selector,
          recordName: data.recordName,
          txtValue: data.txtValue,
          hasPrivateKey: !!data.privateKey,
          createdAt: data.createdAt
        });
      }
    }
    return list;
  }

  /**
   * Delete a key.
   */
  deleteKey(domain, selector = 'default') {
    this.init();
    const cleanDomain = domain.toLowerCase().trim();
    if (this.keys[cleanDomain] && this.keys[cleanDomain][selector]) {
      delete this.keys[cleanDomain][selector];
      if (Object.keys(this.keys[cleanDomain]).length === 0) {
        delete this.keys[cleanDomain];
      }
      this.save();
      return true;
    }
    return false;
  }
}

module.exports = new DkimManager();
