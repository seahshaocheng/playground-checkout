const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const STORAGE_ROOT = process.env.SUNWAY_REPORT_STORAGE_DIR
  ? path.resolve(process.env.SUNWAY_REPORT_STORAGE_DIR)
  : path.join(__dirname, '..', 'data', 'sunway-reports');

const REPORTS_DIR = path.join(STORAGE_ROOT, 'reports');
const WEBHOOK_LOG_PATH = path.join(STORAGE_ROOT, 'webhook-events.ndjson');
const REPORT_INDEX_PATH = path.join(STORAGE_ROOT, 'report-index.json');
const FX_TABLE_PATH = path.join(STORAGE_ROOT, 'fx-table.json');

const REPORT_POLL_ENDPOINT = process.env.SUNWAY_FX_REPORT_POLL_ENDPOINT || '';
const REPORT_USER = process.env.SUNWAY_REPORT_USER || '';
const REPORT_PASSWORD = process.env.SUNWAY_REPORT_PASSWORD || '';
const REPORT_API_KEY = process.env.SUNWAY_REPORT_API_KEY || '';

let timerRef = null;

const ensureStorage = () => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
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

const downloadReportFromUrl = async (reportUrl, metadata = {}) => {
  if (!reportUrl) {
    throw new Error('Missing reportUrl.');
  }

  ensureStorage();
  const response = await axios.get(reportUrl, {
    responseType: 'arraybuffer',
    headers: buildAuthHeaders(),
    timeout: 120000
  });

  const extension = resolveFileExtension(response.headers || {}, reportUrl);
  const fileName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const absolutePath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(absolutePath, response.data);

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

  return {
    fileName,
    absolutePath,
    bytes: Buffer.byteLength(response.data)
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
  const event = {
    id: crypto.randomUUID(),
    source: 'webhook',
    receivedAt: new Date().toISOString(),
    headers,
    payload
  };
  appendNdjson(WEBHOOK_LOG_PATH, event);
  return event;
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
  const candidates = extractReportsFromPayload(payload);
  const downloaded = await processCandidateReports(candidates, 'webhook');
  return {
    eventId: event.id,
    candidateCount: candidates.length,
    downloadedCount: downloaded.length,
    downloaded
  };
};

const getFxTableSnapshot = () => {
  return readJsonFile(FX_TABLE_PATH, {
    updatedAt: null,
    pairCount: 0,
    pairs: {}
  });
};

const startSunwayFxCron = (logger = console) => {
  ensureStorage();

  if (timerRef) {
    return;
  }

  const run = async () => {
    try {
      const downloaded = await checkForNewFxReports();
      if (downloaded.length > 0) {
        logger.log(`[sunway-fx-cron] Downloaded ${downloaded.length} new FX report(s).`);
      } else {
        logger.log('[sunway-fx-cron] No new FX reports found.');
      }
    } catch (error) {
      logger.error('[sunway-fx-cron] Failed:', error.message);
    }
  };

  timerRef = setInterval(run, TWO_HOURS_MS);
  run();
};

module.exports = {
  startSunwayFxCron,
  handleWebhookPayload,
  checkForNewFxReports,
  downloadReportFromUrl,
  rebuildFxTable,
  getFxTableSnapshot
};