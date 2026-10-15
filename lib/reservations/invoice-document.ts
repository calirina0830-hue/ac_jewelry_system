import {
  formatCurrency,
  formatManilaDate,
  formatManilaDateTime,
  formatOrderDateTime,
} from "@/lib/format";

// pdfmake ships without TypeScript types, so these documents are described with
// a minimal structural shape. The pure builders stay free of any pdfmake import
// so they can be unit-tested without touching the PDF renderer.
export type PdfContent = Record<string, unknown>;

export interface PdfDocumentDefinition {
  pageSize: string;
  pageMargins: [number, number, number, number];
  defaultStyle: Record<string, unknown>;
  styles: Record<string, Record<string, unknown>>;
  footer: (currentPage: number, pageCount: number) => PdfContent;
  content: PdfContent[];
}

export interface InvoiceDocumentBusiness {
  name: string;
  descriptor: string;
  systemLabel: string;
}

export interface InvoiceDocumentItem {
  description: string;
  orderedAt: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  originalQty?: number;
  releasedQty?: number;
}

export interface InvoiceReleasedSummary {
  units: number;
  subtotal: number;
  downpaymentApplied: number;
}

export interface InvoiceDocumentInput {
  business: InvoiceDocumentBusiness;
  invoiceNo: string;
  invoiceDate: string;
  statusLabel: string;
  delivered: boolean;
  customerName: string;
  facebookName: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  items: InvoiceDocumentItem[];
  totals: {
    subtotal: number;
    reservationDiscount: number;
    total: number;
    amountPaid: number;
    balance: number;
  };
  totalQuantity: number;
  released?: InvoiceReleasedSummary;
  generatedAt: string;
}

export interface ShipmentDocumentItem {
  description: string;
  orderedAt: string | null;
  quantity: number;
  subtotal?: number;
}

export interface ShipmentDocumentInput {
  business: InvoiceDocumentBusiness;
  shipmentNo: string;
  shipmentStatus: string;
  shipmentDate: string;
  shippedAt: string | null;
  reservationNo: string;
  customerName: string;
  facebookName: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  cancelReason: string | null;
  downpaymentApplied?: number;
  remainingDownpayment?: number;
  staffName?: string | null;
  items: ShipmentDocumentItem[];
  totalQuantity: number;
  generatedAt: string;
}

const GOLD = "#9a7b28";
const GOLD_SOFT = "#f6efdc";
const INK = "#1f2430";
const MUTED = "#6b7280";
const BORDER = "#d8d2c2";

function sharedStyles(): Record<string, Record<string, unknown>> {
  return {
    brandDescriptor: {
      fontSize: 8.5,
      bold: true,
      characterSpacing: 1.4,
      color: GOLD,
    },
    brandName: { fontSize: 20, bold: true, color: INK },
    brandSystem: { fontSize: 8.5, characterSpacing: 1.1, color: MUTED },
    documentTitle: {
      fontSize: 24,
      bold: true,
      color: GOLD,
      alignment: "right",
      characterSpacing: 1.6,
    },
    metaLabel: { fontSize: 8.5, color: MUTED },
    metaValue: { fontSize: 10, bold: true, color: INK },
    sectionLabel: {
      fontSize: 8.5,
      bold: true,
      color: GOLD,
      characterSpacing: 1.2,
    },
    tableHeader: { fontSize: 8.5, bold: true, color: GOLD, characterSpacing: 0.5 },
    tableCell: { fontSize: 9.5, color: INK },
    tableCellMuted: { fontSize: 9, color: MUTED },
    tableNumber: { fontSize: 9.5, color: INK, alignment: "right" },
    totalLabel: { fontSize: 9.5, color: MUTED },
    totalValue: { fontSize: 9.5, color: INK, alignment: "right" },
    grandLabel: { fontSize: 11, bold: true, color: INK },
    grandValue: { fontSize: 13, bold: true, color: INK, alignment: "right" },
    footer: { fontSize: 8, color: MUTED, alignment: "center" },
  };
}

function footerBuilder(label: string, generatedAt: string) {
  return (currentPage: number, pageCount: number): PdfContent => ({
    margin: [40, 8, 40, 0],
    columns: [
      {
        text: label + " · Generated " + formatManilaDateTime(generatedAt),
        style: "footer",
        alignment: "left",
      },
      {
        text: "Page " + currentPage + " of " + pageCount,
        style: "footer",
        alignment: "right",
      },
    ],
  });
}

function headerColumns(
  business: InvoiceDocumentBusiness,
  documentTitle: string,
): PdfContent {
  return {
    columns: [
      {
        width: "*",
        stack: [
          { text: business.descriptor, style: "brandDescriptor" },
          { text: business.name, style: "brandName", margin: [0, 2, 0, 0] },
          { text: business.systemLabel, style: "brandSystem", margin: [0, 2, 0, 0] },
        ],
      },
      {
        width: "auto",
        stack: [{ text: documentTitle, style: "documentTitle" }],
      },
    ],
  };
}

