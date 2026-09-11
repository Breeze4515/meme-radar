import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KEY_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

export function normalizeGmgnApiKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim();
  if (!key.startsWith('gmgn_')) return '';
  return KEY_SUFFIX_PATTERN.test(key.slice(5)) ? key : '';
}

// Legacy configuration is a fallback only. Never load dotenv into process.env
// or import the CLI entry point: either would let an old key override the UI.
export function legacyGmgnApiKey(source = process.env, configFile = path.join(os.homedir(), '.config', 'gmgn', '.env')) {
  const environmentKey = normalizeGmgnApiKey(source.GMGN_API_KEY);
  if (environmentKey) return environmentKey;
  try {
    const contents = fs.readFileSync(configFile, 'utf8');
    const match = contents.match(/^\s*(?:export\s+)?GMGN_API_KEY\s*=\s*["']?(gmgn_[A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/m);
    return normalizeGmgnApiKey(match?.[1]);
  } catch { return ''; }
}

function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    const error = new Error('GMGN key directory is invalid');
    error.code = 'GMGN_KEY_DIRECTORY_INVALID';
    throw error;
  }
  fs.chmodSync(dir, 0o700);
}

export class GmgnKeyStore {
  constructor(stateDir) {
    this.dir = path.resolve(stateDir);
    this.file = path.join(this.dir, 'gmgn-api-key');
    this.signingFile = path.join(this.dir, 'gmgn-signing-key.pem');
    this.pendingSigningFile = path.join(this.dir, 'gmgn-pending-signing-key.pem');
    this.disconnectFile = path.join(this.dir, 'gmgn-disconnected');
    secureDirectory(this.dir);
  }

  readSigningKey(file) {
    if (!fs.existsSync(file)) return '';
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid signing key file');
    if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
    const pem = fs.readFileSync(file, 'utf8');
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('unsupported signing key');
    return pem;
  }

  writeFreshSigningKey(file) {
    secureDirectory(this.dir);
    try {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        fs.writeFileSync(descriptor, pem, { encoding: 'utf8' });
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.renameSync(temporary, file);
        fs.chmodSync(file, 0o600);
      } catch (error) {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch {}
        }
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
      return pem;
    } catch {
      const error = new Error('GMGN signing key could not be prepared');
      error.code = 'GMGN_SIGNING_KEY_FAILED';
      throw error;
    }
  }

  verificationPrivateKey() {
    try {
      return this.readSigningKey(this.pendingSigningFile);
    } catch {
      const error = new Error('GMGN signing key could not be read');
      error.code = 'GMGN_SIGNING_KEY_FAILED';
      throw error;
    }
  }

  activatePending() {
    const pending = this.readSigningKey(this.pendingSigningFile);
    if (!pending) return false;
    if (fs.existsSync(this.signingFile)) fs.unlinkSync(this.signingFile);
    fs.renameSync(this.pendingSigningFile, this.signingFile);
    fs.chmodSync(this.signingFile, 0o600);
    return true;
  }

  onboarding({ regenerate = false } = {}) {
    let pending = '';
    try { pending = regenerate ? '' : this.readSigningKey(this.pendingSigningFile); } catch {}
    if (!pending) pending = this.writeFreshSigningKey(this.pendingSigningFile);
    const privateKey = crypto.createPrivateKey(pending);
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    return {
      algorithm: 'Ed25519',
      publicKey,
      createUrl: `https://gmgn.ai/ai/generateapi?pbk=${encodeURIComponent(publicKey)}`
    };
  }

  get() {
    try {
      if (!fs.existsSync(this.file)) return '';
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) return '';
      if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(this.file, 0o600);
      return normalizeGmgnApiKey(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return '';
    }
  }

  configured() {
    return Boolean(this.get());
  }

  disconnected() { return fs.existsSync(this.disconnectFile); }

  disconnect() {
    secureDirectory(this.dir);
    // Persist the opt-out first so a crash cannot reactivate the legacy fallback.
    fs.writeFileSync(this.disconnectFile, 'disconnected\n', { mode: 0o600 });
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }

  save(value) {
    const key = normalizeGmgnApiKey(value);
    if (!key) {
      const error = new Error('GMGN API key is invalid');
      error.code = 'INVALID_GMGN_API_KEY';
      throw error;
    }

    secureDirectory(this.dir);
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, `${key}\n`, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
      if (fs.existsSync(this.disconnectFile)) fs.unlinkSync(this.disconnectFile);
    } catch {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
      const error = new Error('GMGN API key could not be saved');
      error.code = 'GMGN_KEY_SAVE_FAILED';
      throw error;
    }
    return true;
  }
}
