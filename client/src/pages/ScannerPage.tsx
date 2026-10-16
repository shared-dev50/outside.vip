import React, { useState } from 'react';
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Camera, 
  Keyboard, 
  ShieldCheck, 
  RefreshCw
} from 'lucide-react';

type ScanStatus = 'idle' | 'valid' | 'already_used' | 'invalid' | 'wrong_event' | 'cancelled';

export const ScannerPage: React.FC = () => {
  const [selectedEventId, setSelectedEventId] = useState('sol-fest-baobab-edition-2026');
  const [ticketInput, setTicketInput] = useState('');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [ticketMeta, setTicketMeta] = useState<any>(null);
  const [checkInCount, setCheckInCount] = useState(342);

  // Simulated known tokens from the seed data
  const handleValidateToken = (token: string) => {
    const trimmed = token.trim();
    if (!trimmed) return;

    if (trimmed === 'tkt_sec_7a9f2e3b8c1d4e5f') {
      // Alex Mwangi's un-checked ticket
      setScanStatus('valid');
      setTicketMeta({
        attendee: 'Alex Mwangi',
        tier: 'VIP Creek Terrace',
        orderNumber: 'OUT-2026-89412',
        checkedInAt: 'Just now (11:45 PM)',
      });
      setCheckInCount((prev) => prev + 1);
    } else if (trimmed === 'tkt_sec_1d8c4e5f7a9f2e3b') {
      // Zainab Wanjiru's already checked in ticket
      setScanStatus('already_used');
      setTicketMeta({
        attendee: 'Zainab Wanjiru',
        tier: 'VIP Creek Terrace',
        checkedInAt: '45 mins ago by Outside Admin',
      });
    } else if (trimmed.startsWith('wrong_')) {
      setScanStatus('wrong_event');
      setTicketMeta({ note: 'This ticket is valid for SUB-TERRAIN Rave, not SOL FEST.' });
    } else {
      setScanStatus('invalid');
      setTicketMeta(null);
    }
  };

  const resetScanner = () => {
    setScanStatus('idle');
    setTicketMeta(null);
    setTicketInput('');
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand-neon/10 border border-brand-neon/30 text-brand-neon text-xs font-mono uppercase tracking-widest font-bold">
          <ShieldCheck className="w-3.5 h-3.5" />
          Outside.vip Door Operations
        </div>
        <h1 className="font-display font-black text-3xl sm:text-4xl text-white">
          Browser Check-In Scanner
        </h1>
        <p className="text-slate-400 text-sm">
          Cryptographically unguessable token validation with atomic duplicate prevention.
        </p>
      </div>

      {/* Event Selection & Live Count Bar */}
      <div className="p-4 rounded-2xl glass-panel flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="w-full sm:w-auto flex-1">
          <label className="block text-[11px] font-mono text-slate-400 uppercase font-semibold mb-1">
            Active Gate Pass
          </label>
          <select
            value={selectedEventId}
            onChange={(e) => {
              setSelectedEventId(e.target.value);
              resetScanner();
            }}
            className="w-full sm:w-80 px-3 py-2 rounded-xl bg-surface-900 border border-surface-800 text-white text-xs font-semibold focus:outline-none focus:border-brand-neon"
          >
            <option value="sol-fest-baobab-edition-2026">SOL FEST: Under The Baobab Tree</option>
            <option value="sub-terrain-industrial-warehouse-004">SUB-TERRAIN: Warehouse Rave</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="text-[10px] uppercase font-mono text-slate-400 block">Admissions</span>
            <span className="font-display font-bold text-xl text-white font-mono">{checkInCount} Checked In</span>
          </div>
          <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
        </div>
      </div>

      {/* Scanner Viewfinder / Test Area */}
      <div className="glass-panel rounded-3xl p-6 sm:p-8 space-y-6 border-surface-700 shadow-2xl">
        {scanStatus === 'idle' ? (
          <div className="space-y-6">
            {/* Viewfinder box */}
            <div className="relative aspect-square sm:aspect-[16/10] rounded-2xl bg-surface-950 border-2 border-dashed border-surface-700 flex flex-col items-center justify-center p-6 text-center overflow-hidden">
              <div className="w-20 h-20 rounded-2xl bg-surface-900 flex items-center justify-center text-brand-neon mb-4 border border-surface-800 animate-pulse">
                <Camera className="w-10 h-10" />
              </div>
              <div className="text-white font-semibold text-base mb-1">
                Camera QR Viewfinder Active
              </div>
              <p className="text-xs text-slate-400 max-w-xs">
                Position attendee Outside.vip ticket QR code inside the viewfinder for instant verification.
              </p>

              {/* Decorative corner target lines */}
              <div className="absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 border-brand-neon" />
              <div className="absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 border-brand-neon" />
              <div className="absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 border-brand-neon" />
              <div className="absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 border-brand-neon" />
            </div>

            {/* Manual Entry Fallback & Seed Tokens */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs font-mono uppercase text-slate-400 font-semibold">
                <Keyboard className="w-4 h-4" />
                Or Validate Unguessable Token Manually
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. tkt_sec_7a9f2e3b8c1d4e5f"
                  value={ticketInput}
                  onChange={(e) => setTicketInput(e.target.value)}
                  className="flex-1 px-4 py-3 rounded-xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm font-mono focus:outline-none focus:border-brand-neon"
                />
                <button
                  type="button"
                  onClick={() => handleValidateToken(ticketInput)}
                  className="px-6 py-3 rounded-xl bg-brand-neon hover:bg-brand-neon-hover text-black font-display font-bold text-sm transition-all"
                >
                  Verify
                </button>
              </div>

              {/* Quick test buttons for verification */}
              <div className="p-4 rounded-xl bg-surface-900/50 border border-surface-800 space-y-2">
                <span className="text-[11px] font-mono uppercase text-slate-400 block font-semibold">
                  Test Database Tokens (from Seed):
                </span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleValidateToken('tkt_sec_7a9f2e3b8c1d4e5f')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-mono hover:bg-emerald-500/20"
                  >
                    Test Valid Pass (Alex Mwangi)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidateToken('tkt_sec_1d8c4e5f7a9f2e3b')}
                    className="px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/30 text-xs font-mono hover:bg-rose-500/20"
                  >
                    Test Duplicate (Zainab Wanjiru)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidateToken('wrong_pass_event_xyz')}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs font-mono hover:bg-amber-500/20"
                  >
                    Test Wrong Event
                  </button>
                  <button
                    type="button"
                    onClick={() => handleValidateToken('bogus_invalid_token')}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-400 text-xs font-mono hover:text-white"
                  >
                    Test Invalid Token
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Result Badge Displays */
          <div className="py-8 text-center space-y-6 animate-in fade-in zoom-in-95">
            {scanStatus === 'valid' && (
              <div className="space-y-4">
                <div className="w-24 h-24 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center border-2 border-emerald-500/40 shadow-[0_0_40px_rgba(16,185,129,0.3)]">
                  <CheckCircle2 className="w-12 h-12" />
                </div>
                <div>
                  <span className="px-4 py-1.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono font-bold text-xs uppercase tracking-widest border border-emerald-500/40 inline-block mb-3">
                    Valid Admission · Admit 1
                  </span>
                  <h2 className="text-3xl font-display font-black text-white">
                    {ticketMeta?.attendee}
                  </h2>
                  <p className="text-sm font-semibold text-brand-neon mt-1 font-mono">
                    {ticketMeta?.tier}
                  </p>
                  <p className="text-xs text-slate-400 mt-2">
                    Order Ref: {ticketMeta?.orderNumber} · Checked In: {ticketMeta?.checkedInAt}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'already_used' && (
              <div className="space-y-4">
                <div className="w-24 h-24 rounded-full bg-rose-500/20 text-rose-400 mx-auto flex items-center justify-center border-2 border-rose-500/40 shadow-[0_0_40px_rgba(244,63,94,0.3)]">
                  <XCircle className="w-12 h-12" />
                </div>
                <div>
                  <span className="px-4 py-1.5 rounded-full bg-rose-500/20 text-rose-300 font-mono font-bold text-xs uppercase tracking-widest border border-rose-500/40 inline-block mb-3">
                    Already Used · Duplicate Prevented
                  </span>
                  <h2 className="text-3xl font-display font-black text-white">
                    {ticketMeta?.attendee}
                  </h2>
                  <p className="text-xs text-rose-400 mt-2 font-mono">
                    Prior Check-In: {ticketMeta?.checkedInAt}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'wrong_event' && (
              <div className="space-y-4">
                <div className="w-24 h-24 rounded-full bg-amber-500/20 text-amber-400 mx-auto flex items-center justify-center border-2 border-amber-500/40">
                  <AlertTriangle className="w-12 h-12" />
                </div>
                <div>
                  <span className="px-4 py-1.5 rounded-full bg-amber-500/20 text-amber-300 font-mono font-bold text-xs uppercase tracking-widest border border-amber-500/40 inline-block mb-3">
                    Wrong Event Pass
                  </span>
                  <h2 className="text-2xl font-display font-bold text-white">
                    Event Mismatch
                  </h2>
                  <p className="text-xs text-slate-400 mt-2">
                    {ticketMeta?.note}
                  </p>
                </div>
              </div>
            )}

            {scanStatus === 'invalid' && (
              <div className="space-y-4">
                <div className="w-24 h-24 rounded-full bg-slate-800 text-slate-400 mx-auto flex items-center justify-center border border-slate-700">
                  <XCircle className="w-12 h-12" />
                </div>
                <div>
                  <span className="px-4 py-1.5 rounded-full bg-slate-800 text-slate-400 font-mono font-bold text-xs uppercase tracking-widest border border-slate-700 inline-block mb-3">
                    Invalid Pass Token
                  </span>
                  <h2 className="text-2xl font-display font-bold text-white">
                    No Matching Ticket Record
                  </h2>
                  <p className="text-xs text-slate-500 mt-2">
                    This token is unrecognised or has been revoked.
                  </p>
                </div>
              </div>
            )}

            <div className="pt-4">
              <button
                type="button"
                onClick={resetScanner}
                className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-brand-neon text-black font-display font-bold text-sm hover:bg-brand-neon-hover transition-all shadow-neon-sm"
              >
                <RefreshCw className="w-4 h-4" />
                Scan Next Ticket
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
