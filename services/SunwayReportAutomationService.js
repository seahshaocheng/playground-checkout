const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const axios = require('axios');

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const STORAGE_ROOT = process.env.REPORT_STORAGE_DIR
  ? path.resolve(process.env.REPORT_STORAGE_DIR)
  : (process.env.SUNWAY_REPORT_STORAGE_DIR
    ? path.resolve(process.env.SUNWAY_REPORT_STORAGE_DIR)
    : path.join(__dirname, '..', 'data', 'reports-automation'));

const REPORTS_DIR = path.join(STORAGE_ROOT, 'reports');
const WEBHOOKS_DIR = path.join(STORAGE_ROOT, 'Webhooks');
const RATES_DIR = path.join(STORAGE_ROOT, 'rates');
const PAYMENT_LINKS_PATH = path.join(STORAGE_ROOT, 'payment-links.json');
const WEBHOOK_LOG_PATH = path.join(STORAGE_ROOT, 'webhook-events.ndjson');
const REPORT_INDEX_PATH = path.join(STORAGE_ROOT, 'report-index.json');
const FX_TABLE_PATH = path.join(STORAGE_ROOT, 'fx-table.json');
const WEBHOOK_PROCESSING_INDEX_PATH = path.join(STORAGE_ROOT, 'webhook-processing-index.json');

const WEBHOOK_CRON_INTERVAL_MS = Number(
  process.env.REPORT_WEBHOOK_CRON_INTERVAL_MS
  || process.env.SUNWAY_WEBHOOK_CRON_INTERVAL_MS
  || 2 * 1000
);

const REPORT_POLL_ENDPOINT = process.env.REPORT_POLL_ENDPOINT || process.env.SUNWAY_FX_REPORT_POLL_ENDPOINT || '';
const REPORT_USER = process.env.REPORT_USER || process.env.SUNWAY_REPORT_USER || '';
const REPORT_PASSWORD = process.env.REPORT_PASSWORD || process.env.SUNWAY_REPORT_PASSWORD || '';
const REPORT_API_KEY = process.env.REPORT_API_KEY || process.env.SUNWAY_REPORT_API_KEY || '';
const ADYEN_TEST_REPORT_API_KEY = process.env.ADYEN_TEST_REPORT_API_KEY || '';
const ADYEN_LIVE_REPORT_API_KEY = process.env.ADYEN_LIVE_REPORT_API_KEY || '';
const REPORT_SERVICE_USER_API_KEY = process.env.REPORT_SERVICE_USER_API_KEY || '';
const REPORT_SERVICE_USER_API_KEY_TEST = process.env.REPORT_SERVICE_USER_API_KEY_TEST || '';
const REPORT_SERVICE_USER_API_KEY_LIVE = process.env.REPORT_SERVICE_USER_API_KEY_LIVE || '';

let timerRef = null;

const ensureStorage = () => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(WEBHOOKS_DIR, { recursive: true });
  fs.mkdirSync(RATES_DIR, { recursive: true });
};

const readJsonFile = (filePath, fallbackValue) => {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallbackValue;
  }
};

const writeJsonFile = (filePath, content) => {
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
};

const appendNdjson = (filePath, payload) => {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
};

