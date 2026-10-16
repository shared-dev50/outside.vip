import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, 
  Save, 
  Globe, 
  Image as ImageIcon, 
  Calendar, 
  MapPin, 
  Ticket, 
  Sliders, 
  Eye, 
  Plus, 
  Trash2,
  Sparkles,
  CheckCircle2
} from 'lucide-react';
import { EventCategory } from '../types';

interface DraftTicketTier {
  id: string;
  name: string;
  description: string;
  price: number; // in USD
  capacity: number;
  minPerOrder: number;
  maxPerOrder: number;
}

export const CreateEventPage: React.FC = () => {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<'details' | 'artwork' | 'venue' | 'tickets' | 'settings' | 'preview'>('details');

  // Form State
  const [title, setTitle] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('MUSIC');
  const [coverImageUrl, setCoverImageUrl] = useState('https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85');
  
  const [startDate, setStartDate] = useState('2026-11-20T20:00');
  const [endDate, setEndDate] = useState('2026-11-21T04:00');
  const [timezone, setTimezone] = useState('Africa/Nairobi');
  const [venueName, setVenueName] = useState('');
  const [venueAddress, setVenueAddress] = useState('');
  const [city, setCity] = useState('Nairobi');

  const [ageRestriction, setAgeRestriction] = useState('21+');
  const [dressCode, setDressCode] = useState('Subcultural Minimal');

  const [ticketTiers, setTicketTiers] = useState<DraftTicketTier[]>([
    {
      id: '1',
      name: 'Early Bird General Admission',
      description: 'Full experience access, early entrance before 10 PM.',
      price: 25,
      capacity: 250,
      minPerOrder: 1,
      maxPerOrder: 6,
    },
    {
      id: '2',
      name: 'VIP Terrace & Lounge',
      description: 'Expedited admission, elevated viewing deck & complimentary cocktail.',
      price: 75,
      capacity: 100,
      minPerOrder: 1,
      maxPerOrder: 4,
    },
  ]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const addTicketTier = () => {
    setTicketTiers((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(7),
        name: 'General Admission',
        description: 'Standard event entry pass.',
        price: 40,
        capacity: 300,
        minPerOrder: 1,
        maxPerOrder: 8,
      },
    ]);
  };

  const removeTicketTier = (id: string) => {
    if (ticketTiers.length <= 1) return;
    setTicketTiers((prev) => prev.filter((t) => t.id !== id));
  };

  const updateTier = (id: string, field: keyof DraftTicketTier, value: any) => {
    setTicketTiers((prev) =>
      prev.map((tier) => (tier.id === id ? { ...tier, [field]: value } : tier))
    );
  };

  const handleSave = (publish: boolean) => {
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      setStatusMessage(
        publish
          ? 'Event published successfully! Live on Outside.vip discovery.'
          : 'Event draft saved successfully.'
      );
      setTimeout(() => {
        navigate('/organizer');
      }, 1500);
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-surface-950 text-white pb-32">
      {/* Top Sticky Editor Bar */}
      <div className="sticky top-20 z-40 bg-surface-950/90 backdrop-blur-xl border-b border-surface-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/organizer"
              className="p-2.5 rounded-xl bg-surface-900 hover:bg-surface-850 text-slate-400 hover:text-white border border-surface-800 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display font-bold text-lg text-white">
                  {title || 'Untitled Experience'}
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold">
                  Draft Mode
                </span>
              </div>
              <span className="text-xs text-slate-400 font-mono">
                /organizer/events/new
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleSave(false)}
              disabled={isSubmitting}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-surface-900 hover:bg-surface-850 text-slate-200 border border-surface-700 text-sm font-semibold transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4 text-slate-400" />
              Save Draft
            </button>

            <button
              type="button"
              onClick={() => handleSave(true)}
              disabled={isSubmitting || !title || !venueName}
              className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-brand-neon hover:bg-brand-neon-hover text-black font-display font-bold text-sm transition-all shadow-neon-sm hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
            >
              <Globe className="w-4 h-4" />
              Publish Event
            </button>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className="max-w-7xl mx-auto px-4 mt-6">
          <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            {statusMessage}
          </div>
        </div>
      )}

      {/* Main Editor Container */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          {/* Section Navigation Sidebar */}
          <aside className="lg:col-span-3 space-y-2 sticky top-44 h-fit">
            <div className="text-xs font-mono uppercase tracking-widest text-slate-500 font-bold px-3 py-2">
              Editor Sections
            </div>

            {[
              { id: 'details', label: '1. Event Details', icon: Sparkles },
              { id: 'artwork', label: '2. Artwork & Identity', icon: ImageIcon },
              { id: 'venue', label: '3. Schedule & Venue', icon: Calendar },
              { id: 'tickets', label: '4. Ticket Tiers', icon: Ticket },
              { id: 'settings', label: '5. Policies & Settings', icon: Sliders },
              { id: 'preview', label: '6. Live Card Preview', icon: Eye },
            ].map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id as any)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-semibold transition-all text-left ${
                    isActive
                      ? 'bg-surface-850 text-brand-neon border border-brand-neon/30 shadow-neon-sm'
                      : 'text-slate-400 hover:text-white hover:bg-surface-900 border border-transparent'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {section.label}
                </button>
              );
            })}
          </aside>

          {/* Editor Form Area */}
          <main className="lg:col-span-9 space-y-8">
            {/* Section 1: Details */}
            {activeSection === 'details' && (
              <div className="glass-panel rounded-3xl p-8 space-y-6">
                <div>
                  <h2 className="text-xl font-display font-bold text-white">Event Details & Narrative</h2>
                  <p className="text-xs text-slate-400">Establish your experience's headline, editorial story, and category</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Event Title *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. SOL FEST: Under The Baobab Tree"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Editorial Tagline
                    </label>
                    <input
                      type="text"
                      placeholder="A short, evocative sentence describing the sound, atmosphere, or headliners"
                      value={tagline}
                      onChange={(e) => setTagline(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                        Category
                      </label>
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value as EventCategory)}
                        className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon cursor-pointer"
                      >
                        <option value="MUSIC">Live Music</option>
                        <option value="FESTIVAL">Festival</option>
                        <option value="NIGHTLIFE">Nightlife & Rave</option>
                        <option value="TECH">Tech Summit</option>
                        <option value="ARTS_CULTURE">Arts & Culture</option>
                        <option value="FOOD_DRINK">Food & Drink</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                        Destination City
                      </label>
                      <input
                        type="text"
                        placeholder="Nairobi, Kilifi, Mombasa..."
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Comprehensive Description
                    </label>
                    <textarea
                      rows={6}
                      placeholder="Lineup, stage schedule, immersive installations, curated mixology, audio architecture..."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon leading-relaxed"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Section 2: Artwork */}
            {activeSection === 'artwork' && (
              <div className="glass-panel rounded-3xl p-8 space-y-6">
                <div>
                  <h2 className="text-xl font-display font-bold text-white">Visual Identity & Artwork</h2>
                  <p className="text-xs text-slate-400">High-resolution photography or flyer artwork representing the aesthetic</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Cover Artwork URL (16:9 or 16:10 recommended)
                    </label>
                    <input
                      type="url"
                      placeholder="https://images.unsplash.com/..."
                      value={coverImageUrl}
                      onChange={(e) => setCoverImageUrl(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>

                  {coverImageUrl && (
                    <div className="rounded-2xl overflow-hidden border border-surface-800 aspect-[16/9] relative">
                      <img
                        src={coverImageUrl}
                        alt="Preview"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-3 right-3 px-3 py-1 rounded-full bg-black/70 backdrop-blur-md text-xs font-mono text-white">
                        Live Artwork Preview
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Section 3: Schedule & Venue */}
            {activeSection === 'venue' && (
              <div className="glass-panel rounded-3xl p-8 space-y-6">
                <div>
                  <h2 className="text-xl font-display font-bold text-white">Schedule & Venue</h2>
                  <p className="text-xs text-slate-400">Specify dates, timezone, and precise venue address for attendee navigators</p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                        Starts At
                      </label>
                      <input
                        type="datetime-local"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                        Ends At
                      </label>
                      <input
                        type="datetime-local"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                        Venue / Location Name *
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. The Baobab Amphitheatre"
                        value={venueName}
                        onChange={(e) => setVenueName(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                        Timezone
                      </label>
                      <input
                        type="text"
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Physical Address / Directions
                    </label>
                    <input
                      type="text"
                      placeholder="Street, landmark, or navigation coordinates"
                      value={venueAddress}
                      onChange={(e) => setVenueAddress(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Section 4: Ticket Tiers */}
            {activeSection === 'tickets' && (
              <div className="glass-panel rounded-3xl p-8 space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-display font-bold text-white">Ticket Types & Inventory</h2>
                    <p className="text-xs text-slate-400">Configure pricing, limits, capacity and tiered VIP perks</p>
                  </div>
                  <button
                    type="button"
                    onClick={addTicketTier}
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-850 hover:bg-surface-800 text-brand-neon text-xs font-mono font-bold uppercase border border-surface-700 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Tier
                  </button>
                </div>

                <div className="space-y-4">
                  {ticketTiers.map((tier, index) => (
                    <div
                      key={tier.id}
                      className="p-6 rounded-2xl bg-surface-900 border border-surface-800 space-y-4"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-brand-neon font-bold uppercase">
                          Tier #{index + 1}
                        </span>
                        {ticketTiers.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeTicketTier(tier.id)}
                            className="text-slate-500 hover:text-rose-400 transition-colors p-1"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Tier Name
                          </label>
                          <input
                            type="text"
                            value={tier.name}
                            onChange={(e) => updateTier(tier.id, 'name', e.target.value)}
                            className="w-full px-3 py-2 rounded-xl bg-surface-950 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Price (USD)
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={tier.price}
                            onChange={(e) => updateTier(tier.id, 'price', parseFloat(e.target.value) || 0)}
                            className="w-full px-3 py-2 rounded-xl bg-surface-950 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon font-mono"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Total Capacity
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={tier.capacity}
                            onChange={(e) => updateTier(tier.id, 'capacity', parseInt(e.target.value, 10) || 1)}
                            className="w-full px-3 py-2 rounded-xl bg-surface-950 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon font-mono"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Min Per Order
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={tier.minPerOrder}
                            onChange={(e) => updateTier(tier.id, 'minPerOrder', parseInt(e.target.value, 10) || 1)}
                            className="w-full px-3 py-2 rounded-xl bg-surface-950 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon font-mono"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Max Per Order
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={tier.maxPerOrder}
                            onChange={(e) => updateTier(tier.id, 'maxPerOrder', parseInt(e.target.value, 10) || 1)}
                            className="w-full px-3 py-2 rounded-xl bg-surface-950 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon font-mono"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-mono text-slate-400 mb-1">
                          Perks & Description
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Express queue, complimentary welcome drink, backstage lounge"
                          value={tier.description}
                          onChange={(e) => updateTier(tier.id, 'description', e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-surface-950 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Section 5: Settings */}
            {activeSection === 'settings' && (
              <div className="glass-panel rounded-3xl p-8 space-y-6">
                <div>
                  <h2 className="text-xl font-display font-bold text-white">Policies & Entry Settings</h2>
                  <p className="text-xs text-slate-400">Rules displayed to attendees prior to checkout</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Age Restriction
                    </label>
                    <select
                      value={ageRestriction}
                      onChange={(e) => setAgeRestriction(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white text-sm focus:outline-none focus:border-brand-neon"
                    >
                      <option value="All Ages">All Ages</option>
                      <option value="18+">18+ (Valid ID Required)</option>
                      <option value="21+">21+ (Strict ID Enforcement)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-slate-300 font-semibold mb-2">
                      Dress Code
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. All Black / High Glamour / Savannah Chic"
                      value={dressCode}
                      onChange={(e) => setDressCode(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl bg-surface-900 border border-surface-800 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-neon"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Section 6: Live Card Preview */}
            {activeSection === 'preview' && (
              <div className="glass-panel rounded-3xl p-8 space-y-6">
                <div>
                  <h2 className="text-xl font-display font-bold text-white">Live Discovery Card Preview</h2>
                  <p className="text-xs text-slate-400">This is how your event will appear on the Outside.vip public homepage</p>
                </div>

                <div className="max-w-md mx-auto">
                  <div className="glass-panel rounded-3xl overflow-hidden border border-surface-700 shadow-2xl">
                    <div className="aspect-[16/10] relative overflow-hidden">
                      <img
                        src={coverImageUrl}
                        alt="Cover"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute top-4 left-4">
                        <span className="px-3 py-1 rounded-full bg-black/60 backdrop-blur-md text-white text-[11px] font-mono uppercase font-semibold">
                          {category}
                        </span>
                      </div>
                      <div className="absolute top-4 right-4">
                        <span className="px-3 py-1 rounded-full bg-brand-neon text-black text-[11px] font-mono uppercase font-bold">
                          {city || 'Nairobi'}
                        </span>
                      </div>
                    </div>

                    <div className="p-6 space-y-4">
                      <div className="space-y-1">
                        <span className="text-xs font-mono text-brand-neon uppercase font-semibold flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" />
                          {new Date(startDate).toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        <h3 className="font-display font-bold text-xl text-white">
                          {title || 'Your Experience Title'}
                        </h3>
                        <p className="text-xs text-slate-400 line-clamp-2">
                          {tagline || description || 'Add a tagline or description to preview narrative text.'}
                        </p>
                      </div>

                      <div className="pt-4 border-t border-surface-800 flex items-center justify-between text-xs text-slate-400">
                        <div className="flex items-center gap-1 truncate">
                          <MapPin className="w-3.5 h-3.5 text-slate-500" />
                          <span>{venueName || 'Venue Location'}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] uppercase text-slate-500 block font-mono">Admission</span>
                          <span className="font-display font-bold text-sm text-white">
                            From ${ticketTiers[0]?.price || 0}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};
