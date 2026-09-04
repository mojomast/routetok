const FIELDBOOK_BACKUP_DB_NAME = "routetok-model-fieldbook";
const FIELDBOOK_BACKUP_DB_VERSION = 1;
const FIELDBOOK_BACKUP_STORE = "records";
const FIELDBOOK_BACKUP_FORMAT = "routetok-fieldbook";
const FIELDBOOK_BACKUP_VERSION = 1;
const FIELDBOOK_BACKUP_MAX_RECORDS = 200;
const FIELDBOOK_BACKUP_LAST_MERGE_KEY = "routetok-fieldbook-backup-last-merge-v1";
const FIELDBOOK_BACKUP_ORIGIN_KEY = "routetok-fieldbook-backup-origin-v1";
const FIELDBOOK_BACKUP_TOKEN_KEYS = ["token", "dashboardToken", "dashboard-token", "x-dashboard-token", "proxyApiKey", "apiSecret"];
const FIELDBOOK_BACKUP_EPHEMERAL_KEYS = ["dataUrl", "studioAssets", "studioImages", "comparisonMedia", "imageUrls", "objectUrl", "blobBytes", "previewBytes", "mediaBytes", "ephemeralMedia"];

function backupClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function backupCleanValue(value) {
  if (Array.isArray(value)) return value.map(backupCleanValue);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FIELDBOOK_BACKUP_TOKEN_KEYS.includes(key)) continue;
      if (FIELDBOOK_BACKUP_EPHEMERAL_KEYS.includes(key)) continue;
      output[key] = backupCleanValue(entry);
    }
    return output;
  }
  return value;
}

function sanitizeRecord(record) {
  const copy = { ...record };
  for (const key of [...FIELDBOOK_BACKUP_TOKEN_KEYS, ...FIELDBOOK_BACKUP_EPHEMERAL_KEYS]) {
    if (key in copy) delete copy[key];
  }
  return backupCleanValue(copy);
}

function exportBundle(source) {
  const input = source && typeof source === "object" ? source : {};
  const conversations = Array.isArray(input.conversations) ? input.conversations.map(sanitizeRecord) : [];
  const evalSuites = Array.isArray(input.evalSuites) ? input.evalSuites.map(sanitizeRecord) : [];
  const evalRuns = Array.isArray(input.evalRuns) ? input.evalRuns.map(sanitizeRecord) : [];
  return {
    format: FIELDBOOK_BACKUP_FORMAT,
    version: FIELDBOOK_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    exportedOrigin: typeof location === "object" && location ? String(location.origin) : "",
    conversations,
    evalSuites,
    evalRuns
  };
}

function revisionOf(record) {
  if (!record || typeof record !== "object") return "";
  if (typeof record.revision === "number" || typeof record.revision === "string") return String(record.revision);
  const scratchpad = record.scratchpad;
  if (scratchpad && typeof scratchpad === "object" && (typeof scratchpad.revision === "number" || typeof scratchpad.revision === "string")) {
    return String(scratchpad.revision);
  }
  const studio = record.studio;
  if (studio && typeof studio === "object" && (typeof studio.revision === "number" || typeof studio.revision === "string")) {
    return String(studio.revision);
  }
  if (typeof record.updatedAt === "string" || typeof record.updatedAt === "number") return String(record.updatedAt);
  return "";
}

function isDuplicate(existing, incoming) {
  if (!existing || !incoming || typeof existing !== "object" || typeof incoming !== "object") return false;
  if (typeof existing.id !== "string" || typeof incoming.id !== "string") return false;
  return existing.id === incoming.id && revisionOf(existing) === revisionOf(incoming);
}

function validateBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== "object") return ["Bundle is not an object"];
  if (bundle.format !== FIELDBOOK_BACKUP_FORMAT) errors.push("Unsupported bundle format");
  if (bundle.version !== FIELDBOOK_BACKUP_VERSION) errors.push("Unsupported bundle version");
  for (const key of ["conversations", "evalSuites", "evalRuns"]) {
    if (!Array.isArray(bundle[key])) errors.push("Bundle collection invalid: " + key);
  }
  return errors;
}

function openFieldbookDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FIELDBOOK_BACKUP_DB_NAME, FIELDBOOK_BACKUP_DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(FIELDBOOK_BACKUP_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readAllRecords() {
  return openFieldbookDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(FIELDBOOK_BACKUP_STORE).objectStore(FIELDBOOK_BACKUP_STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      })
  );
}

