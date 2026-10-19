/// <reference types="vite/client" />
import { loadStripe, type Stripe } from '@stripe/stripe-js';

let stripePromise: Promise<Stripe | null> | null = null;
let cachedKey: string | null = null;

export const getStripePromise = (publishableKey?: string): Promise<Stripe | null> => {
  const key =
    publishableKey ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY);

  if (!key || key === 'pk_test_placeholder') {
    return Promise.resolve(null);
  }

  if (!stripePromise || cachedKey !== key) {
    cachedKey = key;
    stripePromise = loadStripe(key);
  }

  return stripePromise;
};
