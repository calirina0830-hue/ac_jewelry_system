import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/auth-forms";
import { BUSINESS } from "@/lib/constants/business";
import { getSafeRedirectPath } from "@/lib/redirects";

export const metadata: Metadata = { title: "Sign in" };

type LoginPageProps = {
  searchParams: Promise<{
    next?: string;
    message?: string;
    error?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const initialMessage =
    params.message === "password-updated"
      ? "Your password was updated. Sign in with your new password."
      : params.error === "confirmation"
        ? "That verification link is invalid or expired. Please try again."
        : params.error === "disabled"
          ? "This account has been disabled. Contact the system owner."
          : params.error === "session-expired"
            ? "Your session has expired or changed. Please sign in again."
            : undefined;

  return (
    <AuthCard
      description="Access reservations, client records, and operations from your secure workspace."
      eyebrow="Welcome back"
      footer={
        <p>Access is restricted to authorized {BUSINESS.name} personnel.</p>
      }
      title="Sign in"
    >
      <LoginForm
        initialMessage={initialMessage}
        initialMessageStatus={params.error ? "error" : "success"}
        next={getSafeRedirectPath(params.next)}
      />
      <div className="mt-5 text-right">
        <Link
          className="text-sm font-semibold text-gold-dark hover:underline"
          href="/forgot-password"
        >
          Forgot password?
        </Link>
      </div>
    </AuthCard>
  );
}
