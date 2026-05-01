export enum AIProvider {
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  Google = 'google',
}

type VaultRecord = {
  provider: AIProvider;
  ciphertext: string;
  iv: string;
  updatedAt: string;
  version: number;
};

type VaultPayload = {
  salt: string;
  records: Partial<Record<AIProvider, VaultRecord>>;
};

const VAULT_STORAGE_KEY = 'aetherflow:keyvault:v1';
const PASSPHRASE_KEY = 'aetherflow:keyvault:passphrase';
const DEFAULT_PASSPHRASE = 'aetherflow-local-default-passphrase';
const PBKDF2_ITERATIONS = 150_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = {
  encode: (bytes: Uint8Array): string => {
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  },
  decode: (value: string): Uint8Array => {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  },
};

export class KeyVault {
  private static getPassphrase(): string {
    const fromStorage = localStorage.getItem(PASSPHRASE_KEY);
    if (fromStorage) return fromStorage;
    localStorage.setItem(PASSPHRASE_KEY, DEFAULT_PASSPHRASE);
    return DEFAULT_PASSPHRASE;
  }

  private static getOrCreatePayload(): VaultPayload {
    const payload = localStorage.getItem(VAULT_STORAGE_KEY);
    if (payload) return JSON.parse(payload) as VaultPayload;
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const initial: VaultPayload = { salt: b64.encode(saltBytes), records: {} };
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }

  private static async deriveAesKey(saltBase64: string): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.getPassphrase()),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64.decode(saltBase64),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private static async encrypt(value: string, salt: string): Promise<{ iv: string; ciphertext: string }> {
    const key = await this.deriveAesKey(salt);
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      encoder.encode(value),
    );

    return {
      iv: b64.encode(ivBytes),
      ciphertext: b64.encode(new Uint8Array(encrypted)),
    };
  }

  private static async decrypt(ciphertext: string, iv: string, salt: string): Promise<string> {
    const key = await this.deriveAesKey(salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.decode(iv) },
      key,
      b64.decode(ciphertext),
    );
    return decoder.decode(decrypted);
  }

  static async setKey(provider: AIProvider, apiKey: string): Promise<void> {
    const payload = this.getOrCreatePayload();
    const encrypted = await this.encrypt(apiKey, payload.salt);
    const currentVersion = payload.records[provider]?.version ?? 0;
    payload.records[provider] = {
      provider,
      ...encrypted,
      updatedAt: new Date().toISOString(),
      version: currentVersion + 1,
    };
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(payload));
  }

  static async getKey(provider: AIProvider): Promise<string | null> {
    const payload = this.getOrCreatePayload();
    const record = payload.records[provider];
    if (!record) return null;
    return this.decrypt(record.ciphertext, record.iv, payload.salt);
  }

  static deleteKey(provider: AIProvider): void {
    const payload = this.getOrCreatePayload();
    delete payload.records[provider];
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(payload));
  }

  static listProvidersWithKeys(): AIProvider[] {
    const payload = this.getOrCreatePayload();
    return (Object.keys(payload.records) as AIProvider[]).filter((provider) => !!payload.records[provider]);
  }

  static getMaskedKeyPreview(provider: AIProvider): string | null {
    const payload = this.getOrCreatePayload();
    if (!payload.records[provider]) return null;
    return '••••••••••••';
  }

  static async rotateMasterKey(newPassphrase: string): Promise<void> {
    const payload = this.getOrCreatePayload();
    const existing: Partial<Record<AIProvider, string>> = {};

    for (const provider of Object.values(AIProvider)) {
      const record = payload.records[provider];
      if (!record) continue;
      existing[provider] = await this.decrypt(record.ciphertext, record.iv, payload.salt);
    }

    const newSalt = b64.encode(crypto.getRandomValues(new Uint8Array(16)));
    const nextPayload: VaultPayload = { salt: newSalt, records: {} };
    localStorage.setItem(PASSPHRASE_KEY, newPassphrase);

    for (const provider of Object.values(AIProvider)) {
      const raw = existing[provider];
      if (!raw) continue;
      const encrypted = await this.encrypt(raw, newSalt);
      nextPayload.records[provider] = {
        provider,
        ...encrypted,
        updatedAt: new Date().toISOString(),
        version: (payload.records[provider]?.version ?? 0) + 1,
      };
    }

    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(nextPayload));
  }
}
