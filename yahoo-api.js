import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const OAUTH_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENS_PATH = path.join(__dirname, ".tokens.json");

export function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
}

export function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function parseTokenResponse(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const params = new URLSearchParams(bodyText);
    if ([...params.keys()].length === 0) {
      throw new Error(`Expected JSON but got: ${bodyText.slice(0, 200)}`);
    }
    return Object.fromEntries(params.entries());
  }
}

function buildTokenPayload(tokenData, fallbackRefreshToken = null) {
  const now = Date.now();
  const expiresIn = Number(tokenData.expires_in) || null;
  const expiresAt = expiresIn ? now + expiresIn * 1000 : null;
  return {
    ...tokenData,
    refresh_token: tokenData.refresh_token || fallbackRefreshToken || null,
    issued_at: now,
    expires_at: expiresAt,
  };
}

export async function refreshTokens({ consumerKey, consumerSecret, refreshToken }) {
  if (!refreshToken) {
    throw new Error("Missing refresh token. Re-run auth.");
  }
  const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed ${response.status}: ${bodyText}`);
  }

  const tokenData = parseTokenResponse(bodyText);
  return buildTokenPayload(tokenData, refreshToken);
}

export function isTokenExpired(tokens, skewSeconds = 60) {
  if (!tokens?.expires_at) return false;
  return Date.now() >= tokens.expires_at - skewSeconds * 1000;
}

export async function yahooRequest({ method = "GET", url, accessToken }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Yahoo API error ${response.status}: ${bodyText}`);
  }

  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`Expected JSON but got: ${bodyText.slice(0, 200)}`);
  }
}
