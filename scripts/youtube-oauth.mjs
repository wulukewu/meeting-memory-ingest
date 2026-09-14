#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET before running this script.");
  process.exit(1);
}

const host = "127.0.0.1";
const port = 53682;
const redirectUri = `http://${host}:${port}/oauth2callback`;
const state = crypto.randomBytes(18).toString("hex");
const scope = "https://www.googleapis.com/auth/youtube.readonly";

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope,
  access_type: "offline",
  prompt: "consent",
  include_granted_scopes: "true",
  state,
}).toString();

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // URL is also printed below for manual opening.
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", redirectUri);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
    const oauthError = url.searchParams.get("error");
    if (oauthError) throw new Error(`Google OAuth returned ${oauthError}`);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("No authorization code returned");

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const payload = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(JSON.stringify(payload));
    if (!payload.refresh_token) {
      throw new Error("No refresh_token returned. Revoke prior consent or rerun with prompt=consent, then try again.");
    }

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Authorization complete. You can close this tab.");
    console.log("\nYOUTUBE_REFRESH_TOKEN=\n");
    console.log(payload.refresh_token);
    console.log("\nStore it with `npx wrangler secret put YOUTUBE_REFRESH_TOKEN`. Do not commit it.\n");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Authorization failed. Check the terminal.");
    console.error(error);
  } finally {
    setTimeout(() => server.close(), 200);
  }
});

server.listen(port, host, () => {
  console.log(`Listening for Google OAuth callback on ${redirectUri}`);
  console.log("Open this URL if your browser does not open automatically:\n");
  console.log(authUrl.toString());
  console.log();
  openBrowser(authUrl.toString());
});
