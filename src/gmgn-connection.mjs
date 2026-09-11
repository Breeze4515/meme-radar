import { normalizeGmgnApiKey } from './gmgn-key-store.mjs';

export class GmgnConnection {
  constructor({ gmgn, keyStore, scanner }) {
    this.gmgn = gmgn;
    this.keyStore = keyStore;
    this.scanner = scanner;
    this.checking = false;
    this.generation = 0;
  }

  snapshot() {
    const key = this.gmgn.apiKey();
    return {
      configured: Boolean(key),
      status: this.checking ? 'CHECKING' : !key ? 'UNCONFIGURED'
        : this.gmgn.lastVerifiedKey === key ? 'VERIFIED' : 'CONFIGURED'
    };
  }

  async apply(value) {
    const apiKey = normalizeGmgnApiKey(value);
    if (!apiKey) throw Object.assign(new Error('Invalid key'), { code: 'INVALID_GMGN_API_KEY' });
    if (this.checking) throw Object.assign(new Error('Connection check in progress'), { code: 'GMGN_CHECK_BUSY' });
    this.checking = true;
    const generation = this.generation;
    try {
      // The mandatory Agent/public-key pairing already happened on GMGN's key
      // creation page. Verify only the read permission used by this scanner;
      // never consume the stricter signed follow-wallet /trade route here.
      const result = await this.gmgn.verifyApiKey(apiKey);
      if (result?.verified !== true) throw Object.assign(new Error('Verification did not complete'), { code: 'GMGN_REQUEST_FAILED' });
      if (generation !== this.generation) throw Object.assign(new Error('Connection cancelled'), { code: 'GMGN_CHECK_CANCELLED' });
      // Keep the existing key and scans working if the new one is rejected.
      if (this.keyStore.activatePending() !== true) {
        throw Object.assign(new Error('GMGN onboarding is required'), { code: 'GMGN_ONBOARDING_REQUIRED' });
      }
      this.keyStore.save(apiKey);
      this.gmgn.resetCredentials?.();
      this.gmgn.lastVerifiedKey = apiKey;
      this.scanner.requestCycle();
      return { configured: true, verified: true };
    } finally { this.checking = false; }
  }

  disconnect() {
    this.generation++;
    this.keyStore.disconnect();
    this.gmgn.resetCredentials({ disabled: true });
    this.scanner.requestCycle();
    return { disconnected: true };
  }
}
