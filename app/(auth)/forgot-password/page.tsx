import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      description="Enter the administrator username and we will send a secure password reset link to the configured email."
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
