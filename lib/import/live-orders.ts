import { createHash } from "node:crypto";

import ExcelJS from "exceljs";

import { STOCK_CATEGORIES, type StockCategory } from "@/lib/constants/stock";

export function inferStockCategory(name: string): StockCategory {
  const lower = name.toLowerCase();
  for (const cat of STOCK_CATEGORIES) {
    if (cat === "Others") continue;
    if (lower.includes(cat.toLowerCase())) {
      return cat;
    }
  }
  return "Others";
}

export type DetectedNewProduct = {
  sku: string;
  name: string;
  category: StockCategory;
  price: number;
  initialQuantity: number;
  valid: boolean;
  validationError?: string;
};

export const LIVE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const LIVE_IMPORT_MAX_ROWS = 2000;

export const LIVE_IMPORT_HEADERS = [
  "FB Name",
  "Item Code",
  "Item Name",
  "Quantity",
  "Price",
  "Downpayment",
] as const;

const REMOVED_HEADERS = new Set([
  "customer name",
  "fb / cs name",
  "fb/cs name",
  "facebook / cs name",
  "facebook name",
  "live batch",
  "discount",
  "notes",
]);

export type LiveImportRow = {
  rowNumber: number;
  facebookName: string;
  itemCode: string;
  itemName: string;
  quantity: string;
  price: string;
  downpayment: string;
};

export type ImportCustomerCandidate = {
  id: string;
  name: string;
  facebook_name: string | null;
  created_at: string | null;
};

export type ImportStockCandidate = {
  id: string;
  sku: string;
  name: string;
  price: number;
  category?: string;
};

// Import is permissive by design: formatting differences never block a row.
// "Ready" marks a row whose customer already exists; "New Customer" marks one
// that will be created automatically. Only genuinely unresolvable rows
// (unknown Item Code, unusable quantity/price/downpayment text, missing FB
// name) stay rejected.
export type LiveImportResult =
  | "Ready"
  | "New Customer"
  | "New Product"
  | "Invalid Price"
  | "Invalid Downpayment"
  | "Invalid Quantity"
  | "Item Not Found"
  | "Item Ambiguous"
  | "Invalid Customer";

export type LiveImportPreviewRow = LiveImportRow & {
  catalogItemName: string | null;
  customerMatch: "Matched" | "New Customer" | "Invalid Customer";
  itemMatch:
    | "Matched"
    | "New Product"
    | "Item Not Found"
    | "Item Ambiguous";
  result: LiveImportResult;
  valid: boolean;
  existingCustomer: boolean;
  mergedQuantity: number;
  mergedFromRows: number;
  // Canonical numeric amounts after flexible money normalization; null when
  // the raw cell was blank or invalid.
  unitPrice: number | null;
  downpaymentTotal: number | null;
  category?: StockCategory;
};

export type LiveImportPreview = {
  fileName: string;
  fileHash: string;
  rows: LiveImportPreviewRow[];
  detectedNewProducts: DetectedNewProduct[];
  summary: {
    rowsUploaded: number;
    validRows: number;
    invalidRows: number;
    existingCustomers: number;
    newCustomers: number;
    newProducts: number;
    reservationsToCreate: number;
    itemsToCreate: number;
  };
};

type ParsedFile = {
  fileName: string;
  fileHash: string;
  rows: LiveImportRow[];
};

const HEADER_KEYS: Record<string, keyof Omit<LiveImportRow, "rowNumber">> = {
  "fb name": "facebookName",
  "item code": "itemCode",
  "item name": "itemName",
  quantity: "quantity",
  price: "price",
  downpayment: "downpayment",
};

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeLiveIdentity(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en");
}

export function normalizeItemCode(value: string): string {
  return normalizeWhitespace(value).toLocaleUpperCase("en");
}

const NUMERIC_CODE_PATTERN = /^\d+$/;

export function stripLeadingZeros(value: string): string {
  return value.replace(/^0+/, "");
}

function matchStockByCode(
  itemCode: string,
  stockByCode: Map<string, ImportStockCandidate[]>,
  stockByDigits: Map<string, ImportStockCandidate[]>,
): ImportStockCandidate[] {
  const exactKey = normalizeItemCode(itemCode);
  const exactMatches = stockByCode.get(exactKey);
  if (exactMatches?.length) return exactMatches;
  // Leading-zero compatibility for numeric-only codes only. Spreadsheet apps
  // strip leading zeros when a code is stored as a number (001879 -> 1879).
  // Alphanumeric SKUs never use this fallback.
  if (!NUMERIC_CODE_PATTERN.test(exactKey)) return [];
  return stockByDigits.get(stripLeadingZeros(exactKey)) ?? [];
}

