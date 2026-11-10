/**
 * Athena product UI — design mock data.
 *
 * The Doop frames show a few things the backend has no API for yet. They are
 * kept here, typed and in one place, and are ONLY rendered when
 * NEXT_PUBLIC_ATHENA_UI_MOCKS === "1" (local design review / screenshots).
 * In normal builds the UI hides these sections instead of inventing data.
 *
 * Replace each block with a real API when one exists:
 *   - paymentDetails → a Paddle customer/payment-method endpoint on the backend
 */

export const ATHENA_UI_MOCKS = process.env.NEXT_PUBLIC_ATHENA_UI_MOCKS === "1";

export type PaymentDetails = {
  card: { brand: "visa" | "mastercard" | "amex"; last4: string; expires: string };
  billingEmail: string;
  billingAddress: string;
  taxId: string | null;
};

/** Billing → Payment details (frame "App · Desktop · 09 · Billing"). */
export const MOCK_PAYMENT_DETAILS: PaymentDetails = {
  card: { brand: "visa", last4: "4242", expires: "08/28" },
  billingEmail: "billing@uzski.com",
  billingAddress: "Uzski Corp · Westlands, Nairobi · KE",
  taxId: "P051234567M",
};

export function getPaymentDetails(): PaymentDetails | null {
  return ATHENA_UI_MOCKS ? MOCK_PAYMENT_DETAILS : null;
}