function metaRow(label: string, value: string): PdfContent {
  return {
    margin: [0, 2.5, 0, 2.5],
    columns: [
      { text: label, style: "metaLabel", width: 88 },
      { text: value, style: "metaValue", width: "*" },
    ],
  };
}

function documentTableLayout() {
  return {
    hLineColor: () => BORDER,
    vLineColor: () => BORDER,
    hLineWidth: (index: number, node: { table: { body: unknown[] } }) =>
      index === 0 || index === 1 || index === node.table.body.length ? 0.8 : 0.35,
    vLineWidth: () => 0,
    paddingLeft: () => 8,
    paddingRight: () => 8,
    paddingTop: (rowIndex: number) => (rowIndex === 0 ? 8 : 7),
    paddingBottom: (rowIndex: number) => (rowIndex === 0 ? 8 : 7),
    fillColor: (rowIndex: number) =>
      rowIndex === 0 ? GOLD_SOFT : rowIndex % 2 === 0 ? "#fbfaf7" : null,
  };
}

function partyColumns(input: {
  customerName: string;
  facebookName: string | null;
  phone: string | null;
  address: string | null;
  business: InvoiceDocumentBusiness;
}): PdfContent {
  const customerLines: PdfContent[] = [
    { text: "ORDER FOR", style: "sectionLabel" },
    { text: input.customerName, fontSize: 11, bold: true, color: INK, margin: [0, 3, 0, 0] },
  ];
  const details: [string, string | null][] = [
    ["Facebook / CS", input.facebookName],
    ["Phone", input.phone],
    ["Address", input.address],
  ];
  for (const [label, value] of details) {
    if (value) {
      customerLines.push({
        margin: [0, 2, 0, 0],
        text: [
          { text: label + ": ", fontSize: 9, bold: true, color: MUTED },
          { text: value, fontSize: 9, color: INK },
        ],
      });
    }
  }

  return {
    columns: [
      { width: "*", stack: customerLines, margin: [0, 0, 14, 0] },
      {
        width: "*",
        stack: [
          { text: "ISSUED BY", style: "sectionLabel" },
          {
            text: input.business.name,
            fontSize: 11,
            bold: true,
            color: INK,
            margin: [0, 3, 0, 0],
          },
          { text: input.business.descriptor, fontSize: 9, color: MUTED },
        ],
      },
    ],
    columnGap: 20,
    margin: [0, 2, 0, 0],
  };
}

function totalsBlock(
  totals: InvoiceDocumentInput["totals"],
  totalQuantity: number,
  released?: InvoiceReleasedSummary,
): PdfContent {
  const row = (label: string, value: string, style: string): PdfContent => ({
    columns: [
      { text: label, style: "totalLabel", width: "*" },
      { text: value, style, width: "auto" },
    ],
    margin: [0, 3, 0, 3],
  });

  const stack: PdfContent[] = [
    row(
      released ? "Subtotal (remaining items)" : "Subtotal",
      formatCurrency(totals.subtotal),
      "totalValue",
    ),
    row(
      "Reservation Discount",
      formatCurrency(totals.reservationDiscount),
      "totalValue",
    ),
    row("Total Quantity", String(totalQuantity), "totalValue"),
    {
      canvas: [{ type: "line", x1: 0, y1: 2, x2: 260, y2: 2, lineColor: BORDER }],
      margin: [0, 6, 0, 6],
    },
    row("Total", formatCurrency(totals.total), "grandValue"),
    row("Amount Paid", formatCurrency(totals.amountPaid), "totalValue"),
    row("Downpayment", formatCurrency(totals.amountPaid), "totalValue"),
  ];
  if (released) {
    stack.push(
      row(
        "Already released & billed separately",
        formatCurrency(released.subtotal),
        "totalValue",
      ),
    );
    if (released.downpaymentApplied > 0) {
      stack.push(
        row(
          "Applied downpayment to released items",
          formatCurrency(-released.downpaymentApplied),
          "totalValue",
        ),
      );
    }
  }
  stack.push(
    row(
      "Remaining Downpayment Balance",
      formatCurrency(
        Math.max(totals.amountPaid - (released?.downpaymentApplied ?? 0), 0),
      ),
      "totalValue",
    ),
  );
  stack.push({
    margin: [0, 8, 0, 0],
    table: {
      widths: ["*"],
      body: [
        [
          {
            border: [true, true, true, true],
            borderColor: GOLD,
            fillColor: GOLD_SOFT,
            margin: [12, 10, 12, 10],
            columns: [
              {
                text: "BALANCE DUE",
                bold: true,
                fontSize: 9.5,
                color: GOLD,
                width: "*",
              },
              {
                text: formatCurrency(totals.balance),
                bold: true,
                fontSize: 14,
                color: INK,
                alignment: "right",
                width: "auto",
              },
            ],
          },
        ],
      ],
    },
    layout: "noBorders",
  });

  return {
    width: 260,
    alignment: "right",
    margin: [0, 16, 0, 0],
    stack,
  };
}

