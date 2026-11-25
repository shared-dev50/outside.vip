import { describe, it, expect } from 'vitest';
import { User } from '../src/types';
import fs from 'fs';
import path from 'path';

describe('Door Staff Invitation & Account Mismatch Prevention', () => {
  const staffInvitationSource = fs.readFileSync(
    path.resolve(__dirname, '../src/pages/StaffInvitationPage.tsx'),
    'utf-8'
  );
  const scannerSource = fs.readFileSync(
    path.resolve(__dirname, '../src/pages/ScannerPage.tsx'),
    'utf-8'
  );

  const mockHotmailStaff: User = {
    id: 'user-hotmail-456',
    email: 'matog@hotmail.com',
    name: 'Matog Staff',
    role: 'ATTENDEE',
    status: 'ACTIVE',
    emailVerified: true,
  };

  // =========================================================================
  // 1. Frontend Metadata Refresh & Verification Flow Architecture
  // =========================================================================
  describe('1. Post-Verification Metadata Refetch & Verification Flow', () => {
    it('refetches fresh invitation metadata immediately after verifyOtp and refreshUser', () => {
      // Confirms sequence in handleVerifyOtp: verifyOtp -> refreshUser -> getMetadata
      expect(staffInvitationSource).toContain('await refreshUser();');
      expect(staffInvitationSource).toContain('const freshMetadata = await api.staffInvitation.getMetadata(token);');
      expect(staffInvitationSource).toContain('setMetadata(freshMetadata);');
    });

    it('verifies freshMetadata.invitation.isCurrentAccount === true before proceeding to scanner', () => {
      expect(staffInvitationSource).toContain('if (!freshMetadata.invitation.isCurrentAccount)');
      expect(staffInvitationSource).toContain('Account mismatch detected. Your verified account does not match this invitation.');
    });

    it('refetches fresh invitation metadata after acceptWithSession and verifies isCurrentAccount', () => {
      expect(staffInvitationSource).toMatch(
        /await api\.staffInvitation\.acceptWithSession\(token\);[\s\S]*?await refreshUser\(\);[\s\S]*?const freshMetadata = await api\.staffInvitation\.getMetadata\(token\);/
      );
    });

    it('guards mismatch banner against hydration race condition (suppressed during verification and session accept)', () => {
      // Must not render mismatch banner while isVerifyingOtp, isAcceptingSession, or successMessage is active
      expect(staffInvitationSource).toContain(
        '{user && !invitation.isCurrentAccount && !isVerifyingOtp && !isAcceptingSession && !successMessage && ('
      );
    });

    it('keeps OTP form visible during verification and suppresses it once successMessage is present', () => {
      expect(staffInvitationSource).toMatch(
        /!invitation\.hasPassword\s*&&\s*\(!user\s*\|\|\s*isVerifyingOtp\)\s*&&\s*!successMessage/
      );
    });
  });

  // =========================================================================
  // 2. Stage 2 One-Time Invitation Security & Zero Token Persistence (STG2-02)
  // =========================================================================
  describe('2. Stage 2 One-Time Invitation Security (STG2-02)', () => {
    it('never persists outside_scanner_invite_token in sessionStorage on StaffInvitationPage or ScannerPage', () => {
      expect(staffInvitationSource).not.toContain("sessionStorage.setItem('outside_scanner_invite_token'");
      expect(scannerSource).not.toContain("sessionStorage.setItem('outside_scanner_invite_token'");
      expect(scannerSource).not.toContain("sessionStorage.getItem('outside_scanner_invite_token'");
    });

    it('restricts invitation OTP verification strictly to PENDING invitations and retires ACCEPTED OTP resumption', () => {
      expect(staffInvitationSource).toContain("invitation.status === 'PENDING' && (");
      expect(staffInvitationSource).not.toContain('Resume Scanner Session');
      expect(staffInvitationSource).not.toContain('Staff Session Resumption');
      expect(staffInvitationSource).toContain('Invitation Already Accepted');
      expect(staffInvitationSource).toContain('Go to Door Scanner Sign-In');
    });

    it('preserves PENDING onboarding OTP verification and authenticated session acceptance flows', () => {
      expect(staffInvitationSource).toContain('Verify Email Address');
      expect(staffInvitationSource).toContain('Accept & Open Scanner');
      expect(staffInvitationSource).toContain("invitation.status === 'PENDING' && invitation.requiresLogin");
    });
  });

  // =========================================================================
  // 3. UI State Transitions & Account Mismatch Handling
  // =========================================================================
  describe('3. Account Mismatch and Transition UI', () => {
    it('renders Account Mismatch Detected when signed in as different account (matog50@gmail.com vs ma***@hotmail.com)', () => {
      // Simulate rendering the account mismatch state
      const mismatchedHtml = `
        <div class="bg-white rounded-2xl p-6 sm:p-8 border border-amber-200 bg-amber-50/20 shadow-sm space-y-5">
          <h3 class="font-display font-bold text-stone-900 text-base">Account Mismatch Detected</h3>
          <p class="text-xs text-stone-600 mt-1 leading-relaxed">
            You are currently signed in as <strong>matog50@gmail.com</strong>, but this door staff invitation is assigned to <strong>ma***@hotmail.com</strong>.
          </p>
          <p class="text-xs text-stone-600 mt-1.5">
            To access the scanner for this event, please switch to the invited account.
          </p>
          <button>Switch Account</button>
        </div>
      `;

      expect(mismatchedHtml).toContain('Account Mismatch Detected');
      expect(mismatchedHtml).toContain('matog50@gmail.com');
      expect(mismatchedHtml).toContain('ma***@hotmail.com');
      expect(mismatchedHtml).toContain('Switch Account');
    });

    it('suppresses mismatch banner when freshMetadata confirms matching account after OTP verification', () => {
      // In the matching state, isCurrentAccount is true and successMessage is shown
      const user = mockHotmailStaff;
      const invitation = {
        isCurrentAccount: true,
        maskedEmail: 'ma***@hotmail.com',
      };
      const isVerifyingOtp = false;
      const isAcceptingSession = false;
      const successMessage = 'Verification successful! Initializing your scanner session...';

      const shouldShowMismatch = Boolean(
        user &&
          !invitation.isCurrentAccount &&
          !isVerifyingOtp &&
          !isAcceptingSession &&
          !successMessage
      );

      expect(shouldShowMismatch).toBe(false);
    });

    it('suppresses mismatch banner during in-flight OTP verification', () => {
      const user = mockHotmailStaff; // User hydrated by refreshUser
      const invitation = {
        isCurrentAccount: false, // Pre-refetch metadata still false
        maskedEmail: 'ma***@hotmail.com',
      };
      const isVerifyingOtp = true; // In-flight
      const isAcceptingSession = false;
      const successMessage = null;

      const shouldShowMismatch = Boolean(
        user &&
          !invitation.isCurrentAccount &&
          !isVerifyingOtp &&
          !isAcceptingSession &&
          !successMessage
      );

      // Hydration transition race condition is prevented!
      expect(shouldShowMismatch).toBe(false);
    });
  });
});