const AMOUNT_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;
// Real-world Facebook Live Selling sheets write money as "2,100",
// "2,100.00", or "₱2,100". Commas are accepted ONLY as strict three-digit
// thousand groups so the digits and the decimal point are never mangled:
// "2,100" -> "2100" and "1,200.50" -> "1200.50", while "1,20" and "2,1x0"
// stay invalid instead of silently collapsing into a different amount.
const GROUPED_AMOUNT_PATTERN =
  /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
const PESO_SYMBOL_PATTERN = /₱/gu;
const QUANTITY_PATTERN = /^\d{1,9}$/;
export const DEFAULT_IMPORT_QUANTITY = 1;

export function parseLiveMoney(value: string): string | null {
  const text = normalizeWhitespace(value.replace(PESO_SYMBOL_PATTERN, " "));
  if (!GROUPED_AMOUNT_PATTERN.test(text)) return null;
  const compact = text.replace(/,/g, "");
  return AMOUNT_PATTERN.test(compact) ? compact : null;
}

export function isValidLiveImportAmount(value: string): boolean {
  return parseLiveMoney(value) !== null;
}

// Canonical numeric price key (two decimal places) so "1100", "1100.00", and
// catalog-price fallbacks compare identically, mirroring the numeric(12,2)
// reservation_items.unit_price column used by the confirmation RPC.
export function normalizeImportPriceKey(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed.toFixed(2);
}

// Blank defaults to one; otherwise a positive whole number only. Zero,
// negatives, and decimals are rejected so the value always casts cleanly to a
// positive integer inside the confirmation RPC.
export function resolveImportQuantity(value: string): number | null {
  if (normalizeWhitespace(value) === "") return DEFAULT_IMPORT_QUANTITY;
  if (!QUANTITY_PATTERN.test(normalizeWhitespace(value))) return null;
  const parsed = Number.parseInt(normalizeWhitespace(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function normalizeHeader(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en");
}

function blankRow(rowNumber: number): LiveImportRow {
  return {
    rowNumber,
    facebookName: "",
    itemCode: "",
    itemName: "",
    quantity: "",
    price: "",
    downpayment: "",
  };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (character !== "\r") {
      value += character;
    }
  }

  if (quoted) throw new Error("The CSV file contains an unterminated quoted value.");
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function rowsFromMatrix(matrix: string[][]): LiveImportRow[] {
  if (!matrix.length) throw new Error("The spreadsheet is empty.");

  const normalizedHeaders = matrix[0].map(normalizeHeader);
  const removed = normalizedHeaders.filter((header) => REMOVED_HEADERS.has(header));
  if (removed.length) {
    throw new Error(
      "This template is outdated. Download the latest Live Selling template and try again.",
    );
  }

  const headerIndexes = new Map<number, keyof Omit<LiveImportRow, "rowNumber">>();
  const recognized = new Set<string>();
  matrix[0].forEach((value, index) => {
    const key = HEADER_KEYS[normalizeHeader(value)];
    if (key && !recognized.has(key)) {
      headerIndexes.set(index, key);
      recognized.add(key);
    }
  });

  if (
    !recognized.has("facebookName") ||
    !recognized.has("itemCode")
  ) {
    throw new Error(
      'Missing required headers. Include "FB Name" and "Item Code".',
    );
  }

  const rows = matrix.slice(1).flatMap((values, index) => {
    const parsed = blankRow(index + 2);
    headerIndexes.forEach((key, column) => {
      parsed[key] = normalizeWhitespace(values[column] ?? "");
    });
    const hasValue = Object.entries(parsed).some(
      ([key, value]) => key !== "rowNumber" && value !== "",
    );
    return hasValue ? [parsed] : [];
  });

  if (!rows.length) throw new Error("The spreadsheet does not contain any order rows.");
  if (rows.length > LIVE_IMPORT_MAX_ROWS) {
    throw new Error("The spreadsheet exceeds the " + LIVE_IMPORT_MAX_ROWS + " row limit.");
  }
  return rows;
}

function excelCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if ("formula" in value || "sharedFormula" in value) {
    throw new Error("Spreadsheet formulas are not allowed in import files.");
  }
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return String(value.text);
  if ("error" in value) throw new Error("The spreadsheet contains an error cell.");
  return String(value);
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The workbook does not contain a worksheet.");

  const matrix: string[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values: string[] = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      values.push(excelCellText(row.getCell(column).value));
    }
    matrix.push(values);
  });
  return matrix;
}

