#!/usr/bin/env node
// First-run setup for host-side development: the README's manual steps in one command.
//
// Creates .env from .env.example with fresh secrets when none exists (an existing .env is never
// touched, since its Postgres password and encryption key must keep matching stored data), starts
// Postgres on loopback, and applies migrations. Secrets are written only to .env, never printed.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const hex = (bytes) => randomBytes(bytes).toString("hex");
// Windows resolves pnpm's .cmd shim only through a shell; the arguments here are fixed strings.
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });

function succeeds(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!succeeds("docker", ["info"])) {
  console.error("Docker is not running. Start Docker and run this again.");
  process.exit(1);
}

const pgdataExists =
  execFileSync(
    "docker",
    [
      "volume",
      "ls",
      "-q",
      "--filter",
      // Compose names the project after the compose file's directory.
      "label=com.docker.compose.project=compose",
      "--filter",
      "label=com.docker.compose.volume=pgdata",
    ],
    { encoding: "utf8" },
  ).trim() !== "";

if (existsSync(".env")) {
  console.log("Keeping existing .env");
} else if (pgdataExists) {
  // A new password would not match the one this volume was initialized with.
  console.error(
    "Postgres data already exists but .env is missing. Restore the .env that created it, or back up and run `pnpm compose:reset`.",
  );
  process.exit(1);
} else {
  const postgresPassword = hex(16);
  let env = readFileSync(".env.example", "utf8")
    .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${postgresPassword}`)
    .replace("REPLACE_WITH_POSTGRES_PASSWORD", postgresPassword)
    .replace("replace-with-32-plus-character-secret", hex(32))
    .replace("replace-with-64-random-hex-characters", hex(32))
    .replace("replace-with-32-plus-character-supervisor-token", hex(32))
    .replace("replace-with-32-plus-character-screen-proxy-secret", hex(32));
  // Docker Desktop (macOS, Windows) can't route to container IPs; Linux Docker Engine can.
  if (process.platform !== "linux") {
    env = env.replace(
      /^# SANDBOX_CONTROL_VIA_LOOPBACK=true$/m,
      "SANDBOX_CONTROL_VIA_LOOPBACK=true",
    );
  }
  writeFileSync(".env", env, { mode: 0o600 });
  console.log("Created .env with new secrets");
}

run("docker", [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "infra/compose/docker-compose.yml",
  "-f",
  "infra/compose/docker-compose.postgres-host.yml",
  "up",
  "postgres",
  "-d",
  "--wait",
]);
run("pnpm", ["db:generate"]);
run("pnpm", ["db:migrate"]);

if (!succeeds("docker", ["image", "inspect", "rakazo/computer:local"])) {
  console.log("Bot computers need the sandbox image: run `pnpm sandbox:build` once.");
}
console.log("Ready. Run `pnpm dev` and open http://127.0.0.1:5173");
