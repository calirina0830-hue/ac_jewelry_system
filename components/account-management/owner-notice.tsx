const MESSAGES: Record<string, string> = {};

const ERRORS: Record<string, string> = {
  "not-authorized": "Only the developer and owner may manage accounts.",
  "status-change-failed":
    "The account status could not be changed. Please try again.",
  "role-change-failed": "The role could not be changed. Please try again.",
  "account-not-found": "That account no longer exists.",
};

// Free-form messages/errors arrive URL-encoded from the server actions.
export function OwnerNotice({
  message,
  error,
}: {
  message?: string;
  error?: string;
}) {
  const text = error
    ? ERRORS[error] ?? decodeURIComponent(error)
    : message
      ? MESSAGES[message] ?? decodeURIComponent(message)
      : null;

  if (!text) {
    return null;
  }

  return (
    <div
      className={
        "mt-6 rounded-xl border px-4 py-3 text-sm " +
        (error
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800")
      }
      role={error ? "alert" : "status"}
    >
      {text}
    </div>
  );
}
