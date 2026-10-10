export const ACTIVITY_MODULES = [
  "auth",
  "customer",
  "stock",
  "reservation",
  "payment",
  "import",
  "export",
  "invoice",
  "account",
] as const;

export type ActivityModule = (typeof ACTIVITY_MODULES)[number];

export const ACTIVITY_ACTIONS = [
  "login",
  "logout",
  "customer_created",
  "customer_edited",
  "customer_archived",
  "customer_restored",
  "stock_created",
  "stock_edited",
  "stock_archived",
  "stock_restored",
  "reservation_created",
  "reservation_edited",
  "reservation_archived",
  "reservation_restored",
  "reservation_marked_paid",
  "reservation_delivered",
  "reservation_cancelled",
  "reservation_reverted_to_reserved",
  "reservations_bulk_transition",
  "paid_reservations_bulk_reverted",
  "payment_recorded",
  "live_orders_imported",
  "csv_exported",
  "invoice_viewed",
  "account_created",
  "account_activated",
  "account_disabled",
  "account_role_changed",
  "password_reset_sent",
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

const ACTION_LABELS: Record<ActivityAction, string> = {
  login: "Login",
  logout: "Logout",
  customer_created: "Customer created",
  customer_edited: "Customer edited",
  customer_archived: "Customer archived",
  customer_restored: "Customer restored",
  stock_created: "Stock created",
  stock_edited: "Stock edited",
  stock_archived: "Stock archived",
  stock_restored: "Stock restored",
  reservation_created: "Reservation created",
  reservation_edited: "Reservation edited",
  reservation_archived: "Reservation archived",
  reservation_restored: "Reservation restored",
  reservation_marked_paid: "Reservation marked Paid",
  reservation_delivered: "Reservation delivered",
  reservation_cancelled: "Reservation cancelled",
  reservation_reverted_to_reserved: "Paid reverted to Reserved",
  reservations_bulk_transition: "Reservations bulk updated",
  paid_reservations_bulk_reverted: "Paid reverted to Reserved (bulk)",
  payment_recorded: "Payment recorded",
  live_orders_imported: "Live orders imported",
  csv_exported: "CSV exported",
  invoice_viewed: "Invoice viewed / printed",
  account_created: "Account created",
  account_activated: "Account activated",
  account_disabled: "Account disabled",
  account_role_changed: "Account role changed",
  password_reset_sent: "Password reset link sent",
};

const MODULE_LABELS: Record<ActivityModule, string> = {
  auth: "Authentication",
  customer: "Customers",
  stock: "Stock",
  reservation: "Reservations",
  payment: "Payments",
  import: "Live Import",
  export: "Exports",
  invoice: "Invoices",
  account: "Account Management",
};

export function isActivityAction(value: string): value is ActivityAction {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, value);
}

export function isActivityModule(value: string): value is ActivityModule {
  return Object.prototype.hasOwnProperty.call(MODULE_LABELS, value);
}

export function getActivityActionLabel(action: string): string {
  return isActivityAction(action) ? ACTION_LABELS[action] : action;
}

export function getActivityModuleLabel(module: string): string {
  return isActivityModule(module) ? MODULE_LABELS[module] : module;
}