const buildAuthHeaders = () => {
  const headers = {};

  if (REPORT_API_KEY) {
    headers['X-API-Key'] = REPORT_API_KEY;
  }

  if (REPORT_USER && REPORT_PASSWORD) {
    const basic = Buffer.from(`${REPORT_USER}:${REPORT_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }

  return headers;
};

const parseCsvLine = (line) => {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
};

const detectColumnIndex = (headers, patterns) => {
  const normalized = headers.map((header) => String(header || '').toLowerCase());
  for (let i = 0; i < normalized.length; i += 1) {
    const column = normalized[i];
    if (patterns.some((pattern) => pattern.test(column))) {
      return i;
    }
  }
  return -1;
};

const normalizeCurrency = (value) => String(value || '').trim().toUpperCase();

const normalizeMerchantAccountCode = (value) => {
  return toSafeFileSegment(String(value || 'UNKNOWN_MERCHANT').trim().toUpperCase());
};

const getMerchantScopedDir = (baseDir, merchantAccountCode) => {
  return path.join(baseDir, normalizeMerchantAccountCode(merchantAccountCode));
};

const toSafeFileSegment = (value, fallback = 'UNKNOWN') => {
  const normalized = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const toIsoDate = (dateValue) => {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
};

const getDefaultRatesDate = () => {
  return toIsoDate(Date.now() - 24 * 60 * 60 * 1000);
};

const RATES_FILE_PATTERN = /^rates_(\d{4}-\d{2}-\d{2})\.json$/;

const getRateSearchDirs = (merchantAccountCode) => {
  if (merchantAccountCode) {
    return [
      getMerchantScopedDir(RATES_DIR, merchantAccountCode),
      RATES_DIR
    ];
  }

  const merchantDirs = fs.readdirSync(RATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((dirName) => path.join(RATES_DIR, dirName));

  return [...merchantDirs, RATES_DIR];
};

const findLatestRatesFileOnOrBeforeDate = ({ requestedDate, merchantAccountCode }) => {
  const requestedTs = Date.parse(`${requestedDate}T00:00:00.000Z`);
  if (!Number.isFinite(requestedTs)) {
    return null;
  }

  const searchDirs = getRateSearchDirs(merchantAccountCode);
  let bestMatch = null;

  searchDirs.forEach((dirPath, priority) => {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach((entry) => {
      if (!entry.isFile()) {
        return;
      }

      const match = entry.name.match(RATES_FILE_PATTERN);
      if (!match) {
        return;
      }

      const dateOfReport = match[1];
      const candidateTs = Date.parse(`${dateOfReport}T00:00:00.000Z`);
      if (!Number.isFinite(candidateTs) || candidateTs > requestedTs) {
        return;
      }

      if (!bestMatch || candidateTs > bestMatch.timestamp || (candidateTs === bestMatch.timestamp && priority < bestMatch.priority)) {
        bestMatch = {
          dateOfReport,
          timestamp: candidateTs,
          priority,
          filePath: path.join(dirPath, entry.name)
        };
      }
    });
  });

  if (!bestMatch) {
    return null;
  }

  return {
    dateOfReport: bestMatch.dateOfReport,
    filePath: bestMatch.filePath
  };
};

const pickLatestByValidFrom = (rows = []) => {
  if (rows.length === 0) {
    return null;
  }

  return rows.reduce((latest, current) => {
    if (!latest) {
      return current;
    }

    const latestTs = Date.parse(latest.validFrom || '');
    const currentTs = Date.parse(current.validFrom || '');

    if (!Number.isFinite(latestTs) && Number.isFinite(currentTs)) {
      return current;
    }

    if (Number.isFinite(latestTs) && Number.isFinite(currentTs) && currentTs >= latestTs) {
      return current;
    }

    return latest;
  }, null);
};

const extractNotificationRequestItem = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.NotificationRequestItem && typeof payload.NotificationRequestItem === 'object') {
    return payload.NotificationRequestItem;
  }

  if (Array.isArray(payload.notificationItems) && payload.notificationItems.length > 0) {
    const first = payload.notificationItems[0];
    if (first && typeof first.NotificationRequestItem === 'object') {
      return first.NotificationRequestItem;
    }

    if (first && typeof first === 'object') {
      return first;
    }
  }

  return payload;
};

const getWebhookReportUrl = (payload, notificationRequestItem = {}) => {
  const additionalData = notificationRequestItem.additionalData || {};

  return additionalData.reportUrl
    || additionalData.downloadUrl
    || notificationRequestItem.reportUrl
    || notificationRequestItem.downloadUrl
    || notificationRequestItem.reason
    || payload?.reportUrl
    || payload?.downloadUrl
    || payload?.reason
    || null;
};

const extractFxRowsFromCsv = (csvText, fileName) => {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const sourceCurrencyIdx = detectColumnIndex(headers, [
    /source.*currency/,
    /from.*currency/,
    /base.*currency/,
    /^source$/,
    /^from$/
  ]);
  const targetCurrencyIdx = detectColumnIndex(headers, [
    /target.*currency/,
    /to.*currency/,
    /counter.*currency/,
    /^target$/,
    /^to$/
  ]);
  const rateIdx = detectColumnIndex(headers, [
    /fx.*rate/,
    /exchange.*rate/,
    /^rate$/
  ]);
  const dateIdx = detectColumnIndex(headers, [
    /booking.*date/,
    /created.*at/,
    /date/,
    /time/
  ]);

  if (sourceCurrencyIdx === -1 || targetCurrencyIdx === -1 || rateIdx === -1) {
    return [];
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const sourceCurrency = normalizeCurrency(values[sourceCurrencyIdx]);
    const targetCurrency = normalizeCurrency(values[targetCurrencyIdx]);
    const rate = Number(values[rateIdx]);

    if (!sourceCurrency || !targetCurrency || !Number.isFinite(rate) || rate <= 0) {
      continue;
    }

    rows.push({
      sourceCurrency,
      targetCurrency,
      rate,
      effectiveAt: values[dateIdx] || null,
      fileName
    });
  }

  return rows;
};

const loadReportIndex = () => {
  const content = readJsonFile(REPORT_INDEX_PATH, { downloaded: [] });
  if (!Array.isArray(content.downloaded)) {
    content.downloaded = [];
  }
  return content;
};

const loadWebhookProcessingIndex = () => {
  const content = readJsonFile(WEBHOOK_PROCESSING_INDEX_PATH, { processed: {} });
  if (!content || typeof content !== 'object' || typeof content.processed !== 'object') {
    return { processed: {} };
  }

  return content;
};

const saveWebhookProcessingIndex = (indexContent) => {
  writeJsonFile(WEBHOOK_PROCESSING_INDEX_PATH, indexContent);
};

const loadPaymentLinks = () => {
  const content = readJsonFile(PAYMENT_LINKS_PATH, { links: {} });
  if (!content || typeof content !== 'object' || typeof content.links !== 'object') {
    return { links: {} };
  }

  return content;
};

const savePaymentLinks = (content) => {
  writeJsonFile(PAYMENT_LINKS_PATH, content);
};

const buildPaymentLinkKey = (paymentLinkId, merchantAccountCode = '') => {
  const id = String(paymentLinkId || '').trim();
  const merchant = String(merchantAccountCode || '').trim().toUpperCase();
  return `${merchant}::${id}`;
};

const registerPaymentLink = ({
  paymentLinkId,
  merchantAccountCode,
  reference,
  paymentLinkUrl,
  expiresAt,
  status = 'pending',
  paymentMethod,
  pspReference,
  amount,
  currency
}) => {
  if (!paymentLinkId || !merchantAccountCode) {
    return null;
  }

  const store = loadPaymentLinks();
  const key = buildPaymentLinkKey(paymentLinkId, merchantAccountCode);
  const existing = store.links[key] || {};

  store.links[key] = {
    paymentLinkId,
    merchantAccountCode,
    reference: reference || existing.reference || null,
    paymentLinkUrl: paymentLinkUrl || existing.paymentLinkUrl || null,
    expiresAt: expiresAt || existing.expiresAt || null,
    paymentMethod: paymentMethod || existing.paymentMethod || null,
    pspReference: pspReference || existing.pspReference || null,
    amount: Number.isFinite(Number(amount)) ? Number(amount) : (existing.amount || null),
    currency: currency || existing.currency || null,
    status,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  savePaymentLinks(store);
  return store.links[key];
};

const resolvePaymentLinkLifecycleStatus = (entry = {}) => {
  const rawStatus = String(entry.status || '').toLowerCase();
  if (rawStatus === 'paid') {
    return 'paid';
  }

  if (rawStatus === 'payment failed' || rawStatus === 'failed') {
    return 'payment failed';
  }

  if (rawStatus === 'expired') {
    return 'expired';
  }

  const expiresAtTs = Date.parse(entry.expiresAt || '');
  if (Number.isFinite(expiresAtTs) && expiresAtTs <= Date.now()) {
    return 'expired';
  }

  return 'active';
};

const listPaymentLinks = (options = {}) => {
  const merchantFilter = String(options.merchantAccountCode || '').trim().toUpperCase();
  const store = loadPaymentLinks();
  const rows = Object.values(store.links || {})
    .filter((entry) => {
      if (!merchantFilter) {
        return true;
      }

      return String(entry.merchantAccountCode || '').trim().toUpperCase() === merchantFilter;
    })
    .map((entry) => ({
      ...entry,
      lifecycleStatus: resolvePaymentLinkLifecycleStatus(entry)
    }))
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0;
      const bTime = Date.parse(b.createdAt || '') || 0;
      return bTime - aTime;
    });

  return rows;
};

const getPaymentLinkSummary = (options = {}) => {
  const links = listPaymentLinks(options);
  const summary = {
    totalLinks: links.length,
    successfulPayments: 0,
    activeLinks: 0,
    expiredLinks: 0,
    failedPayments: 0
  };

  links.forEach((entry) => {
    switch (entry.lifecycleStatus) {
      case 'paid':
        summary.successfulPayments += 1;
        break;
      case 'payment failed':
        summary.failedPayments += 1;
        break;
      case 'expired':
        summary.expiredLinks += 1;
        break;
      default:
        summary.activeLinks += 1;
        break;
    }
  });

  return summary;
};

const getFxRateHistory = ({ baseCurrency, targetCurrency, days = 5 }) => {
  ensureStorage();

  const normalizedBase = normalizeCurrency(baseCurrency);
  const normalizedTarget = normalizeCurrency(targetCurrency);
  const safeDays = Math.max(1, Math.min(14, Number(days) || 5));
  const points = [];

  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const dateKey = toIsoDate(date);

    const lookup = getRatesByDateAndCurrencyPair({
      date: dateKey,
      baseCurrency: normalizedBase,
      targetCurrency: normalizedTarget
    });

    if (!lookup.found) {
      points.push({
        date: dateKey,
        exchangeRate: null,
        exchangePlatformSettlement: null,
        validFrom: null
      });
      continue;
    }

    points.push({
      date: dateKey,
      exchangeRate: Number(lookup.exchangeRate),
      exchangePlatformSettlement: Number(lookup.exchangePlatformSettlement),
      validFrom: lookup.validFrom || null
    });
  }

  return {
    baseCurrency: normalizedBase,
    targetCurrency: normalizedTarget,
    days: safeDays,
    points
  };
};

const updatePaymentLinkStatusFromAuthorisation = ({
  paymentLinkId,
  merchantAccountCode,
  success,
  paymentMethod,
  pspReference,
  eventCode = 'AUTHORISATION'
}) => {
  if (!paymentLinkId || !merchantAccountCode) {
    return null;
  }

  const store = loadPaymentLinks();
  const key = buildPaymentLinkKey(paymentLinkId, merchantAccountCode);
  const existing = store.links[key];
  if (!existing) {
    return null;
  }

  const isSuccess = String(success).toLowerCase() === 'true';
  const status = isSuccess ? 'paid' : 'payment failed';
  const normalizedPaymentMethod = String(paymentMethod || existing.paymentMethod || '').trim() || null;
  const normalizedPspReference = isSuccess
    ? (String(pspReference || '').trim() || existing.pspReference || null)
    : (existing.pspReference || null);

  store.links[key] = {
    ...existing,
    status,
    paymentMethod: normalizedPaymentMethod,
    pspReference: normalizedPspReference,
    webhook: {
      eventCode,
      success: String(success),
      paymentMethod: normalizedPaymentMethod,
      pspReference: normalizedPspReference,
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  };

  savePaymentLinks(store);
  return store.links[key];
};

const getPaymentLinkStatus = ({ paymentLinkId, merchantAccountCode }) => {
  if (!paymentLinkId || !merchantAccountCode) {
    return {
      found: false,
      reason: 'paymentLinkId and merchantAccountCode are required.'
    };
  }

  const store = loadPaymentLinks();
  const key = buildPaymentLinkKey(paymentLinkId, merchantAccountCode);
  const found = store.links[key];
  if (!found) {
    return {
      found: false,
      reason: `Payment link ${paymentLinkId} not found for merchant ${merchantAccountCode}.`
    };
  }

  return {
    found: true,
    ...found,
    status: resolvePaymentLinkLifecycleStatus(found)
  };
};

const getReportFingerprint = (reportUrl) => {
  return crypto.createHash('sha256').update(String(reportUrl || '')).digest('hex');
};

const isLikelyFxReport = (report) => {
  const joined = [
    report?.type,
    report?.name,
    report?.description,
    report?.fileName,
    report?.url
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return joined.includes('fx');
};

const resolveFileExtension = (responseHeaders, reportUrl) => {
  const contentType = String(responseHeaders['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return '.json';
  }
  if (contentType.includes('text/csv') || contentType.includes('application/csv')) {
    return '.csv';
  }
  if (contentType.includes('application/zip')) {
    return '.zip';
  }

  const pathname = (() => {
    try {
      return new URL(reportUrl).pathname;
    } catch (_error) {
      return '';
    }
  })();

  const ext = path.extname(pathname);
  return ext || '.dat';
};

const resolveFileExtensionFromUrl = (reportUrl) => {
  const pathname = (() => {
    try {
      return new URL(reportUrl).pathname;
    } catch (_error) {
      return '';
    }
  })();

  const ext = path.extname(pathname);
  return ext || '.dat';
};

const toBooleanLiveFlag = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'true' || normalized === 'live') {
    return true;
  }

  return false;
};

const resolveReportApiKey = (metadata = {}) => {
  const isLive = toBooleanLiveFlag(metadata.isLive);
  if (metadata.reportApiKey) {
    return String(metadata.reportApiKey);
  }

  if (isLive) {
    return ADYEN_LIVE_REPORT_API_KEY
      || REPORT_SERVICE_USER_API_KEY_LIVE
      || REPORT_SERVICE_USER_API_KEY
      || REPORT_API_KEY;
  }

  return ADYEN_TEST_REPORT_API_KEY
    || REPORT_SERVICE_USER_API_KEY_TEST
    || REPORT_SERVICE_USER_API_KEY
    || REPORT_API_KEY;
};

const downloadReportFromUrl = async (reportUrl, metadata = {}) => {
  if (!reportUrl) {
    throw new Error('Missing reportUrl.');
  }

  ensureStorage();
  const reportApiKey = resolveReportApiKey(metadata);
  if (!reportApiKey) {
    throw new Error('Missing report API key. Set ADYEN_TEST_REPORT_API_KEY or ADYEN_LIVE_REPORT_API_KEY.');
  }

  const extension = resolveFileExtensionFromUrl(reportUrl);
  const fileName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const merchantReportsDir = getMerchantScopedDir(REPORTS_DIR, metadata.merchantAccountCode);
  fs.mkdirSync(merchantReportsDir, { recursive: true });
  const absolutePath = path.join(merchantReportsDir, fileName);

  console.log('[report-download] Starting Adyen report download.', {
    reportUrl,
    source: metadata.source || null,
    reportType: metadata.reportType || null,
    merchantAccountCode: metadata.merchantAccountCode || null,
    isLive: toBooleanLiveFlag(metadata.isLive)
  });

  // Use curl for report downloads to match Adyen report service expectations.
  try {
    execFileSync('curl', [
      '-L',
      '--compressed',
      '--fail',
      '-o', absolutePath,
      '--header', `X-API-KEY: ${reportApiKey}`,
      reportUrl
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const reason = stderr || 'curl download failed';
    console.error('[report-download] Failed to download Adyen report.', {
      reportUrl,
      source: metadata.source || null,
      reportType: metadata.reportType || null,
      merchantAccountCode: metadata.merchantAccountCode || null,
      reason
    });
    throw new Error(`Report download failed: ${reason}`);
  }

  const index = loadReportIndex();
  const fingerprint = getReportFingerprint(reportUrl);
  index.downloaded.push({
    fingerprint,
    reportUrl,
    fileName,
    absolutePath,
    downloadedAt: new Date().toISOString(),
    metadata
  });
  writeJsonFile(REPORT_INDEX_PATH, index);

  const bytes = fs.statSync(absolutePath).size;
  console.log('[report-download] Adyen report downloaded successfully.', {
    reportUrl,
    fileName,
    absolutePath,
    bytes,
    source: metadata.source || null,
    reportType: metadata.reportType || null,
    merchantAccountCode: metadata.merchantAccountCode || null
  });

  return {
    fileName,
    absolutePath,
    bytes
  };
};

const listDownloadedReports = () => {
  const index = loadReportIndex();
  return index.downloaded;
};

const hasDownloadedReport = (reportUrl) => {
  const fingerprint = getReportFingerprint(reportUrl);
  return listDownloadedReports().some((item) => item.fingerprint === fingerprint);
};

const queueWebhookEvent = (payload, headers = {}) => {
  ensureStorage();
  const item = extractNotificationRequestItem(payload) || {};
  const eventCode = String(item.eventCode || payload?.eventCode || 'UNKNOWN_EVENT').toUpperCase();
  const merchantAccountCode = String(item.merchantAccountCode || payload?.merchantAccountCode || 'UNKNOWN_MERCHANT').toUpperCase();
  const timestamp = Date.now();
  const webhookFileName = `${toSafeFileSegment(eventCode)}_${toSafeFileSegment(merchantAccountCode)}_${timestamp}.json`;
  const merchantWebhookDir = path.join(WEBHOOKS_DIR, toSafeFileSegment(merchantAccountCode));
  fs.mkdirSync(merchantWebhookDir, { recursive: true });
  const webhookFilePath = path.join(merchantWebhookDir, webhookFileName);
  const event = {
    id: crypto.randomUUID(),
    source: 'webhook',
    receivedAt: new Date().toISOString(),
    eventCode,
    merchantAccountCode,
    fileName: webhookFileName,
    filePath: webhookFilePath,
    headers,
    payload
  };

  writeJsonFile(webhookFilePath, event);
  appendNdjson(WEBHOOK_LOG_PATH, event);
  return event;
};

const processAuthorisationWebhook = async (payload) => {
  const item = extractNotificationRequestItem(payload) || {};
  const additionalData = item.additionalData || payload?.additionalData || {};
  const paymentLinkId = String(additionalData.paymentLinkId || payload?.paymentLinkId || '').trim();
  const merchantAccountCode = String(item.merchantAccountCode || payload?.merchantAccountCode || '').trim();

  if (!paymentLinkId || !merchantAccountCode) {
    return {
      handled: true,
      ignored: true,
      reason: 'Missing paymentLinkId or merchantAccountCode in AUTHORISATION webhook.'
    };
  }

  const updated = updatePaymentLinkStatusFromAuthorisation({
    paymentLinkId,
    merchantAccountCode,
    success: item.success || payload?.success,
    paymentMethod: item.paymentMethod || payload?.paymentMethod,
    pspReference: item.pspReference || payload?.pspReference,
    eventCode: item.eventCode || payload?.eventCode || 'AUTHORISATION'
  });

  if (!updated) {
    return {
      handled: true,
      ignored: true,
      eventCode: 'AUTHORISATION',
      paymentLinkId,
      merchantAccountCode,
      reason: 'No payment-link match found. Webhook ignored.'
    };
  }

  return {
    handled: true,
    eventCode: 'AUTHORISATION',
    paymentLinkId,
    merchantAccountCode,
    status: updated?.status || null,
    paymentMethod: updated?.paymentMethod || null,
    pspReference: updated?.pspReference || null
  };
};

const processGenericPaymentWebhook = async (payload) => {
  const item = extractNotificationRequestItem(payload) || {};
  const eventCode = String(item.eventCode || payload?.eventCode || 'UNKNOWN').toUpperCase();
  const merchantAccountCode = String(item.merchantAccountCode || payload?.merchantAccountCode || '').trim();
  const success = String(item.success || payload?.success || '').toLowerCase();

  return {
    handled: true,
    eventCode,
    merchantAccountCode,
    success,
    note: 'Payment event accepted and recorded.'
  };
};

const extractExchangeRateRowsFromCsv = (csvText, fileName = '') => {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 6) {
    return [];
  }

  // Per requirements: row 1-4 irrelevant, row 5 is header, row 6 onwards are data.
  const headers = parseCsvLine(lines[4]);
  const dataLines = lines.slice(5);

  const baseCurrencyIdx = detectColumnIndex(headers, [
    /base.*currency/,
    /source.*currency/,
    /from.*currency/
  ]);
  const targetCurrencyIdx = detectColumnIndex(headers, [
    /target.*currency/,
    /to.*currency/,
    /counter.*currency/
  ]);
  const exchangeRateIdx = detectColumnIndex(headers, [
    /exchange.*rate/,
    /fx.*rate/,
    /^rate$/
  ]);
  const platformSettlementIdx = detectColumnIndex(headers, [
    /exchange.*platform.*settlement/,
    /platform.*settlement/
  ]);
  const validFromIdx = detectColumnIndex(headers, [
    /valid.*from/,
    /effective.*from/,
    /timestamp/,
    /time/,
    /date/
  ]);

  if (baseCurrencyIdx === -1 || targetCurrencyIdx === -1 || exchangeRateIdx === -1 || validFromIdx === -1) {
    return [];
  }

  return dataLines
    .map((line) => parseCsvLine(line))
    .map((values) => {
      const baseCurrency = normalizeCurrency(values[baseCurrencyIdx]);
      const targetCurrency = normalizeCurrency(values[targetCurrencyIdx]);
      const exchangeRate = Number(values[exchangeRateIdx]);
      const exchangePlatformSettlement = Number(values[platformSettlementIdx]);
      const validFrom = values[validFromIdx] || null;

      if (!baseCurrency || !targetCurrency || !Number.isFinite(exchangeRate) || !validFrom) {
        return null;
      }

      return {
        baseCurrency,
        targetCurrency,
        exchangeRate,
        exchangePlatformSettlement: Number.isFinite(exchangePlatformSettlement) ? exchangePlatformSettlement : null,
        validFrom,
        sourceFile: fileName
      };
    })
    .filter(Boolean);
};

const resolveReportDateFromRows = (rows = [], fallbackDate = null) => {
  const byValidFrom = toIsoDate(rows[0]?.validFrom);
  if (byValidFrom) {
    return byValidFrom;
  }

  return fallbackDate || toIsoDate(Date.now());
};

const saveExchangeRatesSnapshot = (rows = [], metadata = {}) => {
  if (!rows.length) {
    return null;
  }

  ensureStorage();
  const dateOfReport = resolveReportDateFromRows(rows, metadata.dateOfReport);
  const fileName = `rates_${dateOfReport}.json`;
  const merchantRatesDir = getMerchantScopedDir(RATES_DIR, metadata.merchantAccountCode);
  fs.mkdirSync(merchantRatesDir, { recursive: true });
  const filePath = path.join(merchantRatesDir, fileName);
  const payload = {
    dateOfReport,
    generatedAt: new Date().toISOString(),
    source: metadata,
    count: rows.length,
    rates: rows
  };

  writeJsonFile(filePath, payload);

  return {
    fileName,
    filePath,
    dateOfReport,
    count: rows.length
  };
};

const processExchangeRateReport = async (reportUrl, context = {}) => {
  if (!reportUrl) {
    return {
      handled: false,
      reason: 'Missing reportUrl for exchange_rate_report.'
    };
  }

  const downloaded = await downloadReportFromUrl(reportUrl, {
    source: 'report-webhook-cron',
    reportType: 'exchange_rate_report',
    ...context
  });

  const csv = fs.readFileSync(downloaded.absolutePath, 'utf8');
  const rows = extractExchangeRateRowsFromCsv(csv, downloaded.fileName);
  const savedRates = saveExchangeRatesSnapshot(rows, {
    reportUrl,
    sourceFile: downloaded.fileName,
    ...context
  });

  // Remove raw downloaded report after it has been converted into rates data.
  if (fs.existsSync(downloaded.absolutePath)) {
    fs.unlinkSync(downloaded.absolutePath);
  }

  return {
    handled: true,
    reportType: 'exchange_rate_report',
    downloaded,
    rowsExtracted: rows.length,
    savedRates
  };
};

const processReportAvailableWebhook = async (payload, logger = console) => {
  const item = extractNotificationRequestItem(payload) || {};
  const pspReference = String(item.pspReference || payload?.pspReference || '').toLowerCase();
  const reportUrl = getWebhookReportUrl(payload, item);
  const isLive = toBooleanLiveFlag(payload?.live || item?.live);

  let reportType = 'unknown';
  if (pspReference.includes('exchange_rate_report')) {
    reportType = 'exchange_rate_report';
  }

  logger.log('[report-webhook-cron] Processing REPORT_AVAILABLE webhook.', {
    eventCode: item.eventCode || payload?.eventCode || 'REPORT_AVAILABLE',
    merchantAccountCode: item.merchantAccountCode || payload?.merchantAccountCode || null,
    pspReference: item.pspReference || payload?.pspReference || null,
    reportType,
    reportUrl,
    isLive
  });

  switch (reportType) {
    case 'exchange_rate_report':
      return processExchangeRateReport(reportUrl, {
        eventCode: item.eventCode || payload?.eventCode || null,
        merchantAccountCode: item.merchantAccountCode || payload?.merchantAccountCode || null,
        pspReference: item.pspReference || payload?.pspReference || null,
        isLive
      });
    default:
      logger.log('[report-webhook-cron] REPORT_AVAILABLE ignored because report type is not supported yet.');
      return {
        handled: false,
        reason: 'Unsupported report type for REPORT_AVAILABLE.',
        reportType,
        pspReference: item.pspReference || payload?.pspReference || null
      };
  }
};

const processWebhookEventFile = async (event, logger = console) => {
  const item = extractNotificationRequestItem(event?.payload) || {};
  const eventCode = String(item.eventCode || event?.eventCode || '').toUpperCase();

  switch (eventCode) {
    case 'REPORT_AVAILABLE':
      return processReportAvailableWebhook(event.payload, logger);
    case 'AUTHORISATION':
      return processAuthorisationWebhook(event.payload);
    case 'CAPTURE':
    case 'CAPTURE_FAILED':
    case 'REFUND':
    case 'REFUND_FAILED':
    case 'CANCELLATION':
    case 'CANCEL_OR_REFUND':
      return processGenericPaymentWebhook(event.payload);
    default:
      return {
        handled: false,
        reason: `Unsupported eventCode ${eventCode || 'UNKNOWN'}`
      };
  }
};

const listWebhookJsonFiles = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const children = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  children.forEach((child) => {
    const childPath = path.join(dirPath, child.name);
    if (child.isDirectory()) {
      files.push(...listWebhookJsonFiles(childPath));
      return;
    }

    if (child.isFile() && child.name.toLowerCase().endsWith('.json')) {
      files.push(childPath);
    }
  });

  return files;
};

const removeWebhookFileAfterProcessing = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  fs.unlinkSync(filePath);

  // Clean up now-empty merchant folders under Webhooks.
  const parentDir = path.dirname(filePath);
  if (parentDir !== WEBHOOKS_DIR && fs.existsSync(parentDir)) {
    const remaining = fs.readdirSync(parentDir);
    if (remaining.length === 0) {
      fs.rmdirSync(parentDir);
    }
  }
};

const runWebhookEventCron = async (logger = console, options = {}) => {
  ensureStorage();
  const processingIndex = loadWebhookProcessingIndex();
  let hasProcessingIndexChanges = false;
  const shouldReprocessFailed = Boolean(options.reprocessFailed);
  const specificFiles = Array.isArray(options.fileNames)
    ? new Set(options.fileNames)
    : null;
  const files = listWebhookJsonFiles(WEBHOOKS_DIR)
    .sort();

  const outcomes = [];

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const relativeFilePath = path.relative(WEBHOOKS_DIR, filePath);
    const looksLikeReportAvailableFile = fileName.toUpperCase().startsWith('REPORT_AVAILABLE_');

    if (specificFiles && !specificFiles.has(fileName) && !specificFiles.has(relativeFilePath)) {
      continue;
    }

    const existing = processingIndex.processed[relativeFilePath];
    const existingEventCode = String(existing?.eventCode || '').toUpperCase();
    const existingDownloadAttempted = Boolean(existing?.downloadAttempted);
    const shouldSkipBecauseReportAttempted = Boolean(
      existing && (existingDownloadAttempted || existingEventCode === 'REPORT_AVAILABLE' || looksLikeReportAvailableFile)
    );

    if (shouldSkipBecauseReportAttempted) {
      continue;
    }

    if (existing && !(shouldReprocessFailed && existing.handled === false)) {
      continue;
    }

    const event = readJsonFile(filePath, null);
    if (!event) {
      processingIndex.processed[relativeFilePath] = {
        processedAt: new Date().toISOString(),
        handled: false,
        reason: 'Invalid JSON payload.'
      };
      hasProcessingIndexChanges = true;
      outcomes.push({ fileName: relativeFilePath, handled: false, reason: 'Invalid JSON payload.' });
      removeWebhookFileAfterProcessing(filePath);
      continue;
    }

    const item = extractNotificationRequestItem(event?.payload) || {};
    const eventCode = String(item.eventCode || event?.eventCode || '').toUpperCase();
    const downloadAttempted = eventCode === 'REPORT_AVAILABLE';

    try {
      const result = await processWebhookEventFile(event, logger);
      processingIndex.processed[relativeFilePath] = {
        processedAt: new Date().toISOString(),
        eventCode,
        downloadAttempted,
        handled: Boolean(result?.handled),
        result
      };
      hasProcessingIndexChanges = true;
      outcomes.push({ fileName: relativeFilePath, ...result });

      // Delete webhook files once processed (success or handled=false known outcome).
      removeWebhookFileAfterProcessing(filePath);
    } catch (error) {
      processingIndex.processed[relativeFilePath] = {
        processedAt: new Date().toISOString(),
        eventCode,
        downloadAttempted,
        handled: false,
        reason: error.message
      };
      hasProcessingIndexChanges = true;
      outcomes.push({ fileName: relativeFilePath, handled: false, reason: error.message });
    }
  }

  if (hasProcessingIndexChanges) {
    saveWebhookProcessingIndex(processingIndex);
  }
  return outcomes;
};

const extractReportsFromPayload = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = [];
  if (payload.reportUrl) {
    candidates.push({ url: payload.reportUrl, ...payload });
  }

  if (payload.downloadUrl) {
    candidates.push({ url: payload.downloadUrl, ...payload });
  }

  if (Array.isArray(payload.reports)) {
    payload.reports.forEach((report) => {
      if (report && (report.url || report.reportUrl || report.downloadUrl)) {
        candidates.push({
          ...report,
          url: report.url || report.reportUrl || report.downloadUrl
        });
      }
    });
  }

  if (Array.isArray(payload.data)) {
    payload.data.forEach((report) => {
      if (report && (report.url || report.reportUrl || report.downloadUrl)) {
        candidates.push({
          ...report,
          url: report.url || report.reportUrl || report.downloadUrl
        });
      }
    });
  }

  return candidates.filter((item) => item.url);
};

const normalizePolledReports = (data) => {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.data)) {
    return data.data;
  }
  if (data && Array.isArray(data.reports)) {
    return data.reports;
  }
  return [];
};

const fetchReportsFromPollEndpoint = async () => {
  if (!REPORT_POLL_ENDPOINT) {
    return [];
  }

  const response = await axios.get(REPORT_POLL_ENDPOINT, {
    headers: buildAuthHeaders(),
    timeout: 120000
  });

  return normalizePolledReports(response.data).map((entry) => ({
    ...entry,
    url: entry.url || entry.reportUrl || entry.downloadUrl
  })).filter((entry) => entry.url);
};

const rebuildFxTable = () => {
  ensureStorage();
  const downloadedReports = listDownloadedReports();
  const fxRows = [];

  downloadedReports.forEach((report) => {
    if (!report.absolutePath || !fs.existsSync(report.absolutePath)) {
      return;
    }

    if (!String(report.fileName || '').toLowerCase().endsWith('.csv')) {
      return;
    }

    const csv = fs.readFileSync(report.absolutePath, 'utf8');
    const extractedRows = extractFxRowsFromCsv(csv, report.fileName);
    fxRows.push(...extractedRows);
  });

  const table = {};
  fxRows.forEach((row) => {
    const key = `${row.sourceCurrency}_${row.targetCurrency}`;
    const previous = table[key];
    const currentTimestamp = row.effectiveAt ? Date.parse(row.effectiveAt) : NaN;
    const previousTimestamp = previous?.effectiveAt ? Date.parse(previous.effectiveAt) : NaN;
    const shouldReplace = !previous
      || (Number.isFinite(currentTimestamp) && !Number.isFinite(previousTimestamp))
      || (Number.isFinite(currentTimestamp) && Number.isFinite(previousTimestamp) && currentTimestamp >= previousTimestamp);

    if (shouldReplace) {
      table[key] = {
        sourceCurrency: row.sourceCurrency,
        targetCurrency: row.targetCurrency,
        rate: row.rate,
        effectiveAt: row.effectiveAt,
        sourceFile: row.fileName
      };
    }
  });

  const snapshot = {
    updatedAt: new Date().toISOString(),
    pairCount: Object.keys(table).length,
    pairs: table
  };
  writeJsonFile(FX_TABLE_PATH, snapshot);
  return snapshot;
};

const processCandidateReports = async (candidateReports = [], source = 'poll') => {
  const downloaded = [];
  for (const report of candidateReports) {
    if (!report?.url || !isLikelyFxReport(report)) {
      continue;
    }

    if (hasDownloadedReport(report.url)) {
      continue;
    }

    const downloadResult = await downloadReportFromUrl(report.url, {
      source,
      reportType: report.type || report.reportType || null,
      reportName: report.name || report.fileName || null
    });

    downloaded.push({
      url: report.url,
      fileName: downloadResult.fileName
    });
  }

  if (downloaded.length > 0) {
    rebuildFxTable();
  }

  return downloaded;
};

const checkForNewFxReports = async () => {
  const candidates = await fetchReportsFromPollEndpoint();
  return processCandidateReports(candidates, 'poll');
};

const handleWebhookPayload = async (payload, headers = {}) => {
  const event = queueWebhookEvent(payload, headers);
  if (event.eventCode === 'REPORT_AVAILABLE') {
    console.log('[report-webhook] REPORT_AVAILABLE webhook received.', {
      eventId: event.id,
      fileName: event.fileName,
      merchantAccountCode: event.merchantAccountCode,
      receivedAt: event.receivedAt
    });
  }

  return {
    eventId: event.id,
    queued: true,
    fileName: event.fileName,
    eventCode: event.eventCode,
    merchantAccountCode: event.merchantAccountCode
  };
};

const getRatesByDateAndCurrencyPair = ({ date, baseCurrency, targetCurrency, merchantAccountCode }) => {
  ensureStorage();

  const normalizedDate = toIsoDate(date) || getDefaultRatesDate();
  const normalizedBase = normalizeCurrency(baseCurrency);
  const normalizedTarget = normalizeCurrency(targetCurrency);
  const fileName = `rates_${normalizedDate}.json`;
  const legacyFilePath = path.join(RATES_DIR, fileName);
  let resolvedDateOfReport = normalizedDate;

  let filePath = legacyFilePath;
  if (merchantAccountCode) {
    const merchantFilePath = path.join(getMerchantScopedDir(RATES_DIR, merchantAccountCode), fileName);
    filePath = fs.existsSync(merchantFilePath) ? merchantFilePath : legacyFilePath;
  } else {
    const merchantDirs = fs.readdirSync(RATES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const firstMatch = merchantDirs
      .map((dirName) => path.join(RATES_DIR, dirName, fileName))
      .find((candidate) => fs.existsSync(candidate));

    if (firstMatch) {
      filePath = firstMatch;
    }
  }

  if (!fs.existsSync(filePath)) {
    const fallback = findLatestRatesFileOnOrBeforeDate({
      requestedDate: normalizedDate,
      merchantAccountCode
    });

    if (fallback) {
      filePath = fallback.filePath;
      resolvedDateOfReport = fallback.dateOfReport;
    }
  }

  if (!fs.existsSync(filePath)) {
    return {
      found: false,
      dateOfReport: resolvedDateOfReport,
      reason: `Rates file not found for ${normalizedDate}.`
    };
  }

  const content = readJsonFile(filePath, null);
  if (!content || !Array.isArray(content.rates)) {
    return {
      found: false,
      dateOfReport: resolvedDateOfReport,
      reason: `Rates file for ${resolvedDateOfReport} is invalid.`
    };
  }

  const matchingRows = content.rates.filter((item) => {
    return normalizeCurrency(item.baseCurrency) === normalizedBase
      && normalizeCurrency(item.targetCurrency) === normalizedTarget;
  });

  const latest = pickLatestByValidFrom(matchingRows);
  if (!latest) {
    return {
      found: false,
      dateOfReport: resolvedDateOfReport,
      reason: `No rate found for ${normalizedBase} to ${normalizedTarget}.`
    };
  }

  return {
    found: true,
    dateOfReport: resolvedDateOfReport,
    baseCurrency: latest.baseCurrency,
    targetCurrency: latest.targetCurrency,
    exchangeRate: latest.exchangeRate,
    exchangePlatformSettlement: latest.exchangePlatformSettlement,
    validFrom: latest.validFrom
  };
};

const getFxTableSnapshot = () => {
  return readJsonFile(FX_TABLE_PATH, {
    updatedAt: null,
    pairCount: 0,
    pairs: {}
  });
};

const startReportWebhookCron = (logger = console) => {
  ensureStorage();

  if (timerRef) {
    return;
  }

  const run = async () => {
    try {
      const outcomes = await runWebhookEventCron(logger);
      if (outcomes.length > 0) {
        logger.log(`[report-webhook-cron] Processed ${outcomes.length} queued webhook event(s).`);
      }
    } catch (error) {
      logger.error('[report-webhook-cron] Failed:', error.message);
    }
  };

  timerRef = setInterval(run, WEBHOOK_CRON_INTERVAL_MS || TWO_HOURS_MS);
  run();
};

const startSunwayFxCron = startReportWebhookCron;

const reprocessQueuedWebhooks = async (logger = console, options = {}) => {
  return runWebhookEventCron(logger, {
    ...options,
    reprocessFailed: true
  });
};

module.exports = {
  startReportWebhookCron,
  startSunwayFxCron,
  reprocessQueuedWebhooks,
  registerPaymentLink,
  getPaymentLinkStatus,
  listPaymentLinks,
  getPaymentLinkSummary,
  getFxRateHistory,
  handleWebhookPayload,
  checkForNewFxReports,
  downloadReportFromUrl,
  rebuildFxTable,
  getFxTableSnapshot,
  getRatesByDateAndCurrencyPair
};