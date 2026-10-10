import assert from "node:assert/strict";
import test from "node:test";

import {
  accountRoleChangeSchema,
  accountStatusChangeSchema,
  activityQuerySchema,
  inviteAccountSchema,
} from "../lib/validation/accounts.ts";
import {
  parseDateOnlyToExclusiveEndIso,
  parseDateOnlyToUtcIso,
} from "../lib/dates.ts";
import {
  getActivityActionLabel,
  isActivityAction,
  isActivityModule,
} from "../lib/constants/activity.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

test("invite schema accepts a valid admin invitation", () => {
  const result = inviteAccountSchema.parse({
    username: "Tonyo",
    email: "Tonyo@Example.com ",
    fullName: " Antonio Reyes ",
    role: "admin",
  });

  assert.deepEqual(result, {
    username: "Tonyo",
    email: "Tonyo@Example.com",
    fullName: "Antonio Reyes",
    role: "admin",
  });
});

test("invite schema rejects bad usernames", () => {
  for (const username of ["a", "with space", "emoji😀", "", "x".repeat(65)]) {
    assert.equal(
      inviteAccountSchema.safeParse({
        username,
        email: "a@b.co",
        fullName: "Valid Name",
        role: "admin",
      }).success,
      false,
      username,
    );
  }
});

test("invite schema rejects emails without a dot domain", () => {
  const result = inviteAccountSchema.safeParse({
    username: "lid",
    email: "not-an-email",
    fullName: "Valid Name",
    role: "staff",
  });

  assert.equal(result.success, false);
});

test("invite schema only allows operational roles", () => {
  assert.equal(
    inviteAccountSchema.safeParse({
      username: "alnor",
      email: "a@b.co",
      fullName: "Al Nor",
      role: "owner",
    }).success,
    false,
  );
  assert.equal(
    inviteAccountSchema.safeParse({
      username: "dada",
      email: "a@b.co",
      fullName: "Da Da",
      role: "developer",
    }).success,
    false,
  );
  assert.equal(
    inviteAccountSchema.safeParse({
      username: "dada",
      email: "a@b.co",
      fullName: "Da Da",
      role: "viewer",
    }).success,
    true,
  );
});

test("role change schema validates uuid and known roles", () => {
  assert.deepEqual(
    accountRoleChangeSchema.parse({ userId: UUID, newRole: "staff" }),
    { userId: UUID, newRole: "staff" },
  );
  assert.equal(
    accountRoleChangeSchema.safeParse({ userId: "nope", newRole: "admin" })
      .success,
    false,
  );
  assert.equal(
    accountRoleChangeSchema.safeParse({ userId: UUID, newRole: "superuser" })
      .success,
    false,
  );
});

test("role change schema cannot grant developer or owner", () => {
  for (const newRole of ["developer", "owner"]) {
    assert.equal(
      accountRoleChangeSchema.safeParse({ userId: UUID, newRole }).success,
      false,
      newRole,
    );
  }
});

test("status change schema parses boolean flags", () => {
  assert.deepEqual(
    accountStatusChangeSchema.parse({ userId: OTHER_UUID, isActive: "true" }),
    { userId: OTHER_UUID, isActive: true },
  );
  assert.equal(
    accountStatusChangeSchema.safeParse({
      userId: OTHER_UUID,
      isActive: "maybe",
    }).success,
    false,
  );
});

test("activity query schema applies safe defaults", () => {
  const parsed = activityQuerySchema.parse({});
  assert.equal(parsed.page, 1);
  assert.equal(parsed.user, undefined);
  assert.equal(parsed.q, undefined);
});

test("activity query schema drops invalid filters instead of failing", () => {
  const parsed = activityQuerySchema.parse({
    user: "garbage",
    from: "2026-13-45",
    module: "not-a-module",
    action: "not-an-action",
    q: "x".repeat(500),
    page: "-3",
  });

  assert.equal(parsed.user, undefined);
  assert.equal(parsed.from, undefined);
  assert.equal(parsed.module, undefined);
  assert.equal(parsed.action, undefined);
  assert.equal(parsed.page, 1);
});

test("activity query schema accepts valid filters", () => {
  const parsed = activityQuerySchema.parse({
    user: UUID,
    from: "2026-08-01",
    to: "2026-08-21",
    module: "reservation",
    action: "payment_recorded",
    q: "reserved",
    page: "2",
  });

  assert.equal(parsed.user, UUID);
  assert.equal(parsed.from, "2026-08-01");
  assert.equal(parsed.to, "2026-08-21");
  assert.equal(parsed.module, "reservation");
  assert.equal(parsed.action, "payment_recorded");
  assert.equal(parsed.q, "reserved");
  assert.equal(parsed.page, 2);
});

test("date-only helpers produce exact UTC bounds", () => {
  assert.equal(parseDateOnlyToUtcIso("2026-08-01"), "2026-08-01T00:00:00.000Z");
  assert.equal(
    parseDateOnlyToExclusiveEndIso("2026-08-01"),
    "2026-08-02T00:00:00.000Z",
  );
});

test("date-only helpers reject impossible calendar dates", () => {
  assert.equal(parseDateOnlyToUtcIso("2026-02-30"), null);
  assert.equal(parseDateOnlyToUtcIso("2026-13-01"), null);
  assert.equal(parseDateOnlyToUtcIso("20260801"), null);
  assert.equal(parseDateOnlyToExclusiveEndIso("bad"), null);
});

test("activity labels cover every canonical action and module", () => {
  assert.equal(isActivityAction("login"), true);
  assert.equal(isActivityAction("made_this_up"), false);
  assert.equal(isActivityModule("reservation"), true);
  assert.equal(isActivityModule("galaxy"), false);
  assert.equal(getActivityActionLabel("customer_created"), "Customer created");
  assert.equal(getActivityActionLabel("unknown_action"), "unknown_action");
});
