import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/auth-forms";
import { BUSINESS } from "@/lib/constants/business";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    redirect("/forgot-password");
  }

  return (
    <AuthCard
      description={"Choose a new password for your " + BUSINESS.name + " account."}
      eyebrow="Secure your account"
      title="Choose a new password"
    >
      <ResetPasswordForm />
    </AuthCard>
  );
}
