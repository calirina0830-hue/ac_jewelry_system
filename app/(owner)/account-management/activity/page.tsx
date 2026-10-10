import type { Metadata } from "next";

import { ActivityView } from "@/components/account-management/activity-view";

export const metadata: Metadata = {
  title: "Admin activity",
  robots: { index: false, follow: false },
};

type AllActivityPageProps = {
  searchParams: Promise<{
    user?: string;
    from?: string;
    to?: string;
    module?: string;
    action?: string;
    q?: string;
    page?: string;
  }>;
};

export default async function AllActivityPage({
  searchParams,
}: AllActivityPageProps) {
  return <ActivityView searchParams={searchParams} />;
}
