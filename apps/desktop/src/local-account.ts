import { randomBytes } from "node:crypto";
import path from "node:path";
import type { RakazoDesktopLocalAccount } from "@rakazo/contracts";
import { isLoopbackHost } from "./setup-config.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const LOCAL_ACCOUNTS_FILE_NAME = "local-accounts.json";
const MAX_LOCAL_ACCOUNTS_BYTES = 64 * 1024;
/** RFC 2606 reserves .invalid, so the address can never deliver mail or collide with a person's. */
const LOCAL_ACCOUNT_EMAIL_DOMAIN = "desktop.rakazo.invalid";

/** OS-backed encryption for the stored password; Electron's safeStorage in the app. */
export interface LocalAccountCipher {
  available: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
}

type StoredAccounts = Record<string, { email: string; password: string }>;

/**
 * Only a server on this computer gets an app-held account. A server anyone else
 * can reach keeps ordinary sign-in, since its first account owns the deployment.
 */
export function localAccountOrigin(targetUrl: string | undefined): string | null {
  if (!targetUrl) return null;
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return isLoopbackHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function newLocalAccount(random: (bytes: number) => Buffer): RakazoDesktopLocalAccount {
  return {
    email: `${random(9).toString("hex")}@${LOCAL_ACCOUNT_EMAIL_DOMAIN}`,
    password: random(32).toString("base64url"),
  };
}

function parseStored(raw: string | null): StoredAccounts {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const accounts: StoredAccounts = {};
    for (const [origin, entry] of Object.entries(value)) {
      if (localAccountOrigin(origin) !== origin) continue;
      const { email, password } = (entry ?? {}) as Record<string, unknown>;
      if (typeof email === "string" && typeof password === "string") {
        accounts[origin] = { email, password };
      }
    }
    return accounts;
  } catch {
    return {};
  }
}

export class LocalAccountStore {
  private readonly file: string;
  /** Serializes read-modify-write so two creates cannot each mint a different account. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    userDataDir: string,
    private readonly cipher: LocalAccountCipher,
    private readonly random: (bytes: number) => Buffer = randomBytes,
  ) {
    this.file = path.join(userDataDir, LOCAL_ACCOUNTS_FILE_NAME);
  }

  available(): boolean {
    return this.cipher.available();
  }

  read(origin: string): Promise<RakazoDesktopLocalAccount | null> {
    return this.serialize(() => this.readUnlocked(origin));
  }

  /** Returns the saved account for the origin, minting and saving one the first time. */
  ensure(origin: string): Promise<RakazoDesktopLocalAccount> {
    return this.serialize(async () => {
      const existing = await this.readUnlocked(origin);
      if (existing) return existing;
      const account = newLocalAccount(this.random);
      const accounts = parseStored(await readPrivateFile(this.file, MAX_LOCAL_ACCOUNTS_BYTES));
      accounts[origin] = {
        email: account.email,
        password: this.cipher.encrypt(account.password).toString("base64"),
      };
      await writePrivateFile(this.file, `${JSON.stringify(accounts, null, 2)}\n`);
      return account;
    });
  }

  private async readUnlocked(origin: string): Promise<RakazoDesktopLocalAccount | null> {
    if (!this.cipher.available()) return null;
    const entry = parseStored(await readPrivateFile(this.file, MAX_LOCAL_ACCOUNTS_BYTES))[origin];
    if (!entry) return null;
    try {
      return {
        email: entry.email,
        password: this.cipher.decrypt(Buffer.from(entry.password, "base64")),
      };
    } catch {
      // A keychain reset makes the saved password unreadable; the person signs in normally.
      return null;
    }
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
