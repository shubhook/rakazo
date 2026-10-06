import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_ACCOUNTS_FILE_NAME,
  type LocalAccountCipher,
  LocalAccountStore,
  localAccountOrigin,
  newLocalAccount,
} from "./local-account.js";

const ORIGIN = "http://127.0.0.1:5173";

/** Reversible stand-in for safeStorage that never leaves the plaintext in the file. */
function fakeCipher(available = true): LocalAccountCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`),
    decrypt: (cipher) => {
      const text = cipher.toString();
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return Buffer.from(text.slice(4), "hex").toString();
    },
  };
}

let counter = 0;
function counterRandom(bytes: number) {
  counter += 1;
  return Buffer.alloc(bytes, counter);
}

describe("localAccountOrigin", () => {
  it("accepts only servers on this computer", () => {
    expect(localAccountOrigin("http://127.0.0.1:5173/app")).toBe(ORIGIN);
    expect(localAccountOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(localAccountOrigin("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(localAccountOrigin("https://rakazo.example.com")).toBeNull();
    expect(localAccountOrigin("http://192.168.1.20:5173")).toBeNull();
    expect(localAccountOrigin("file:///tmp/index.html")).toBeNull();
    expect(localAccountOrigin("not a url")).toBeNull();
    expect(localAccountOrigin(undefined)).toBeNull();
  });
});

describe("newLocalAccount", () => {
  it("uses an undeliverable address and a long random password", () => {
    const account = newLocalAccount(counterRandom);
    expect(account.email).toMatch(/^[a-f0-9]{18}@desktop\.rakazo\.invalid$/);
    expect(account.password.length).toBeGreaterThanOrEqual(43);
  });
});

describe("LocalAccountStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-local-account-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mints one account per origin and reads it back", async () => {
    const store = new LocalAccountStore(dir, fakeCipher(), counterRandom);
    expect(await store.read(ORIGIN)).toBeNull();

    const [first, second] = await Promise.all([store.ensure(ORIGIN), store.ensure(ORIGIN)]);
    expect(second).toEqual(first);
    expect(await store.read(ORIGIN)).toEqual(first);
    expect(await new LocalAccountStore(dir, fakeCipher()).read(ORIGIN)).toEqual(first);

    const other = await store.ensure("http://localhost:3000");
    expect(other.email).not.toBe(first.email);
    expect(await store.read(ORIGIN)).toEqual(first);
  });

  it("keeps the password encrypted in an owner-only file", async () => {
    const store = new LocalAccountStore(dir, fakeCipher(), counterRandom);
    const account = await store.ensure(ORIGIN);
    const file = path.join(dir, LOCAL_ACCOUNTS_FILE_NAME);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain(account.email);
    expect(raw).not.toContain(account.password);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("reads nothing without OS encryption or with an unreadable password", async () => {
    await new LocalAccountStore(dir, fakeCipher(), counterRandom).ensure(ORIGIN);
    expect(await new LocalAccountStore(dir, fakeCipher(false)).read(ORIGIN)).toBeNull();

    await writeFile(
      path.join(dir, LOCAL_ACCOUNTS_FILE_NAME),
      JSON.stringify({ [ORIGIN]: { email: "a@desktop.rakazo.invalid", password: "garbage" } }),
    );
    expect(await new LocalAccountStore(dir, fakeCipher()).read(ORIGIN)).toBeNull();
  });

  it("ignores saved entries for servers that are not local", async () => {
    const cipher = fakeCipher();
    await writeFile(
      path.join(dir, LOCAL_ACCOUNTS_FILE_NAME),
      JSON.stringify({
        "https://rakazo.example.com": {
          email: "a@desktop.rakazo.invalid",
          password: cipher.encrypt("secret").toString("base64"),
        },
      }),
    );
    expect(await new LocalAccountStore(dir, cipher).read("https://rakazo.example.com")).toBeNull();
  });
});
