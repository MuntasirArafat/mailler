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
    }
  }

  save() {
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

    // Extract base64 public key for DNS TXT record (strip PEM headers and newlines)
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

    if (!this.keys[cleanDomain]) {
      this.keys[cleanDomain] = {};
    }
    this.keys[cleanDomain][cleanSelector] = keyObj;
    this.save();

    return keyObj;
  }

  /**
   * Get DKIM signing config for a domain.
   */
  getKey(domain, selector = 'default') {
    const cleanDomain = domain.toLowerCase().trim();
    if (this.keys[cleanDomain]) {
      if (this.keys[cleanDomain][selector]) {
        return this.keys[cleanDomain][selector];
      }
      // Return first available selector if specified one not found
      const selectors = Object.keys(this.keys[cleanDomain]);
      if (selectors.length > 0) {
        return this.keys[cleanDomain][selectors[0]];
      }
    }
    return null;
  }

  /**
   * List all configured DKIM keys.
   */
  listKeys() {
    const list = [];
    for (const [domain, selectors] of Object.entries(this.keys)) {
      for (const [selector, data] of Object.entries(selectors)) {
        list.push({
          domain,
          selector,
          recordName: data.recordName,
          txtValue: data.txtValue,
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