export async function parseLiveOrderBuffer(
  buffer: Buffer,
  fileName: string,
): Promise<ParsedFile> {
  if (!buffer.length) throw new Error("Choose a non-empty import file.");
  if (buffer.length > LIVE_IMPORT_MAX_BYTES) {
    throw new Error("The import file must be 5 MB or smaller.");
  }

  const safeName = fileName.trim().slice(0, 255) || "live-orders";
  const extension = safeName.split(".").pop()?.toLocaleLowerCase("en");
  const matrix =
    extension === "csv"
      ? parseCsv(buffer.toString("utf8").replace(/^\uFEFF/, ""))
      : extension === "xlsx"
        ? await parseXlsx(buffer)
        : null;
  if (!matrix) throw new Error("Only .csv and .xlsx files are supported.");

  return {
    fileName: safeName,
    fileHash: createHash("sha256").update(buffer).digest("hex"),
    rows: rowsFromMatrix(matrix),
  };
}

function groupKey(row: LiveImportRow): string {
  return normalizeLiveIdentity(row.facebookName);
}

export function buildLiveOrderPreview({
  parsed,
  customers,
  stockItems,
}: {
  parsed: ParsedFile;
  customers: ImportCustomerCandidate[];
  stockItems: ImportStockCandidate[];
}): LiveImportPreview {
  const customersByIdentity = new Map<string, ImportCustomerCandidate[]>();
  const stockByCode = new Map<string, ImportStockCandidate[]>();
  const stockByDigits = new Map<string, ImportStockCandidate[]>();

  for (const customer of customers) {
    const key = normalizeLiveIdentity(customer.facebook_name ?? "");
    if (key) customersByIdentity.set(key, [...(customersByIdentity.get(key) ?? []), customer]);
  }
  for (const stock of stockItems) {
    const key = normalizeItemCode(stock.sku);
    stockByCode.set(key, [...(stockByCode.get(key) ?? []), stock]);
    if (NUMERIC_CODE_PATTERN.test(key)) {
      const digits = stripLeadingZeros(key);
      stockByDigits.set(digits, [...(stockByDigits.get(digits) ?? []), stock]);
    }
  }

  // Pass 1: resolve every physical row independently. Rows that are fully
  // well-formed (single stock match, valid price/downpayment formats, valid
  // quantity) are merge candidates keyed by CUSTOMER + STOCK ITEM + SELLING
  // PRICE. Anything malformed stays standalone so its own error stays visible
  // and cannot poison a merged line.
  type ResolvedPart = {
    row: LiveImportRow;
    identity: string;
    customerMatches: ImportCustomerCandidate[];
    stockMatches: ImportStockCandidate[];
    stock: ImportStockCandidate | undefined;
    effectivePriceKey: string | null;
    parsedPrice: string | null;
    priceInvalid: boolean;
    parsedDownpayment: string | null;
    downpaymentInvalid: boolean;
    quantity: number | null;
  };
  type AggregatedLine = {
    parts: ResolvedPart[];
    mergeKey: string | null;
  };

  const resolvedParts = parsed.rows.map<ResolvedPart>((row) => {
    const normalizedRow: LiveImportRow = {
      ...row,
      facebookName: normalizeWhitespace(row.facebookName),
      itemCode: normalizeWhitespace(row.itemCode),
      itemName: normalizeWhitespace(row.itemName),
      quantity: normalizeWhitespace(row.quantity),
      price: normalizeWhitespace(row.price),
      downpayment: normalizeWhitespace(row.downpayment),
    };
    const identity = normalizeLiveIdentity(normalizedRow.facebookName);
    const customerMatches = customersByIdentity.get(identity) ?? [];
    const stockMatches = matchStockByCode(normalizedRow.itemCode, stockByCode, stockByDigits);
    const stock = stockMatches[0];
    // Flexible money normalization happens BEFORE any comparison so "2,100",
    // "2100.00", and "₱ 2,100" resolve to the same selling price everywhere:
    // validity checks, merge keys, and the duplicate guard.
    const parsedPrice =
      normalizedRow.price !== "" ? parseLiveMoney(normalizedRow.price) : null;
    const parsedDownpayment =
      normalizedRow.downpayment !== ""
        ? parseLiveMoney(normalizedRow.downpayment)
        : null;
    const effectivePriceKey =
      parsedPrice !== null
        ? normalizeImportPriceKey(parsedPrice)
        : stock
          ? normalizeImportPriceKey(stock.price)
          : null;
    return {
      row: normalizedRow,
      identity,
      customerMatches,
      stockMatches,
      stock,
      effectivePriceKey,
      parsedPrice,
      priceInvalid: normalizedRow.price !== "" && parsedPrice === null,
      parsedDownpayment,
      downpaymentInvalid:
        normalizedRow.downpayment !== "" && parsedDownpayment === null,
      quantity: resolveImportQuantity(normalizedRow.quantity),
    };
  });

  const lines: AggregatedLine[] = [];
  const lineIndexByMergeKey = new Map<string, number>();
  parsed.rows.forEach((_, index) => {
    const part = resolvedParts[index];
    const resolvedStock =
      part.stockMatches.length === 1 ? part.stockMatches[0] : undefined;
    const isNewProductCandidate =
      part.stockMatches.length === 0 &&
      Boolean(part.row.itemCode) &&
      part.row.itemName.trim().length >= 2;
    const canMerge =
      (resolvedStock !== undefined || isNewProductCandidate) &&
      part.effectivePriceKey !== null &&
      !part.priceInvalid &&
      !part.downpaymentInvalid &&
      part.quantity !== null;
    if (!canMerge) {
      lines.push({ parts: [part], mergeKey: null });
      return;
    }
    const stockIdentifier = resolvedStock
      ? resolvedStock.id
      : "new:" + normalizeItemCode(part.row.itemCode);
    const mergeKey =
      groupKey(part.row) + "|" + stockIdentifier + "|" + part.effectivePriceKey;
    const existingIndex = lineIndexByMergeKey.get(mergeKey);
    if (existingIndex === undefined) {
      lineIndexByMergeKey.set(mergeKey, lines.length);
      lines.push({ parts: [part], mergeKey });
      return;
    }
    lines[existingIndex].parts.push(part);
  });

  // Pass 2: turn each aggregated line into one preview row. Exact repeats of
  // customer + item + price are MERGED (quantities summed, downpayments
  // summed reservation-level), never rejected as duplicates.
  const rows = lines.map<LiveImportPreviewRow>(({ parts }) => {
    const first = parts[0];
    const normalizedRow = first.row;
    const { identity, customerMatches, stockMatches } = first;
    const stock = first.stock;
    const proposedName = normalizedRow.facebookName;

    const customerMatch =
      !identity ||
      normalizedRow.facebookName.length > 160 ||
      proposedName.length < 2
        ? "Invalid Customer"
        : customerMatches.length >= 1
          ? "Matched"
          : "New Customer";

    // Item Code is authoritative: the trusted Stock name/category are used
    // for the saved snapshot regardless of how the sheet spelled the item
    // name. Only an unresolvable code rejects a row.
    let itemMatch: LiveImportPreviewRow["itemMatch"] = "Matched";
    if (!normalizedRow.itemCode) itemMatch = "Item Not Found";
    else if (stockMatches.length > 1) itemMatch = "Item Ambiguous";
    else if (stockMatches.length === 0) itemMatch = "New Product";

    const priceInvalid = parts.some((part) => part.priceInvalid);
    const downpaymentInvalid = parts.some((part) => part.downpaymentInvalid);
    const quantityInvalid = parts.some((part) => part.quantity === null);

    let result: LiveImportResult;
    if (customerMatch === "Invalid Customer") result = "Invalid Customer";
    else if (priceInvalid) result = "Invalid Price";
    else if (downpaymentInvalid) result = "Invalid Downpayment";
    else if (quantityInvalid) result = "Invalid Quantity";
    else if (itemMatch === "Item Ambiguous" || itemMatch === "Item Not Found") result = itemMatch;
    else if (itemMatch === "New Product") {
      const hasValidName = normalizedRow.itemName.trim().length >= 2;
      result = hasValidName ? "New Product" : "Item Not Found";
    }
    else result = customerMatch === "New Customer" ? "New Customer" : "Ready";

    const mergedQuantity = parts.reduce(
      (sum, part) => sum + (part.quantity ?? 0),
      0,
    );
    // Canonical sums use the normalized money values, so merged downpayments
    // never depend on the raw cell formatting.
    // The displayed/sold unit price mirrors the confirmation RPC exactly: the
    // parsed file price wins; a BLANK price falls back to the trusted catalog
    // price; unusable price text shows nothing instead of a wrong number.
    const unitPrice =
      first.parsedPrice !== null
        ? Number(first.parsedPrice)
        : first.stock && first.row.price === ""
          ? Number(first.effectivePriceKey)
          : null;
    const pricedParts = parts.filter(
      (part) =>
        part.row.downpayment !== "" && part.parsedDownpayment !== null,
    );
    const downpaymentTotal = pricedParts.length
      ? pricedParts.reduce(
          (sum, part) => sum + Number(part.parsedDownpayment),
          0,
        )
      : null;

    const rowCategory = stock?.category as StockCategory | undefined ?? inferStockCategory(normalizedRow.itemName);

    return {
      ...normalizedRow,
      itemName:
        parts.map((part) => part.row.itemName).find((name) => name !== "") ?? "",
      downpayment:
        parts.length === 1
          ? first.row.downpayment
          : pricedParts.reduce(
              (sum, part) => sum + Number(part.parsedDownpayment ?? 0),
              0,
            ).toFixed(2),
      catalogItemName: stock?.name ?? null,
      customerMatch,
      itemMatch,
      result,
      valid:
        result === "Ready" ||
        result === "New Customer" ||
        result === "New Product",
      existingCustomer: customerMatches.length >= 1,
      mergedQuantity,
      mergedFromRows: parts.length,
      unitPrice,
      downpaymentTotal,
      category: rowCategory,
    };
  });

  const newProductMap = new Map<string, DetectedNewProduct>();
  for (const row of rows) {
    if (row.itemMatch === "New Product" && row.itemCode) {
      const normalizedSku = normalizeItemCode(row.itemCode);
      const existing = newProductMap.get(normalizedSku);
      const name = row.itemName.trim();
      const valid = name.length >= 2 && normalizedSku.length >= 1 && normalizedSku.length <= 64;
      const initialQuantity = (existing?.initialQuantity ?? 0) + (row.mergedQuantity || 1);
      const price = row.unitPrice ?? (parseLiveMoney(row.price) ? Number(parseLiveMoney(row.price)) : 0);

      newProductMap.set(normalizedSku, {
        sku: row.itemCode.trim(),
        name: existing?.name || name,
        category: existing?.category || inferStockCategory(name),
        price: existing?.price || price,
        initialQuantity,
        valid,
        validationError: valid ? undefined : "Product name must be at least 2 characters.",
      });
    }
  }
  const detectedNewProducts = [...newProductMap.values()];

  const groups = new Map<string, LiveImportPreviewRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const validGroups = [...groups.values()].filter((group) =>
    group.every((row) => row.valid),
  );
  const existingCustomers = validGroups.filter((group) => group[0].existingCustomer).length;
  const validRows = rows.filter((row) => row.valid);

  return {
    fileName: parsed.fileName,
    fileHash: parsed.fileHash,
    rows,
    detectedNewProducts,
    summary: {
      rowsUploaded: parsed.rows.length,
      validRows: validRows.length,
      invalidRows: rows.length - validRows.length,
      existingCustomers,
      newCustomers: validGroups.length - existingCustomers,
      newProducts: detectedNewProducts.length,
      reservationsToCreate: validGroups.length,
      itemsToCreate: validRows.reduce((sum, row) => sum + row.mergedQuantity, 0),
    },
  };
}

export function toConfirmationRows(preview: LiveImportPreview): unknown[] {
  return preview.rows.map((row) => ({
    facebookName: row.facebookName,
    itemCode: row.itemCode,
    itemName: row.itemName,
    category: row.category ?? inferStockCategory(row.itemName),
    quantity: row.mergedQuantity || DEFAULT_IMPORT_QUANTITY,
    price: parseLiveMoney(row.price) ?? row.price,
    downpayment: parseLiveMoney(row.downpayment) ?? row.downpayment,
  }));
}
