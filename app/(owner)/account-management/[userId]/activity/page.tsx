import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ActivityView } from "@/components/account-management/activity-view";
import { accountIdSchema } from "@/lib/validation/accounts";

export const metadata: Metadata = {
  title: "Admin activity",
  robots: { index: false, follow: false },
};

type AdminActivityPageProps = {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{
    from?: string;
    to?: string;
    module?: string;
    action?: string;
    q?: string;
    page?: string;
  }>;
};

export default async function AdminActivityPage({
  params,
  searchParams,
}: AdminActivityPageProps) {
  const [{ userId }, query] = await Promise.all([params, searchParams]);
  const parsedId = accountIdSchema.safeParse(userId);

  if (!parsedId.success) {
    notFound();
  }

  return (
    <ActivityView
      lockedUserId={parsedId.data}
      searchParams={Promise.resolve(query)}
    />
  );
}