export function buildInvoiceDocDefinition(
  input: InvoiceDocumentInput,
): PdfDocumentDefinition {
  const itemBody: PdfContent[][] = [
    [
      { text: "NO.", style: "tableHeader", alignment: "left" },
      { text: "ITEM", style: "tableHeader" },
      { text: "ORDER DATE", style: "tableHeader" },
      { text: "QTY", style: "tableHeader", alignment: "right" },
      { text: "UNIT PRICE", style: "tableHeader", alignment: "right" },
      { text: "AMOUNT", style: "tableHeader", alignment: "right" },
    ],
  ];

  input.items.forEach((item, index) => {
    const description: PdfContent = {
      text: item.description,
      style: "tableCell",
    };
    if (item.releasedQty && item.releasedQty > 0) {
      description.stack = [
        { text: item.description, style: "tableCell" },
        {
          text:
            item.releasedQty +
            " of " +
            (item.originalQty ?? item.quantity + item.releasedQty) +
            " released; " +
            item.quantity +
            " remaining",
          fontSize: 7.5,
          color: MUTED,
          margin: [0, 1.5, 0, 0],
        },
      ];
    }
    itemBody.push([
      { text: String(index + 1), style: "tableCellMuted" },
      description,
      {
        text: formatOrderDateTime(item.orderedAt),
        style: item.orderedAt ? "tableCell" : "tableCellMuted",
      },
      { text: String(item.quantity), style: "tableNumber" },
      { text: formatCurrency(item.unitPrice), style: "tableNumber" },
      { text: formatCurrency(item.lineTotal), style: "tableNumber" },
    ]);
  });

  const content: PdfContent[] = [
    headerColumns(input.business, "INVOICE"),
    {
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: GOLD },
      ],
      margin: [0, 10, 0, 14],
    },
    {
      columns: [
        {
          width: "*",
          stack: [
            metaRow("Invoice No", input.invoiceNo),
            metaRow("Date", formatManilaDate(input.invoiceDate)),
            metaRow("Status", input.statusLabel),
            metaRow("Delivery", input.delivered ? "Delivered" : "Not delivered"),
          ],
        },
        { width: 20, text: "" },
      ],
      margin: [0, 0, 0, 16],
    },
    partyColumns({
      customerName: input.customerName,
      facebookName: input.facebookName,
      phone: input.phone,
      address: input.address,
      business: input.business,
    }),
  ];

  if (input.notes) {
    content.push({
      margin: [0, 14, 0, 0],
      stack: [
        { text: "NOTES", style: "sectionLabel" },
        { text: input.notes, fontSize: 9.5, color: INK, margin: [0, 4, 0, 0] },
      ],
    });
  }

  content.push({
    margin: [0, 18, 0, 0],
    table: {
      headerRows: 1,
      widths: ["auto", "*", "auto", "auto", "auto", "auto"],
      body: itemBody,
    },
    layout: documentTableLayout(),
  });

  content.push(totalsBlock(input.totals, input.totalQuantity, input.released));

  return {
    pageSize: "A4",
    pageMargins: [40, 42, 40, 52],
    defaultStyle: { font: "Roboto", fontSize: 9, color: INK },
    styles: sharedStyles(),
    footer: footerBuilder(input.business.name, input.generatedAt),
    content,
  };
}

