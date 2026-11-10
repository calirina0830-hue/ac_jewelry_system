// A customer's orders are billed together until every item that was waiting
// for release has gone out. Only then does the computation start over.

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

// Cancelled, deleted (archived), and hand-marked delivered orders are closed:
// they are not billed or totaled with the customer's open orders. They are
// returned only when the customer has nothing open, so their invoice can still
// be viewed from those tabs.
export function selectBillableOrders<
  T extends {
    id: string;
    status: string;
    archived_at: string | null;
    delivered_at: string | null;
  },
>(
  orders: T[],
  hasRelease: (id: string) => boolean,
  hasRemainingItems: (id: string) => boolean,
): T[] {
  const billable = orders.filter(
    (order) =>
      order.status !== "cancelled" &&
      !order.archived_at &&
      (!order.delivered_at || hasRelease(order.id)),
  );
  if (billable.some((order) => hasRemainingItems(order.id))) return billable;

  const notCancelled = orders.filter((order) => order.status !== "cancelled");
  return notCancelled.length > 0 ? notCancelled : orders;
}

// Returns the orders of the customer's current computation. An order starts a
// new one only when every earlier order had already been fully released
// before it was created.
export function selectCurrentCycle<
  T extends {
    createdAt: string;
    remainingUnits: number;
    lastReleaseAt: string | null;
  },
>(orders: T[]): T[] {
  const timeOf = (value: string) => new Date(value).getTime();
  const oldestFirst = [...orders].sort(
    (a, b) => timeOf(a.createdAt) - timeOf(b.createdAt),
  );

  let current: T[] = [];
  for (const order of oldestFirst) {
    const allReleased =
      current.length > 0 && current.every((entry) => entry.remainingUnits <= 0);
    const closedAt = Math.max(
      ...current.map((entry) =>
        entry.lastReleaseAt ? timeOf(entry.lastReleaseAt) : Number.POSITIVE_INFINITY,
      ),
    );
    if (allReleased && closedAt <= timeOf(order.createdAt)) {
      current = [];
    }
    current.push(order);
  }
  return current;
}

export type CycleOrderAmounts = {
  remainingTotal: number;
  releasedTotal: number;
  paid: number;
  appliedShipped: number;
  appliedPending: number;
};

// All payments form one downpayment for the customer. A release takes only
// the amount entered for it, and the rest stays with the remaining items.
export function computeCycleTotals(orders: CycleOrderAmounts[]) {
  const sum = (key: keyof CycleOrderAmounts) =>
    orders.reduce((total, order) => total + order[key], 0);

  const remainingTotal = roundMoney(sum("remainingTotal"));
  const releasedTotal = roundMoney(sum("releasedTotal"));
  const paid = roundMoney(sum("paid"));
  const appliedDownpayment = roundMoney(sum("appliedShipped"));
  const appliedPending = roundMoney(sum("appliedPending"));

  const totalItems = roundMoney(remainingTotal + releasedTotal);
  const remainingDownpayment = Math.min(
    Math.max(roundMoney(paid - appliedDownpayment), 0),
    remainingTotal,
  );

  return {
    totalItems,
    downpayment: paid,
    balance: Math.max(roundMoney(totalItems - paid), 0),
    released: releasedTotal,
    appliedDownpayment,
    cod: Math.max(roundMoney(releasedTotal - appliedDownpayment), 0),
    remainingTotal,
    remainingDownpayment,
    remainingBalance: roundMoney(remainingTotal - remainingDownpayment),
    unappliedDownpayment: Math.max(roundMoney(paid - appliedDownpayment), 0),
    // What a new release may still draw. Unconfirmed releases already hold
    // their share, so the same money cannot be deducted twice.
    availableDownpayment: Math.max(
      roundMoney(paid - appliedDownpayment - appliedPending),
      0,
    ),
  };
}

// What the invoice will show once the selected items are released with the
// amount typed for them.
export function computeReleasePreview({
  remainingTotal,
  unappliedDownpayment,
  availableDownpayment,
  releaseValue,
  applied,
}: {
  remainingTotal: number;
  unappliedDownpayment: number;
  availableDownpayment: number;
  releaseValue: number;
  applied: number;
}) {
  const remainingAfter = Math.max(roundMoney(remainingTotal - releaseValue), 0);
  const deductedFromBalance = Math.min(
    Math.max(roundMoney(unappliedDownpayment - applied), 0),
    remainingAfter,
  );

  return {
    releaseValue: roundMoney(releaseValue),
    applied: roundMoney(applied),
    cod: Math.max(roundMoney(releaseValue - applied), 0),
    remainingTotal: remainingAfter,
    remainingDownpayment: Math.max(roundMoney(availableDownpayment - applied), 0),
    remainingBalance: roundMoney(remainingAfter - deductedFromBalance),
  };
}

// Splits one typed amount across the selected orders, filling each order up
// to the value of its released items.
export function allocateAppliedDownpayment(
  releaseValues: number[],
  applied: number,
): number[] {
  let left = roundMoney(applied);
  return releaseValues.map((value) => {
    const share = Math.min(left, roundMoney(value));
    left = roundMoney(left - share);
    return share;
  });
}