function writeRecords(records) {
  if (!records.length) return Promise.resolve();
  return openFieldbookDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(FIELDBOOK_BACKUP_STORE, "readwrite");
        const store = transaction.objectStore(FIELDBOOK_BACKUP_STORE);
        records.forEach((record) => store.put(record));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

function rememberMergeOrigin() {
  try {
    localStorage.setItem(FIELDBOOK_BACKUP_LAST_MERGE_KEY, new Date().toISOString());
    if (typeof location === "object" && location) {
      localStorage.setItem(FIELDBOOK_BACKUP_ORIGIN_KEY, String(location.origin));
    }
  } catch {
    return;
  }
}

async function mergeBundle(bundle, options) {
  const hooks = options && typeof options === "object" ? options : {};
  const shapeErrors = validateBundle(bundle);
  if (shapeErrors.length) return { added: 0, skipped: 0, errors: shapeErrors };
  const incoming = [...bundle.conversations, ...bundle.evalSuites, ...bundle.evalRuns];
  if (incoming.length > FIELDBOOK_BACKUP_MAX_RECORDS) {
    return { added: 0, skipped: 0, errors: ["Bundle contains too many records"] };
  }
  let existing = Array.isArray(hooks.existing) ? hooks.existing : null;
  if (!existing) {
    try {
      existing = await readAllRecords();
    } catch (error) {
      return { added: 0, skipped: 0, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }
  const known = new Map();
  existing.forEach((record) => {
    if (record && typeof record.id === "string") known.set(record.id, record);
  });
  let added = 0;
  let skipped = 0;
  const errors = [];
  const pending = [];
  for (const record of incoming) {
    if (!record || typeof record !== "object" || typeof record.id !== "string") {
      errors.push("Skipped a malformed record without an id");
      continue;
    }
    const prior = known.get(record.id) || null;
    if (prior && isDuplicate(prior, record)) {
      skipped += 1;
      continue;
    }
    const preserved = { ...backupClone(record) };
    pending.push(preserved);
    known.set(record.id, preserved);
    added += 1;
  }
  if (pending.length) {
    try {
      if (typeof hooks.putAll === "function") await hooks.putAll(pending);
      else if (typeof hooks.put === "function") {
        for (const record of pending) await hooks.put(record);
      } else await writeRecords(pending);
    } catch (error) {
      return { added: 0, skipped, errors: [...errors, error instanceof Error ? error.message : String(error)] };
    }
  }
  rememberMergeOrigin();
  return { added, skipped, errors };
}

async function estimateQuota() {
  const storage = typeof navigator === "object" && navigator ? navigator.storage : null;
  if (!storage || typeof storage.estimate !== "function") {
    return { quota: null, usage: null, available: null, percent: null, supported: false };
  }
  const estimate = await storage.estimate();
  const quota = Number(estimate.quota) || 0;
  const usage = Number(estimate.usage) || 0;
  return {
    quota,
    usage,
    available: Math.max(quota - usage, 0),
    percent: quota > 0 ? (usage / quota) * 100 : 0,
    supported: true
  };
}

function originWarningText(info) {
  const detail = info && typeof info === "object" ? info : {};
  const storedOrigin = typeof detail.storedOrigin === "string" && detail.storedOrigin ? detail.storedOrigin : "another origin";
  const currentOrigin = typeof detail.currentOrigin === "string" && detail.currentOrigin ? detail.currentOrigin : "this origin";
  const count = Number(detail.noteCount) || 0;
  const notes = count === 1 ? "1 note" : count + " notes";
  return (
    "Fieldbook notes live in this origin and browser profile only, inside the " +
    FIELDBOOK_BACKUP_DB_NAME +
    " IndexedDB database. This backup holds " +
    notes +
    " from " +
    storedOrigin +
    ", but you are on " +
    currentOrigin +
    ". A different hostname, port, or browser profile keeps separate notes, so import this bundle where you want the notes to live. See docs/troubleshooting.md#fieldbook-state-looks-stale before clearing site storage."
  );
}

window.FieldbookBackup = {
  DB_NAME: FIELDBOOK_BACKUP_DB_NAME,
  BUNDLE_FORMAT: FIELDBOOK_BACKUP_FORMAT,
  BUNDLE_VERSION: FIELDBOOK_BACKUP_VERSION,
  LAST_MERGE_KEY: FIELDBOOK_BACKUP_LAST_MERGE_KEY,
  ORIGIN_KEY: FIELDBOOK_BACKUP_ORIGIN_KEY,
  sanitizeRecord,
  exportBundle,
  revisionOf,
  isDuplicate,
  validateBundle,
  mergeBundle,
  estimateQuota,
  originWarningText
};