export function buildShipmentDocDefinition(
  input: ShipmentDocumentInput,
): PdfDocumentDefinition {
  const isDeliveredInvoice = input.shipmentStatus === "Delivered";
  const hasSubtotals = input.items.some((item) => item.subtotal !== undefined);
  const itemBody: PdfContent[][] = [
    [
      { text: "NO.", style: "tableHeader" },
      { text: "ITEM", style: "tableHeader" },
      { text: "ORDER DATE", style: "tableHeader" },
      { text: "QTY", style: "tableHeader", alignment: "right" },
      ...(hasSubtotals
        ? [{ text: "SUBTOTAL", style: "tableHeader", alignment: "right" }]
        : []),
    ],
  ];

  input.items.forEach((item, index) => {
    itemBody.push([
      { text: String(index + 1), style: "tableCellMuted" },
      { text: item.description, style: "tableCell" },
      {
        text: formatOrderDateTime(item.orderedAt),
        style: item.orderedAt ? "tableCell" : "tableCellMuted",
      },
      { text: String(item.quantity), style: "tableNumber" },
      ...(hasSubtotals
        ? [
            {
              text: formatCurrency(item.subtotal ?? 0),
              style: "tableNumber",
            },
          ]
        : []),
    ]);
  });

  const content: PdfContent[] = [
    headerColumns(
      input.business,
      isDeliveredInvoice ? "DELIVERY INVOICE" : "SHIPPING RECORD",
    ),
    {
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: GOLD },
      ],
      margin: [0, 10, 0, 14],
    },
    {
      columns: [
        {
          width: "*",
          stack: [
            metaRow(
              isDeliveredInvoice ? "Delivery No" : "Shipment No",
              input.shipmentNo,
            ),
            metaRow("Reservation No", input.reservationNo),
            metaRow("Status", input.shipmentStatus),
            metaRow(
              isDeliveredInvoice ? "Delivered At" : "Shipment Date",
              input.shippedAt
                ? formatManilaDateTime(input.shippedAt)
                : formatManilaDate(input.shipmentDate),
            ),
            ...(input.staffName
              ? [metaRow("Processed By", input.staffName)]
              : []),
          ],
        },
        { width: 20, text: "" },
      ],
      margin: [0, 0, 0, 16],
    },
    partyColumns({
      customerName: input.customerName,
      facebookName: input.facebookName,
      phone: input.phone,
      address: input.address,
      business: input.business,
    }),
  ];

  if (input.notes || input.cancelReason) {
    content.push({
      margin: [0, 14, 0, 0],
      stack: [
        { text: "NOTES", style: "sectionLabel" },
        {
          text: input.cancelReason
            ? "Cancellation reason: " + input.cancelReason
            : input.notes ?? "",
          fontSize: 9.5,
          color: INK,
          margin: [0, 4, 0, 0],
        },
      ],
    });
  }

  content.push({
    margin: [0, 18, 0, 0],
    table: {
      headerRows: 1,
      widths: hasSubtotals
        ? ["auto", "*", "auto", "auto", "auto"]
        : ["auto", "*", "auto", "auto"],
      body: itemBody,
    },
    layout: documentTableLayout(),
  });

  const totalRow = (
    label: string,
    value: string,
    style: string = "totalValue",
  ): PdfContent => ({
    margin: [0, 3, 0, 3],
    columns: [
      { text: label, style: "totalLabel", width: "*" },
      { text: value, style, width: "auto" },
    ],
  });

  const totalsStack: PdfContent[] = [];
  const releasedSubtotal = input.items.reduce(
    (total, item) => total + (item.subtotal ?? 0),
    0,
  );
  if (hasSubtotals) {
    totalsStack.push(
      totalRow("Subtotal", formatCurrency(releasedSubtotal)),
    );
  }
  totalsStack.push(
    totalRow("Total Quantity", String(input.totalQuantity)),
  );
  if (input.downpaymentApplied) {
    totalsStack.push(
      totalRow(
        "Downpayment Applied",
        formatCurrency(input.downpaymentApplied),
      ),
    );
  }
  if (input.remainingDownpayment !== undefined) {
    totalsStack.push(
      totalRow(
        "Remaining Downpayment Balance",
        formatCurrency(input.remainingDownpayment),
      ),
    );
  }
  if (hasSubtotals) {
    totalsStack.push({
      canvas: [{ type: "line", x1: 0, y1: 2, x2: 250, y2: 2, lineColor: BORDER }],
      margin: [0, 6, 0, 6],
    });
    totalsStack.push({
      margin: [0, 8, 0, 0],
      table: {
        widths: ["*"],
        body: [
          [
            {
              border: [true, true, true, true],
              borderColor: GOLD,
              fillColor: GOLD_SOFT,
              margin: [12, 10, 12, 10],
              columns: [
                {
                  text: isDeliveredInvoice
                    ? "BALANCE ON DELIVERED ITEMS"
                    : "BALANCE ON RELEASED GOODS",
                  bold: true,
                  fontSize: 8.5,
                  color: GOLD,
                  width: "*",
                },
                {
                  text: formatCurrency(
                    Math.max(releasedSubtotal - (input.downpaymentApplied ?? 0), 0),
                  ),
                  bold: true,
                  fontSize: 14,
                  color: INK,
                  alignment: "right",
                  width: "auto",
                },
              ],
            },
          ],
        ],
      },
      layout: "noBorders",
    });
  }

  if (totalsStack.length) {
    content.push({
      width: 250,
      alignment: "right",
      margin: [0, 16, 0, 0],
      stack: totalsStack,
    });
  }

  return {
    pageSize: "A4",
    pageMargins: [40, 42, 40, 52],
    defaultStyle: { font: "Roboto", fontSize: 9, color: INK },
    styles: sharedStyles(),
    footer: footerBuilder(input.business.name, input.generatedAt),
    content,
  };
}
