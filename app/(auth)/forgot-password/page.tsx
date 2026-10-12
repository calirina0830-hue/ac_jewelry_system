import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      description="Enter your email or username and we will send a secure password reset link."
      eyebrow="Account recovery"
      footer={
        <Link className="font-bold text-gold-dark hover:underline" href="/login">
          Return to sign in
        </Link>
      }
      title="Forgot password?"
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
