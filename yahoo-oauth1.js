import crypto from "crypto";
import { URL } from "url";

const OAUTH_VERSION = "1.0";
const SIGNATURE_METHOD = "HMAC-SHA1";

export function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/'/g, "%27");
}

function normalizeParams(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");
}

function signatureBaseString(method, baseUrl, params) {
  return [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalizeParams(params)),
  ].join("&");
}

function signingKey(consumerSecret, tokenSecret = "") {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

export function buildOAuthHeader({
  method,
  url,
  consumerKey,
  consumerSecret,
  token = "",
  tokenSecret = "",
  extraParams = {},
}) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: OAUTH_VERSION,
  };

  if (token) {
    oauthParams.oauth_token = token;
  }

  const parsedUrl = new URL(url);
  const queryParams = {};
  parsedUrl.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });

  const signatureParams = {
    ...oauthParams,
    ...queryParams,
    ...extraParams,
  };

  const baseString = signatureBaseString(
    method,
    `${parsedUrl.origin}${parsedUrl.pathname}`,
    signatureParams
  );

  const signature = crypto
    .createHmac("sha1", signingKey(consumerSecret, tokenSecret))
    .update(baseString)
    .digest("base64");

  oauthParams.oauth_signature = signature;

  const header =
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${percentEncode(key)}=\"${percentEncode(oauthParams[key])}\"`)
      .join(", ");

  return { header, oauthParams };
}

export function parseQueryString(body) {
  return body
    .split("&")
    .map((pair) => pair.split("="))
    .reduce((acc, [key, value]) => {
      acc[decodeURIComponent(key)] = decodeURIComponent(value || "");
      return acc;
    }, {});
}
