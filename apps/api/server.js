const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.RUSTYPE_API_PORT ?? 8787);
const HOST = process.env.RUSTYPE_API_HOST ?? "127.0.0.1";
const YANDEX_CHECK_TEXT_URL = "https://speller.yandex.net/services/spellservice.json/checkText";
const MAX_TEXT_LENGTH = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const YANDEX_ERROR_CODES = {
  UNKNOWN_WORD: 1,
  REPEATED_WORD: 2,
  CAPITALIZATION: 3,
  TOO_MANY_ERRORS: 4
};
const cache = new Map();

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "rustype-api",
        provider: "yandex-speller"
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/spellcheck") {
      const body = await readJsonBody(request);
      const result = await spellcheck(body);
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, {
      error: {
        code: "NOT_FOUND",
        message: "Route not found"
      }
    });
  } catch (error) {
    const status = error.statusCode ?? 500;

    sendJson(response, status, {
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message ?? "Unexpected server error"
      }
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RusType API listening at http://${HOST}:${PORT}`);
});

async function spellcheck(body) {
  const text = String(body?.text ?? "");
  const lang = body?.lang ?? "ru";

  if (!text.trim()) {
    return {
      issues: [],
      meta: createMeta({ cached: false })
    };
  }

  if (lang !== "ru") {
    throw createHttpError(400, "UNSUPPORTED_LANGUAGE", "Only lang=ru is supported in Phase 3");
  }

  if (text.length > MAX_TEXT_LENGTH) {
    throw createHttpError(413, "TEXT_TOO_LONG", `Text must be ${MAX_TEXT_LENGTH} characters or fewer`);
  }

  const options = normalizeOptions(body?.options);
  const cacheKey = createCacheKey({ text, lang, options });
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      meta: {
        ...cached.value.meta,
        cached: true
      }
    };
  }

  const providerIssues = await callYandexSpeller({ text, lang, options });
  const issues = providerIssues.map((issue, index) => normalizeYandexIssue(issue, index));
  const value = {
    issues,
    meta: createMeta({ cached: false })
  };

  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value
  });

  return value;
}

async function callYandexSpeller({ text, lang, options }) {
  const form = new URLSearchParams();
  form.set("text", text);
  form.set("lang", lang);
  form.set("format", "plain");
  form.set("options", String(options));

  let providerResponse;

  try {
    providerResponse = await fetch(YANDEX_CHECK_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });
  } catch (error) {
    throw createHttpError(502, "PROVIDER_UNAVAILABLE", `Yandex Speller request failed: ${error.message}`);
  }

  if (!providerResponse.ok) {
    throw createHttpError(
      502,
      "PROVIDER_UNAVAILABLE",
      `Yandex Speller returned HTTP ${providerResponse.status}`
    );
  }

  return providerResponse.json();
}

function normalizeYandexIssue(issue, index) {
  return {
    id: `yandex-${index}-${issue.pos}-${issue.len}`,
    type: "spelling",
    source: "yandex-speller",
    start: issue.pos,
    length: issue.len,
    original: issue.word,
    suggestions: Array.isArray(issue.s) ? issue.s.slice(0, 5) : [],
    code: issue.code,
    explanationCode: getExplanationCode(issue),
    confidence: issue.s?.length ? 0.92 : 0.72
  };
}

function getExplanationCode(issue) {
  if (issue.code === YANDEX_ERROR_CODES.REPEATED_WORD) {
    return "SPELLING_REPEATED_WORD";
  }

  if (issue.code === YANDEX_ERROR_CODES.CAPITALIZATION) {
    return "SPELLING_CAPITALIZATION";
  }

  if (issue.code === YANDEX_ERROR_CODES.TOO_MANY_ERRORS) {
    return "SPELLING_TOO_MANY_ERRORS";
  }

  if (issue.code === YANDEX_ERROR_CODES.UNKNOWN_WORD) {
    return "SPELLING_UNKNOWN_WORD";
  }

  return "SPELLING_ERROR";
}

function normalizeOptions(options = {}) {
  let value = 0;

  if (options.ignoreWordsWithNumbers !== false) {
    value += 2;
  }

  if (options.ignoreUrls !== false) {
    value += 4;
  }

  if (options.findRepeatedWords !== false) {
    value += 8;
  }

  return value;
}

function createMeta({ cached }) {
  return {
    provider: "yandex-speller",
    cached,
    requestId: crypto.randomUUID()
  };
}

function createCacheKey(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function createHttpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > MAX_TEXT_LENGTH * 2) {
        reject(createHttpError(413, "REQUEST_TOO_LARGE", "Request body is too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(createHttpError(400, "INVALID_JSON", "Request body must be valid JSON"));
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
